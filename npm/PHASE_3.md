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

CI runs TypeScript typechecking, deterministic inference/CDP/solve integration
tests, a public-export assertion, the ESM/declaration build, and a clean
tarball-install smoke test. Real ONNX parity fixtures run when the local model
assets are available. CDP tests use an in-process fake and never contact
reCAPTCHA.

Optional `smoke:cdp` and explicitly guarded `smoke:solve` scripts attach to an
authorized page in a local Chrome remote-debugging session. They are
intentionally not CI gates because CI has no user-owned browser session.

## Final status

The TypeScript migration and deterministic parity gate are complete.
`WorkerClient`, optional platform packages, native build workflows, and Python
runtime artifacts have been removed. A maintainer may run `smoke:solve` on an
authorized page before release; model and npm publication remain gated by
provenance and release checks.
