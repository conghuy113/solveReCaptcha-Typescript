# Changelog

All notable changes to this project are documented here.

## Unreleased

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
