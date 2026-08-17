"""Direct Chrome DevTools Protocol adapter for an already-open Chrome browser.

This module intentionally does not use Selenium or ChromeDriver.  It talks to
Chrome's loopback remote-debugging HTTP/WebSocket endpoints and exposes the
small DrissionPage-like surface used by the solver's navigation helpers.
"""

from __future__ import annotations

import contextlib
import json
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


class CdpError(RuntimeError):
    """Base error for the direct CDP adapter."""


class CdpConnectionError(CdpError):
    """Raised when Chrome's HTTP or WebSocket endpoint is unavailable."""


class CdpProtocolError(CdpError):
    """Raised when Chrome reports an error for a CDP command."""

    def __init__(
        self,
        method: str,
        message: str,
        *,
        code: int | None = None,
        data: Any | None = None,
    ) -> None:
        super().__init__(f"{method}: {message}")
        self.method = method
        self.code = code
        self.data = data


def _to_css_selector(selector: str) -> str:
    """Translate the selector subset used by ``navigation.py`` to CSS."""
    if selector.startswith("tag:"):
        return selector[4:]
    if selector.startswith("t:"):
        return selector[2:]
    if selector.startswith("css:"):
        return selector[4:]
    return selector


def _remote_value(remote_object: dict[str, Any]) -> Any:
    if "value" in remote_object:
        return remote_object["value"]
    unserializable = remote_object.get("unserializableValue")
    if unserializable == "NaN":
        return float("nan")
    if unserializable == "Infinity":
        return float("inf")
    if unserializable == "-Infinity":
        return float("-inf")
    return None


class CdpTransport:
    """Synchronous, thread-safe CDP JSON-RPC transport over one WebSocket."""

    def __init__(self, websocket_url: str, *, timeout: float = 10.0) -> None:
        try:
            import websocket

            self._socket = websocket.create_connection(
                websocket_url,
                timeout=timeout,
                suppress_origin=True,
                enable_multithread=True,
            )
        except Exception as error:
            raise CdpConnectionError(
                f"Could not open Chrome DevTools WebSocket {websocket_url}: {error}"
            ) from error

        self.websocket_url = websocket_url
        self.timeout = timeout
        self._lock = threading.RLock()
        self._next_command_id = 1
        self._closed = False

    @property
    def closed(self) -> bool:
        return self._closed

    def call(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        session_id: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        if self._closed:
            raise CdpConnectionError("Chrome DevTools connection is closed")

        with self._lock:
            command_id = self._next_command_id
            self._next_command_id += 1
            payload: dict[str, Any] = {"id": command_id, "method": method}
            if params:
                payload["params"] = params
            if session_id is not None:
                payload["sessionId"] = session_id

            try:
                self._socket.settimeout(timeout or self.timeout)
                self._socket.send(json.dumps(payload, separators=(",", ":")))

                while True:
                    raw_message = self._socket.recv()
                    if not raw_message:
                        raise CdpConnectionError("Chrome closed the DevTools WebSocket connection")
                    message = json.loads(raw_message)
                    # Domain events do not have an id. They can safely be
                    # ignored because this adapter polls current DOM state.
                    if message.get("id") != command_id:
                        continue

                    error = message.get("error")
                    if isinstance(error, dict):
                        raise CdpProtocolError(
                            method,
                            str(error.get("message", "Unknown CDP error")),
                            code=error.get("code"),
                            data=error.get("data"),
                        )
                    result = message.get("result", {})
                    return result if isinstance(result, dict) else {}
            except CdpError:
                raise
            except Exception as error:
                raise CdpConnectionError(
                    f"Chrome DevTools command {method} failed: {error}"
                ) from error

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        with contextlib.suppress(Exception):
            self._socket.close()


@dataclass(frozen=True)
class _LocatorStep:
    selector: str
    index: int


@dataclass(frozen=True)
class _CdpContext:
    session_id: str
    execution_context_id: int | None = None
    offset_x: float = 0.0
    offset_y: float = 0.0


class CdpPage:
    """Low-level helpers for one Chrome page target."""

    _OBJECT_GROUP = "vision-ai-recaptcha-solver"
    _ISOLATED_WORLD = "vision-ai-recaptcha-solver"

    def __init__(
        self,
        transport: CdpTransport,
        *,
        target_id: str,
        session_id: str,
    ) -> None:
        self.transport = transport
        self.target_id = target_id
        self.session_id = session_id
        self._frame_sessions: dict[str, str] = {}
        self._closed = False
        self._enable_session(session_id)

    @property
    def root_context(self) -> _CdpContext:
        return _CdpContext(self.session_id)

    def _enable_session(self, session_id: str) -> None:
        for domain in ("Page", "Runtime", "DOM", "Network"):
            self.transport.call(f"{domain}.enable", session_id=session_id)

    @property
    def closed(self) -> bool:
        return self._closed or self.transport.closed

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        with contextlib.suppress(CdpError):
            self.transport.call("Target.detachFromTarget", {"sessionId": self.session_id})
        self.transport.close()

    def ping(self) -> None:
        self.evaluate("1")

    def _session_for_frame(self, frame_id: str) -> str:
        cached = self._frame_sessions.get(frame_id)
        if cached:
            try:
                self.transport.call("Runtime.evaluate", {"expression": "1"}, session_id=cached)
                return cached
            except CdpError:
                self._frame_sessions.pop(frame_id, None)

        targets = self.transport.call("Target.getTargets").get("targetInfos", [])
        frame_target = next(
            (
                target
                for target in targets
                if isinstance(target, dict)
                and target.get("type") == "iframe"
                and str(target.get("targetId")) == frame_id
            ),
            None,
        )
        if frame_target is None:
            return self.session_id

        attached = self.transport.call(
            "Target.attachToTarget",
            {"targetId": frame_id, "flatten": True},
        )
        child_session = attached.get("sessionId")
        if not child_session:
            raise CdpProtocolError(
                "Target.attachToTarget",
                f"Chrome returned no session for iframe target {frame_id}",
            )
        session_id = str(child_session)
        self._frame_sessions[frame_id] = session_id
        self._enable_session(session_id)
        return session_id

    def create_frame_context(self, frame_id: str) -> _CdpContext:
        session_id = self._session_for_frame(frame_id)
        try:
            result = self.transport.call(
                "Page.createIsolatedWorld",
                {
                    "frameId": frame_id,
                    "worldName": self._ISOLATED_WORLD,
                    "grantUniveralAccess": True,
                },
                session_id=session_id,
            )
        except CdpProtocolError:
            # An OOPIF session's default context is already scoped to the
            # iframe. Some Chrome versions reject createIsolatedWorld for its
            # root frame even though Runtime.evaluate is available there.
            if session_id != self.session_id:
                return _CdpContext(session_id)
            raise
        context_id = result.get("executionContextId")
        if not isinstance(context_id, int):
            raise CdpProtocolError(
                "Page.createIsolatedWorld",
                f"Chrome returned no execution context for frame {frame_id}",
            )
        return _CdpContext(session_id, context_id)

    def evaluate(
        self,
        expression: str,
        *,
        context: _CdpContext | None = None,
        return_by_value: bool = True,
    ) -> Any:
        current_context = context or self.root_context
        params: dict[str, Any] = {
            "expression": expression,
            "awaitPromise": True,
            "returnByValue": return_by_value,
            "objectGroup": self._OBJECT_GROUP,
            "userGesture": True,
        }
        if current_context.execution_context_id is not None:
            params["contextId"] = current_context.execution_context_id
        response = self.transport.call(
            "Runtime.evaluate", params, session_id=current_context.session_id
        )
        exception = response.get("exceptionDetails")
        if isinstance(exception, dict):
            description = (
                exception.get("exception", {}).get("description")
                if isinstance(exception.get("exception"), dict)
                else None
            )
            raise CdpProtocolError(
                "Runtime.evaluate",
                str(description or exception.get("text") or "JavaScript evaluation failed"),
            )

        remote_object = response.get("result", {})
        if not isinstance(remote_object, dict):
            return None
        return _remote_value(remote_object) if return_by_value else remote_object

    def call_function(
        self,
        object_id: str,
        function_declaration: str,
        *,
        context: _CdpContext,
        arguments: list[Any] | None = None,
    ) -> Any:
        params: dict[str, Any] = {
            "objectId": object_id,
            "functionDeclaration": function_declaration,
            "returnByValue": True,
            "awaitPromise": True,
            "userGesture": True,
        }
        if arguments:
            params["arguments"] = [{"value": value} for value in arguments]
        response = self.transport.call(
            "Runtime.callFunctionOn", params, session_id=context.session_id
        )
        exception = response.get("exceptionDetails")
        if isinstance(exception, dict):
            raise CdpProtocolError(
                "Runtime.callFunctionOn",
                str(exception.get("text") or "JavaScript function failed"),
            )
        result = response.get("result", {})
        return _remote_value(result) if isinstance(result, dict) else None

    def release_object(self, object_id: str, *, context: _CdpContext) -> None:
        with contextlib.suppress(CdpError):
            self.transport.call(
                "Runtime.releaseObject",
                {"objectId": object_id},
                session_id=context.session_id,
            )

    def click_object(self, object_id: str, *, context: _CdpContext) -> None:
        self.transport.call(
            "DOM.scrollIntoViewIfNeeded",
            {"objectId": object_id},
            session_id=context.session_id,
        )
        geometry = self.call_function(
            object_id,
            """function() {
                if (!(this instanceof Element) || this.getClientRects().length === 0) {
                    return null;
                }
                const rect = this.getBoundingClientRect();
                return {left: rect.left, top: rect.top, width: rect.width, height: rect.height};
            }""",
            context=context,
        )
        if not isinstance(geometry, dict):
            raise CdpProtocolError("Runtime.callFunctionOn", "Element is not visible")
        width = float(geometry.get("width", 0))
        height = float(geometry.get("height", 0))
        if width <= 0 or height <= 0:
            raise CdpProtocolError("Runtime.callFunctionOn", "Element has an empty box")
        x = context.offset_x + float(geometry.get("left", 0)) + width / 2
        y = context.offset_y + float(geometry.get("top", 0)) + height / 2

        self.transport.call(
            "Input.dispatchMouseEvent",
            {"type": "mouseMoved", "x": x, "y": y},
            session_id=self.session_id,
        )
        self.transport.call(
            "Input.dispatchMouseEvent",
            {
                "type": "mousePressed",
                "x": x,
                "y": y,
                "button": "left",
                "buttons": 1,
                "clickCount": 1,
            },
            session_id=self.session_id,
        )
        self.transport.call(
            "Input.dispatchMouseEvent",
            {
                "type": "mouseReleased",
                "x": x,
                "y": y,
                "button": "left",
                "buttons": 0,
                "clickCount": 1,
            },
            session_id=self.session_id,
        )


class CdpElementAdapter:
    """A locator that re-resolves its DOM element before every operation."""

    def __init__(
        self,
        page: CdpPage,
        context_provider: Callable[[], _CdpContext],
        locator_path: list[_LocatorStep],
    ) -> None:
        self._page = page
        self._context_provider = context_provider
        self._locator_path = locator_path

    def _resolve_expression(self) -> str:
        path = [{"selector": step.selector, "index": step.index} for step in self._locator_path]
        path_json = json.dumps(path, separators=(",", ":"))
        return f"""
            (() => {{
                const path = {path_json};
                let current = document;
                for (const step of path) {{
                    const matches = current.querySelectorAll(step.selector);
                    current = matches.item(step.index);
                    if (!current) return null;
                }}
                return current;
            }})()
        """

    def _resolve_object(self) -> tuple[str, _CdpContext] | None:
        context = self._context_provider()
        remote_object = self._page.evaluate(
            self._resolve_expression(),
            context=context,
            return_by_value=False,
        )
        if not isinstance(remote_object, dict) or remote_object.get("subtype") == "null":
            return None
        object_id = remote_object.get("objectId")
        return (str(object_id), context) if object_id else None

    def _exists(self) -> bool:
        resolved = self._resolve_object()
        if resolved is None:
            return False
        object_id, context = resolved
        self._page.release_object(object_id, context=context)
        return True

    def wait_until_present(self, timeout: float) -> bool:
        deadline = time.monotonic() + max(0.0, timeout)
        while True:
            try:
                if self._exists():
                    return True
            except CdpError:
                pass
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.1)

    def attr(self, name: str) -> str | None:
        deadline = time.monotonic() + 2.0
        while True:
            resolved = self._resolve_object()
            if resolved is not None:
                object_id, context = resolved
                try:
                    value = self._page.call_function(
                        object_id,
                        "function(name) { const value = this.getAttribute(name); "
                        "return value === null ? null : String(value); }",
                        context=context,
                        arguments=[name],
                    )
                    return str(value) if value is not None else None
                finally:
                    self._page.release_object(object_id, context=context)
            if time.monotonic() >= deadline:
                return None
            time.sleep(0.1)

    @property
    def text(self) -> str:
        deadline = time.monotonic() + 2.0
        while True:
            resolved = self._resolve_object()
            if resolved is not None:
                object_id, context = resolved
                try:
                    value = self._page.call_function(
                        object_id,
                        "function() { return String(this.innerText || this.textContent || ''); }",
                        context=context,
                    )
                    return str(value or "")
                finally:
                    self._page.release_object(object_id, context=context)
            if time.monotonic() >= deadline:
                return ""
            time.sleep(0.1)

    def click(self) -> None:
        deadline = time.monotonic() + 3.0
        last_error: Exception | None = None
        while True:
            resolved = self._resolve_object()
            if resolved is not None:
                object_id, context = resolved
                try:
                    self._page.click_object(object_id, context=context)
                    return
                except CdpError as error:
                    last_error = error
                finally:
                    self._page.release_object(object_id, context=context)
            if time.monotonic() >= deadline:
                break
            time.sleep(0.1)
        if last_error is not None:
            raise CdpError(
                "Element could not be clicked after repeated DOM updates"
            ) from last_error
        raise CdpError("Element was not found while clicking")

    def ele(self, selector: str, timeout: float = 0) -> CdpElementAdapter | None:
        child = CdpElementAdapter(
            self._page,
            self._context_provider,
            [*self._locator_path, _LocatorStep(_to_css_selector(selector), 0)],
        )
        return child if child.wait_until_present(timeout) else None

    def eles(self, selector: str) -> list[CdpElementAdapter]:
        selector_css = _to_css_selector(selector)
        resolved = self._resolve_object()
        if resolved is None:
            return []
        parent_object_id, context = resolved
        try:
            count = self._page.call_function(
                parent_object_id,
                "function(selector) { return this.querySelectorAll(selector).length; }",
                context=context,
                arguments=[selector_css],
            )
        finally:
            self._page.release_object(parent_object_id, context=context)
        return [
            CdpElementAdapter(
                self._page,
                self._context_provider,
                [*self._locator_path, _LocatorStep(selector_css, index)],
            )
            for index in range(int(count or 0))
        ]

    def frame_id(self) -> str:
        resolved = self._resolve_object()
        if resolved is None:
            raise CdpError("Iframe element is no longer present")
        object_id, context = resolved
        try:
            response = self._page.transport.call(
                "DOM.describeNode",
                {"objectId": object_id, "depth": 0},
                session_id=context.session_id,
            )
            node = response.get("node", {})
            frame_id = node.get("frameId") if isinstance(node, dict) else None
            if not frame_id:
                raise CdpProtocolError("DOM.describeNode", "Selected element is not a frame owner")
            return str(frame_id)
        finally:
            self._page.release_object(object_id, context=context)

    def frame_content_offset(self) -> tuple[float, float]:
        """Return the iframe content origin in the parent page viewport."""
        resolved = self._resolve_object()
        if resolved is None:
            raise CdpError("Iframe element is no longer present")
        object_id, context = resolved
        try:
            self._page.transport.call(
                "DOM.scrollIntoViewIfNeeded",
                {"objectId": object_id},
                session_id=context.session_id,
            )
            offset = self._page.call_function(
                object_id,
                """function() {
                    if (!(this instanceof Element) || this.getClientRects().length === 0) {
                        return null;
                    }
                    const rect = this.getBoundingClientRect();
                    const style = window.getComputedStyle(this);
                    return {
                        x: rect.left + parseFloat(style.borderLeftWidth || '0')
                            + parseFloat(style.paddingLeft || '0'),
                        y: rect.top + parseFloat(style.borderTopWidth || '0')
                            + parseFloat(style.paddingTop || '0')
                    };
                }""",
                context=context,
            )
            if not isinstance(offset, dict):
                raise CdpError("Iframe element is not visible")
            return (
                context.offset_x + float(offset.get("x", 0)),
                context.offset_y + float(offset.get("y", 0)),
            )
        finally:
            self._page.release_object(object_id, context=context)


class _CdpDocumentAdapter:
    def __init__(
        self,
        page: CdpPage,
        context_provider: Callable[[], _CdpContext],
    ) -> None:
        self._page = page
        self._context_provider = context_provider

    def _count(self, selector: str) -> int:
        expression = (
            "document.querySelectorAll(" + json.dumps(_to_css_selector(selector)) + ").length"
        )
        value = self._page.evaluate(
            expression,
            context=self._context_provider(),
        )
        return int(value or 0)

    def eles(self, selector: str) -> list[CdpElementAdapter]:
        selector_css = _to_css_selector(selector)
        return [
            CdpElementAdapter(
                self._page,
                self._context_provider,
                [_LocatorStep(selector_css, index)],
            )
            for index in range(self._count(selector_css))
        ]

    def ele(self, selector: str, timeout: float = 0) -> CdpElementAdapter | None:
        element = CdpElementAdapter(
            self._page,
            self._context_provider,
            [_LocatorStep(_to_css_selector(selector), 0)],
        )
        return element if element.wait_until_present(timeout) else None


class CdpFrameAdapter(_CdpDocumentAdapter):
    """Resolve an iframe and its isolated execution context on each operation."""

    def __init__(self, page: CdpPage, iframe: CdpElementAdapter) -> None:
        self._iframe = iframe
        super().__init__(page, self._context_id)

    def _context_id(self) -> _CdpContext:
        context = self._page.create_frame_context(self._iframe.frame_id())
        offset_x, offset_y = self._iframe.frame_content_offset()
        return _CdpContext(
            context.session_id,
            context.execution_context_id,
            offset_x,
            offset_y,
        )


class CdpBrowserAdapter(_CdpDocumentAdapter):
    """Solver-facing adapter for one selected Chrome page target."""

    def __init__(self, page: CdpPage) -> None:
        self._selected_page = page
        super().__init__(page, lambda: page.root_context)

    @classmethod
    def connect(
        cls,
        browser_websocket_url: str,
        target_id: str,
        *,
        timeout: float = 10.0,
    ) -> CdpBrowserAdapter:
        transport = CdpTransport(browser_websocket_url, timeout=timeout)
        try:
            attached = transport.call(
                "Target.attachToTarget",
                {"targetId": target_id, "flatten": True},
            )
            session_id = attached.get("sessionId")
            if not session_id:
                raise CdpProtocolError(
                    "Target.attachToTarget",
                    f"Chrome returned no session for page target {target_id}",
                )
            return cls(
                CdpPage(
                    transport,
                    target_id=target_id,
                    session_id=str(session_id),
                )
            )
        except Exception:
            transport.close()
            raise

    @property
    def closed(self) -> bool:
        return self._selected_page.closed

    @property
    def url(self) -> str:
        value = self._selected_page.evaluate("location.href")
        return str(value or "")

    @property
    def title(self) -> str:
        value = self._selected_page.evaluate("document.title")
        return str(value or "")

    def ping(self) -> None:
        self._selected_page.ping()

    def close(self) -> None:
        self._selected_page.close()

    def get_frame(self, iframe: CdpElementAdapter) -> CdpFrameAdapter:
        return CdpFrameAdapter(self._selected_page, iframe)

    def run_js(self, script: str) -> Any:
        wrapped = f"(function() {{\n{script}\n}}).call(globalThis)"
        return self._selected_page.evaluate(wrapped)

    def cookies(self, all_info: bool = True) -> list[dict[str, Any]]:
        del all_info
        response = self._selected_page.transport.call(
            "Network.getCookies",
            {"urls": [self.url]},
            session_id=self._selected_page.session_id,
        )
        cookies = response.get("cookies", [])
        return list(cookies) if isinstance(cookies, list) else []


class CdpChrome:
    """Discover and attach to page targets in an existing Chrome instance."""

    def __init__(
        self,
        port: int,
        *,
        host: str = "127.0.0.1",
        timeout: float = 5.0,
    ) -> None:
        if host not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError("CDP connections are restricted to the loopback interface")
        self.host = host
        self.port = port
        self.timeout = timeout
        self.address = f"{host}:{port}"
        self._selected_target_id: str | None = None
        self._selected_tab: CdpBrowserAdapter | None = None
        self._version = self._request_json("/json/version")
        browser_websocket_url = (
            self._version.get("webSocketDebuggerUrl") if isinstance(self._version, dict) else None
        )
        if not browser_websocket_url:
            raise CdpConnectionError("Chrome /json/version response has no browser WebSocket URL")
        self._browser_websocket_url = str(browser_websocket_url)
        self.list_tabs()

    def _request_json(self, path: str) -> Any:
        url = f"http://{self.address}{path}"
        request = urllib.request.Request(
            url,
            headers={"Accept": "application/json", "Connection": "close"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except (OSError, ValueError, urllib.error.URLError) as error:
            raise CdpConnectionError(
                f"Could not read Chrome DevTools endpoint {url}: {error}"
            ) from error

    @property
    def browser_version(self) -> str | None:
        if not isinstance(self._version, dict):
            return None
        browser = self._version.get("Browser")
        return str(browser) if browser else None

    @property
    def current_tab(self) -> CdpBrowserAdapter:
        if self._selected_tab is None:
            raise CdpConnectionError("No Chrome tab has been selected")
        return self._selected_tab

    @property
    def current_url(self) -> str:
        return self.current_tab.url

    def is_available(self) -> bool:
        self._version = self._request_json("/json/version")
        if isinstance(self._version, dict):
            websocket_url = self._version.get("webSocketDebuggerUrl")
            if websocket_url:
                self._browser_websocket_url = str(websocket_url)
        self.list_tabs()
        return True

    def list_tabs(self) -> list[dict[str, Any]]:
        targets = self._request_json("/json/list")
        if not isinstance(targets, list):
            raise CdpConnectionError("Chrome /json/list response is not an array")

        tabs: list[dict[str, Any]] = []
        for target in targets:
            if not isinstance(target, dict) or target.get("type") != "page":
                continue
            target_id = target.get("id")
            if not target_id:
                continue
            tabs.append(
                {
                    "id": str(target_id),
                    "url": str(target.get("url") or ""),
                    "title": str(target.get("title") or ""),
                    "active": str(target_id) == self._selected_target_id,
                }
            )
        return tabs

    def select_tab(self, target_url: str) -> CdpBrowserAdapter:
        tabs = self.list_tabs()
        exact = [tab for tab in tabs if tab["url"] == target_url]
        contains = [tab for tab in tabs if target_url in tab["url"]]
        matches = exact or contains
        if not matches:
            raise LookupError(f"No browser tab URL contains: {target_url}")

        target = matches[0]
        target_id = str(target["id"])
        if (
            self._selected_target_id == target_id
            and self._selected_tab is not None
            and not self._selected_tab.closed
        ):
            try:
                self._selected_tab.ping()
                return self._selected_tab
            except CdpError:
                self._selected_tab.close()

        if self._selected_tab is not None:
            self._selected_tab.close()
        self._selected_tab = CdpBrowserAdapter.connect(
            self._browser_websocket_url,
            target_id,
            timeout=self.timeout,
        )
        self._selected_target_id = target_id
        return self._selected_tab

    def close(self) -> None:
        if self._selected_tab is not None:
            self._selected_tab.close()
        self._selected_tab = None
        self._selected_target_id = None


__all__ = [
    "CdpBrowserAdapter",
    "CdpChrome",
    "CdpConnectionError",
    "CdpElementAdapter",
    "CdpError",
    "CdpFrameAdapter",
    "CdpPage",
    "CdpProtocolError",
    "CdpTransport",
]
