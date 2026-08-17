# Phase 3 — Native TypeScript migration

## Implemented building blocks

- Classification preprocessing and ONNX inference for 3x3 grids.
- YOLO detection preprocessing, multilingual COCO target mapping, target-class
  decoding, NMS, bounding-box clipping, and 4x4 cell mapping.
- Direct Chrome DevTools Protocol transport and adapters for an already-open
  loopback Chrome instance.
- Page-target selection with exact URL priority, flat sessions, OOPIF support,
  DOM re-resolution, JavaScript execution, cookies, and trusted mouse clicks.
- Checkbox/challenge iframe navigation, target/title/image extraction, tile and
  control actions, bounded trusted image downloads, and in-memory grid image
  composition.
- Selection 3x3, dynamic 3x3, and square 4x4 handlers with multilingual target
  mapping, confidence thresholds, bounded replacement rounds, and reload
  signals.
- Direct TypeScript `solveReCaptcha()` orchestration with model initialization,
  challenge retries, verification, token/cookie/URL extraction, and guaranteed
  CDP detach.

All modules are internal. The package entrypoint continues to export only
`solveReCaptcha()` and its types.

## Verification

CI runs TypeScript typechecking, deterministic inference/CDP tests, package
tests, and the ESM/declaration build. Detection tests include real ONNX
execution when the local model asset is present. CDP tests use an in-process
fake and never contact reCAPTCHA.

An optional `smoke:cdp` script attaches to an authorized page in a local Chrome
remote-debugging session. It is intentionally not a CI gate because CI has no
user-owned browser session.

## Remaining migration work

1. Compare end-to-end behavior against the transitional worker on an
   authorized test page.
2. Remove `WorkerClient`, optional platform packages, native build workflows,
   and Python runtime artifacts only after parity tests pass.
3. Publish models and the npm package only after provenance and release gates
   are satisfied.
