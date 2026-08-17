# npm TypeScript workspace

This workspace contains `@conghuy113/recaptcha-solver`, the AGPL-3.0 npm
library, plus transitional platform-worker packages. Consumers install only
the main package. Its entrypoint exports `solveReCaptcha()` and the associated
TypeScript types; inference and browser modules remain internal.

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

Platform-worker packages remain only as transitional workspace artifacts until
end-to-end parity is verified and the cleanup phase removes them.

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

## Migration records

- [Phase 1 — worker bridge](./PHASE_1.md)
- [Phase 2 — verified model delivery](./PHASE_2.md)
- [Phase 3 — native TypeScript migration](./PHASE_3.md)
