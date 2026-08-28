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
- TypeScript CDP: loopback-only discovery, flat page/OOPIF sessions, DOM
  locators, JavaScript, cookies, and trusted mouse clicks.
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
