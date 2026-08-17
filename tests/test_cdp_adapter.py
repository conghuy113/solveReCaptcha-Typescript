"""Tests for the direct Chrome DevTools Protocol browser adapter."""

from __future__ import annotations

import json
import sys
from types import SimpleNamespace
from typing import Any

import pytest

from vision_ai_recaptcha_solver.browser.cdp_adapter import (
    CdpBrowserAdapter,
    CdpChrome,
    CdpPage,
    CdpProtocolError,
    CdpTransport,
    _to_css_selector,
)


class FakeCdpTransport:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any], str | None]] = []
        self.closed = False

    def call(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        session_id: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        del timeout
        current_params = params or {}
        self.calls.append((method, current_params, session_id))

        if method.endswith(".enable") or method in {
            "Runtime.releaseObject",
            "DOM.scrollIntoViewIfNeeded",
            "Input.dispatchMouseEvent",
            "Target.detachFromTarget",
        }:
            return {}
        if method == "Target.getTargets":
            return {
                "targetInfos": [
                    {
                        "targetId": "captcha-frame",
                        "type": "iframe",
                        "url": "https://www.google.com/recaptcha/api2/bframe",
                    }
                ]
            }
        if method == "Target.attachToTarget":
            return {"sessionId": "captcha-session"}
        if method == "Page.createIsolatedWorld":
            return {"executionContextId": 17}
        if method == "DOM.describeNode":
            return {"node": {"frameId": "captcha-frame"}}
        if method == "Network.getCookies":
            return {"cookies": [{"name": "session", "value": "cookie"}]}
        if method == "Runtime.evaluate":
            expression = str(current_params.get("expression", ""))
            if expression == "1":
                return {"result": {"type": "number", "value": 1}}
            if "location.href" in expression:
                return {
                    "result": {
                        "type": "string",
                        "value": "https://example.com/signup",
                    }
                }
            if "querySelectorAll" in expression and expression.rstrip().endswith(".length"):
                return {"result": {"type": "number", "value": 1}}
            object_id = "captcha-tile" if session_id == "captcha-session" else "iframe-owner"
            return {"result": {"type": "object", "objectId": object_id}}
        if method == "Runtime.callFunctionOn":
            function = str(current_params.get("functionDeclaration", ""))
            object_id = current_params.get("objectId")
            if "getAttribute" in function:
                return {"result": {"type": "string", "value": "reCAPTCHA challenge"}}
            if "borderLeftWidth" in function:
                return {"result": {"type": "object", "value": {"x": 100, "y": 200}}}
            if "getBoundingClientRect" in function and object_id == "captcha-tile":
                return {
                    "result": {
                        "type": "object",
                        "value": {"left": 10, "top": 20, "width": 40, "height": 20},
                    }
                }
            if "innerText" in function:
                return {"result": {"type": "string", "value": "bus"}}
            return {"result": {"type": "number", "value": 1}}
        raise AssertionError(f"Unexpected CDP command: {method}")

    def close(self) -> None:
        self.closed = True


def test_selector_translation() -> None:
    assert _to_css_selector("t:iframe") == "iframe"
    assert _to_css_selector("tag:strong") == "strong"
    assert _to_css_selector("css:td.rc-imageselect-tile") == "td.rc-imageselect-tile"
    assert _to_css_selector("#recaptcha-verify-button") == "#recaptcha-verify-button"


def test_cross_process_iframe_uses_child_session_and_root_input() -> None:
    transport = FakeCdpTransport()
    page = CdpPage(transport, target_id="page-target", session_id="page-session")
    browser = CdpBrowserAdapter(page)

    iframe = browser.ele("t:iframe")
    assert iframe is not None
    assert iframe.attr("title") == "reCAPTCHA challenge"
    frame = browser.get_frame(iframe)
    target = frame.ele(".rc-imageselect-payload", timeout=0)
    assert target is not None
    strong = target.ele("tag:strong", timeout=0)
    assert strong is not None
    assert strong.text == "bus"
    tile = frame.ele("#rc-imageselect-target td", timeout=0)
    assert tile is not None
    tile.click()

    attach_calls = [call for call in transport.calls if call[0] == "Target.attachToTarget"]
    assert attach_calls == [
        (
            "Target.attachToTarget",
            {"targetId": "captcha-frame", "flatten": True},
            None,
        )
    ]
    child_evaluations = [
        call
        for call in transport.calls
        if call[0] == "Runtime.evaluate" and call[2] == "captcha-session"
    ]
    assert child_evaluations

    mouse_calls = [call for call in transport.calls if call[0] == "Input.dispatchMouseEvent"]
    assert len(mouse_calls) == 3
    assert all(call[2] == "page-session" for call in mouse_calls)
    # iframe content origin (100, 200) + tile center (30, 30)
    assert mouse_calls[0][1]["x"] == 130
    assert mouse_calls[0][1]["y"] == 230


def test_run_js_and_cookie_commands_use_page_session() -> None:
    transport = FakeCdpTransport()
    browser = CdpBrowserAdapter(
        CdpPage(transport, target_id="page-target", session_id="page-session")
    )

    assert browser.run_js("return location.href;") == "https://example.com/signup"
    assert browser.cookies() == [{"name": "session", "value": "cookie"}]
    cookie_call = next(call for call in transport.calls if call[0] == "Network.getCookies")
    assert cookie_call[2] == "page-session"


def test_chrome_discovers_and_selects_exact_page_target(monkeypatch: Any) -> None:
    def fake_request_json(self: CdpChrome, path: str) -> Any:
        if path == "/json/version":
            return {
                "Browser": "Chrome/150.0",
                "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/browser-id",
            }
        return [
            {
                "id": "worker",
                "type": "service_worker",
                "url": "https://example.com/sw.js",
                "webSocketDebuggerUrl": "ws://worker",
            },
            {
                "id": "contains",
                "type": "page",
                "url": "https://example.com/signup?next=1",
                "title": "Contains",
                "webSocketDebuggerUrl": "ws://contains",
            },
            {
                "id": "exact",
                "type": "page",
                "url": "https://example.com/signup",
                "title": "Exact",
                "webSocketDebuggerUrl": "ws://exact",
            },
        ]

    selected: dict[str, str] = {}
    fake_tab = SimpleNamespace(closed=False, url="https://example.com/signup")
    fake_tab.ping = lambda: None
    fake_tab.close = lambda: None

    def fake_connect(
        browser_websocket_url: str,
        target_id: str,
        *,
        timeout: float,
    ) -> Any:
        selected.update(websocket=browser_websocket_url, target=target_id)
        assert timeout == 5.0
        return fake_tab

    monkeypatch.setattr(CdpChrome, "_request_json", fake_request_json)
    monkeypatch.setattr(CdpBrowserAdapter, "connect", staticmethod(fake_connect))

    chrome = CdpChrome(9222)
    result = chrome.select_tab("https://example.com/signup")

    assert result is fake_tab
    assert selected["target"] == "exact"
    assert chrome.browser_version == "Chrome/150.0"
    assert len(chrome.list_tabs()) == 2


def test_transport_sends_flat_session_id_and_ignores_events(monkeypatch: Any) -> None:
    class FakeSocket:
        def __init__(self) -> None:
            self.sent: list[dict[str, Any]] = []
            self.messages = [
                json.dumps({"method": "Runtime.executionContextCreated", "params": {}}),
                json.dumps({"id": 1, "result": {"value": 7}}),
            ]

        def settimeout(self, timeout: float) -> None:
            assert timeout == 3.0

        def send(self, payload: str) -> None:
            self.sent.append(json.loads(payload))

        def recv(self) -> str:
            return self.messages.pop(0)

        def close(self) -> None:
            return None

    socket = FakeSocket()
    fake_websocket_module = SimpleNamespace(
        create_connection=lambda *args, **kwargs: socket
    )
    monkeypatch.setitem(sys.modules, "websocket", fake_websocket_module)

    transport = CdpTransport("ws://browser", timeout=3.0)
    result = transport.call(
        "Runtime.evaluate",
        {"expression": "1"},
        session_id="flat-session",
    )

    assert result == {"value": 7}
    assert socket.sent == [
        {
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {"expression": "1"},
            "sessionId": "flat-session",
        }
    ]


def test_protocol_errors_are_typed(monkeypatch: Any) -> None:
    class ErrorSocket:
        def settimeout(self, timeout: float) -> None:
            del timeout

        def send(self, payload: str) -> None:
            del payload

        def recv(self) -> str:
            return json.dumps(
                {"id": 1, "error": {"code": -32000, "message": "No frame"}}
            )

        def close(self) -> None:
            return None

    monkeypatch.setitem(
        sys.modules,
        "websocket",
        SimpleNamespace(create_connection=lambda *args, **kwargs: ErrorSocket()),
    )
    transport = CdpTransport("ws://browser")

    with pytest.raises(CdpProtocolError, match="No frame") as error:
        transport.call("Page.createIsolatedWorld", {"frameId": "missing"})

    assert error.value.code == -32000
