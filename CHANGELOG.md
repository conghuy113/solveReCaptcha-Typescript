# Changelog

All notable changes to this project are documented here.

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
