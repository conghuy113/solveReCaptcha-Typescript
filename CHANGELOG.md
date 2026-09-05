# Changelog

All notable changes to this project are documented here.

## 0.5.1 — 2026-09-05

- Accept remote `wss://` browser-level CDP endpoints with normal TLS and
  hostname verification, preserving authentication query parameters.
- Keep unencrypted `ws://` and port-discovered endpoints on loopback; use a
  30-second default connection/command timeout for direct WSS connections.
- Redact credentials and reconnect paths from WebSocket connection errors;
  retain network/TLS error codes and HTTP handshake statuses.
- Explain Browserless launch versus reconnect endpoints and preserve the
  existing Puppeteer Page workflow for continued browser ownership.
- Add real TLS transport tests and Chrome smoke coverage through a local WSS
  proxy, including page usability after solver success and failure.

- Find a visible, ready `#recaptcha-anchor` across nested frames instead of
  selecting the first iframe with a reCAPTCHA title. Prefer unchecked widgets
  and skip hidden, empty, and inactive frames.
- Keep checkbox frame identity across sibling DOM changes, and reacquire a
  replacement with the same iframe name without switching to another widget.
- Separate DOM reads from scrolling, fix frame-local click coordinates, and
  use the parent OOPIF session for its in-process child frames.
- Preserve CDP lookup errors and report connection failures directly.
- Add regression tests and a synthetic Chrome/Puppeteer checkbox smoke suite
  that runs without a real CAPTCHA or model downloads.

## 0.4.0 — 2026-09-03

- Added Puppeteer Page mode to reuse the caller's existing CDP connection and
  exact page target.
- Added structural `PuppeteerPageLike` types so Puppeteer remains optional for
  port and direct-WebSocket consumers.
- Made `page`, `browserWSEndpoint`, and `port` mutually exclusive connection
  modes; `targetUrl` is optional and assertion-only in Page mode.
- Added per-Page concurrency protection and ownership-safe cleanup that
  detaches only solver-created page/OOPIF sessions.
- Added Page-mode unit coverage, Browserless smoke coverage, and updated usage
  documentation.

## 0.3.0 — 2026-08-31

- Added `browserWSEndpoint` as an alternative to the loopback remote-debugging
  port. When supplied, it takes precedence over `port` and connects directly
  to the existing browser-level CDP WebSocket.
- Restricted direct WebSocket endpoints to `ws://` on `localhost`,
  `127.0.0.1`, or `[::1]`; remote and `wss://` endpoints are rejected.
- Reused one browser WebSocket for target discovery and page attachment, and
  disconnect without closing the existing browser or any tab.
- Added WebSocket endpoint support to the CDP, live-solve, and debug smoke
  scripts.

## 0.2.1 — 2026-08-28

- Require a newly observed token and solved checkbox state before reporting a
  widget solve as successful; partial signals are now reported as `unverified`.
- Confirm CDP click effects and retry checkbox, image-tile, and Verify actions
  once when the first interaction produces no observable state change.
- Use viewport-aware CDP coordinates and hit testing for reliable interaction
  in both headless and visible Chrome sessions.

## 0.2.0 — 2026-08-19

- Removed the `RECAPTCHA_SOLVER_CACHE_DIR` environment override. Use
  `RECAPTCHA_SOLVER_MODEL_DIR` for a custom model location; otherwise the
  package uses the platform default cache.
- Added per-call Classification and Detection confidence overrides under the
  public `confidence` option. Successful image-challenge results echo only the
  overrides explicitly supplied by the caller.

## 0.1.5 — 2026-08-18

- Added npm package keywords for improved registry discoverability.

## 0.1.4 — 2026-08-17

- Published model set `models-v1.0.1`.

## 0.1.3 — 2026-08-18

- Increased the default maximum solve attempts from 12 to 20.
- Updated release compliance validation for the current copyright-only MIT
  notices.

## 0.1.2 — 2026-08-18

- Fixed a CDP cleanup race that could close Chrome DevTools while successful
  result metadata was still being read.

## 0.1.1 — 2026-08-18

- Added a CommonJS entrypoint so
  `require("@conghuy113/recaptcha-solver")` works on Node.js 20 and newer.

## 0.1.0 — 2026-08-17

- Introduced the single-function TypeScript API `solveReCaptcha()`.
- Added native TypeScript CDP, challenge handling, and local ONNX inference.
- Added immutable two-model delivery with size and SHA-256 verification.
- Removed the transitional Python/native worker and platform packages.
- Added deterministic parity tests, package-install smoke tests, SBOM/license
  evidence generation, and OIDC-based npm release automation.
