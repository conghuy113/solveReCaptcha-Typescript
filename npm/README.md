# npm TypeScript workspace

This workspace contains the AGPL-3.0 TypeScript library
`@conghuy113/recaptcha-solver`. Its entrypoint exports `solveReCaptcha()` and
the associated TypeScript types; inference and browser modules remain internal.

## Current implementation

- Model delivery: immutable GitHub Release URLs, SHA-256/size verification,
  atomic cache writes, and install-time download.
- TypeScript classification: preprocessing, batched ONNX inference, and grid
  classification.
- TypeScript detection: YOLO letterbox preprocessing, multilingual COCO target
  mapping, output decoding, NMS, and 4x4 cell mapping.
- TypeScript CDP: shared Page connections, loopback port or direct
  local WS/remote WSS browser discovery, flat page/OOPIF sessions, DOM locators,
  JavaScript, cookies, and trusted mouse clicks.
- TypeScript challenge I/O: iframe discovery, checkbox/tile/control actions,
  challenge text and payload extraction, bounded image download, and in-memory
  dynamic-grid composition.
- TypeScript challenge handlers: selection 3x3, dynamic 3x3, square 4x4,
  confidence policy, bounded retries, and reload handling.
- TypeScript solve path: `solveReCaptcha()` connects the CDP, model, navigation,
  handler, verification, token, cookie, and cleanup stages directly.

The former Python/native worker and per-platform packages have been removed.
Consumers receive one TypeScript package with local ONNX inference.

## Commands

```bash
pnpm --dir npm install --frozen-lockfile --ignore-scripts
pnpm --dir npm --filter @conghuy113/recaptcha-solver run typecheck
pnpm --dir npm --filter @conghuy113/recaptcha-solver run test
pnpm --dir npm --filter @conghuy113/recaptcha-solver run build
```

Optional local CDP smoke test:

```bash
CDP_TARGET_URL=https://example.com CDP_PORT=9222 \
  pnpm --dir npm --filter @conghuy113/recaptcha-solver run smoke:cdp
```

For direct WebSocket mode, replace `CDP_PORT` with an existing browser-level
endpoint. Supply only one connection mode:

```bash
CDP_TARGET_URL=https://example.com \
CDP_WS_ENDPOINT=ws://localhost:3000/devtools/browser/ID \
  pnpm --dir npm --filter @conghuy113/recaptcha-solver run smoke:cdp
```

The page must already be open in an authorized Chrome instance started with
remote debugging. The smoke test only attaches and reads the selected tab; it
does not close Chrome.

The full solve smoke test is separately guarded because it can interact with a
challenge:

```bash
RECAPTCHA_SOLVER_LIVE_APPROVED=YES \
RECAPTCHA_SOLVER_TARGET_URL=https://example.com \
RECAPTCHA_SOLVER_CDP_PORT=9222 \
pnpm --dir npm --filter @conghuy113/recaptcha-solver run smoke:solve
```

Set `RECAPTCHA_SOLVER_CDP_WS_ENDPOINT` to an existing browser-level endpoint,
instead of setting the port, to run the live solve or debug harness through
direct WebSocket mode. Both local `ws://` and verified remote `wss://` are
supported. Browserless launch endpoints such as `ws://localhost:3000` or
`wss://production-sfo.browserless.io?token=...` belong in the Page-mode smoke
path below. Reusing a launch URL does not select an already-open browser.

To exercise Puppeteer Page mode against a local Browserless instance, install
`puppeteer-core` in the development workspace and run:

```bash
RECAPTCHA_SOLVER_LIVE_APPROVED=YES \
RECAPTCHA_SOLVER_TARGET_URL=https://example.com \
RECAPTCHA_SOLVER_CDP_WS_ENDPOINT=ws://localhost:3000 \
pnpm --dir npm --filter @conghuy113/recaptcha-solver run smoke:page
```

This smoke path passes the newly created Page directly to `solveReCaptcha()`;
it never reads Browserless `/sessions` or opens a second solver WebSocket.

For a reproducible local checkbox regression check, build the package, install
`puppeteer-core` in the development workspace, and run:

```bash
CHROME_EXECUTABLE_PATH=/path/to/chrome \
pnpm --dir npm --filter @conghuy113/recaptcha-solver run smoke:checkbox
```

This suite launches headless Chrome and reconnects with Puppeteer, then tests
the built public API against 13 synthetic loopback fixtures. It covers hidden
and empty widgets, nested same-process/OOPIF frames, delayed rendering, DOM
reordering, and iframe replacement. It checks trusted click events, token and
widget verification, and continued caller ownership of the Page. No real
CAPTCHA, cloud endpoint, credentials, or downloaded inference models are used.
`PUPPETEER_CORE_MODULE` can optionally point to a caller-installed Puppeteer
module URL. Browserless cloud compatibility must be verified separately.

Run the same fixture suite through verified WSS with:

```bash
CHROME_EXECUTABLE_PATH=/path/to/chrome \
pnpm --dir npm --filter @conghuy113/recaptcha-solver run smoke:wss
```

This adds a local TLS proxy and trusts its test certificate only in a child
Node process. It checks 13 Page-mode cases, four direct-WSS cases, and
missing-tab cleanup while Puppeteer retains its connection. Page mode must
open no extra socket; direct mode must open exactly one per solve. The normal
test suite also checks untrusted certificates, hostname mismatches, token
encoding, authentication failure, redirects, and handshake timeout.

For authorized local diagnosis, the test-only debug harness captures before
and after screenshots plus a sanitized result under `Debug/<timestamp>/`:

```bash
RECAPTCHA_SOLVER_DEBUG_APPROVED=YES \
RECAPTCHA_SOLVER_TARGET_URL=https://example.com \
RECAPTCHA_SOLVER_CDP_PORT=9222 \
pnpm --dir npm/recaptcha-solver exec tsx scripts/solve-debug.ts
```

`Debug/` is ignored by Git and is not included in the published package. The
harness stores only token hashes and lengths, never raw response tokens.
The debug harness makes separate connections for before/solve/after. Use it
only with an endpoint that remains available across those connections; it
does not manage Browserless reconnect keepalive. Use the application's Page
workflow when that application must retain ownership of the cloud browser.

## Next npm release

The package manifest is set to `0.5.1`. Publish from the matching `v0.5.1`
GitHub Release after committing and reviewing the source. The publish workflow
checks that the release tag matches the manifest; it does not increment the
version automatically. A read-only preflight is:

```bash
node packaging/check_release_candidate.mjs v0.5.1 --manifest-only
node packaging/check_registry_version.mjs
```
