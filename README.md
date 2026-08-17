# @conghuy113/recaptcha-solver

[![CI](https://github.com/conghuy113/solveReCaptchaByAIVision/actions/workflows/ci.yml/badge.svg)](https://github.com/conghuy113/solveReCaptchaByAIVision/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

An npm-first TypeScript library for solving reCAPTCHA challenges in an
already-open Chrome browser. The package exports one runtime function:
`solveReCaptcha()`.

Inference runs locally with ONNX models. The library does not send challenge
images to a hosted inference service, does not launch Chrome, and does not close
the user's browser.

> **Development status:** the consumer solve path and deterministic parity suite
> are implemented in TypeScript. The Python/native worker has been retired.
> Model provenance and npm release gates must still pass before publication.

## Features

- TypeScript types and an ESM entry point.
- A single, promise-based `solveReCaptcha()` API.
- Connects to an existing Chrome instance through a loopback remote-debugging
  port.
- Local ONNX inference; no hosted inference API.
- Classification support for 3x3 challenges and detection support for 4x4
  challenges.
- Pinned model versions with byte-size and SHA-256 verification.
- Atomic model downloads, retries, cache locking, and corrupt-file cleanup.
- Native TypeScript challenge handlers and solve orchestration.

## Requirements

- Node.js 20.9 or newer.
- A supported operating system and CPU:
  - Windows x64
  - Linux x64
  - macOS x64
  - macOS arm64
- Google Chrome or another compatible Chromium browser started with remote
  debugging enabled on a loopback port.
- Permission to automate and test the target website.

## Installation

```bash
npm install @conghuy113/recaptcha-solver
```

The installed package contains the TypeScript implementation only. It does not
install Python, a native worker, or per-platform companion packages.

## Start Chrome for remote debugging

Close Chrome instances that already use the selected profile, then start a
dedicated automation profile. For example:

```bash
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/recaptcha-solver-profile
```

Use the Chrome executable path and profile directory appropriate for your
operating system. Keep the debugging endpoint bound to the local machine; do
not expose it to an untrusted network.

Open the target page in that Chrome instance before calling the library.

## Quick start

```ts
import { solveReCaptcha } from "@conghuy113/recaptcha-solver";

const result = await solveReCaptcha({
  targetUrl: "https://example.com/signup",
  port: 9222,
  clickCheckbox: true,
});

console.log({
  token: result.token,
  completionReason: result.completionReason,
  attempts: result.attempts,
  timeTaken: result.timeTaken,
  currentUrl: result.currentUrl,
});
```

### Options

| Option | Type | Description |
| --- | --- | --- |
| `targetUrl` | `string` | Full URL or stable URL fragment used to locate the already-open tab. |
| `port` | `number` | Chrome remote-debugging port on `127.0.0.1`. Must be between 1 and 65535. |
| `clickCheckbox` | `boolean` | Whether to click the checkbox before handling an image challenge. |

### Result

`solveReCaptcha()` resolves to a typed object containing:

- `token`: extracted response token, or `null` when completion does not require
  one.
- `completionReason`: `token_found`, `url_changed`, or `checkbox_solved`.
- `captchaType`: challenge type reported by the solver.
- `attempts` and `timeTaken`: solve metrics.
- `cookies`: cookies from the connected browser context.
- `currentUrl`: final page URL.

The promise rejects when input validation, model preparation, browser
connection, model initialization, or challenge solving fails.

## Model delivery and cache

The package uses two ONNX assets:

- `recaptcha_classification_57k.onnx` for tile classification.
- `yolo12x.onnx` for object detection.

During `npm install`, the package downloads the immutable model set declared in
[`model-manifest.json`](npm/recaptcha-solver/model-manifest.json). Downloads are
restricted to trusted GitHub Release hosts. A model is moved into the cache only
after both its exact byte size and SHA-256 digest match the manifest.

The same verification runs before local inference begins, so installs that
skip lifecycle scripts remain recoverable on the first image challenge.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `RECAPTCHA_SOLVER_CACHE_DIR` | Overrides the package cache root. |
| `RECAPTCHA_SOLVER_MODEL_DIR` | Uses a directory that already contains both verified model files. |
| `RECAPTCHA_SOLVER_SKIP_MODEL_DOWNLOAD=1` | Skips the install-time download, useful for offline image builds. |

For offline deployment, populate `RECAPTCHA_SOLVER_MODEL_DIR` from a trusted
artifact source. Files are still checked against the package manifest before
use.

## Architecture

The consumer-facing path is:

1. The application calls the TypeScript `solveReCaptcha()` function.
2. The TypeScript CDP adapter attaches to the selected tab in the existing
   Chrome debugging session.
3. When an image challenge appears, the package verifies and loads the two
   cached model files.
4. TypeScript handlers navigate the challenge and run local ONNX inference.
5. The library verifies completion, reads the token/cookies/current URL, and
   detaches its CDP session without closing Chrome.

Classification, detection, CDP, challenge handlers, and solve orchestration are
internal modules. The package entrypoint deliberately exports only
`solveReCaptcha()` and its associated result/option types.

## Development

Install the npm workspace without running the model-download lifecycle script:

```bash
pnpm --dir npm install --frozen-lockfile --ignore-scripts
```

Run the TypeScript checks:

```bash
pnpm --dir npm --filter @conghuy113/recaptcha-solver run typecheck
pnpm --dir npm --filter @conghuy113/recaptcha-solver run test
pnpm --dir npm --filter @conghuy113/recaptcha-solver run build
```

Run the repository compliance gate after changing package metadata, release
workflows, model routing, or licensing files:

```bash
python packaging/check_compliance.py
```

### Repository layout

- `npm/recaptcha-solver/` — public TypeScript package.
- `npm/recaptcha-solver/src/models/` — manifest validation, download, cache,
  and integrity checks.
- `npm/recaptcha-solver/src/inference/` — TypeScript ONNX inference modules.
- `npm/recaptcha-solver/src/browser/cdp/` — loopback-only TypeScript CDP
  transport and browser adapters.
- `npm/recaptcha-solver/src/challenge/` — TypeScript iframe navigation,
  challenge handlers, retry policy, guarded image download, and in-memory grid
  image composition.
- `npm/recaptcha-solver/src/solver.ts` — internal TypeScript solve orchestration.
- `npm/recaptcha-solver/test/` — deterministic unit, integration, parity, and
  public-API tests.
- `packaging/` — package smoke tests, compliance checks, and model-release
  tooling. Its Python scripts are maintainer tooling, not a consumer runtime.

To smoke-test the TypeScript CDP adapter against an authorized local page,
start Chrome with remote debugging, open the page, and run:

```bash
CDP_TARGET_URL=https://example.com CDP_PORT=9222 \
  pnpm --dir npm --filter @conghuy113/recaptcha-solver run smoke:cdp
```

This live smoke test is optional and is not run by CI. CI uses deterministic
CDP fakes and never contacts reCAPTCHA.

To exercise the full solve path against a page you own or are explicitly
authorized to test, set the additional opt-in guard and run:

```bash
RECAPTCHA_SOLVER_LIVE_APPROVED=YES \
RECAPTCHA_SOLVER_TARGET_URL=https://example.com \
RECAPTCHA_SOLVER_CDP_PORT=9222 \
pnpm --dir npm --filter @conghuy113/recaptcha-solver run smoke:solve
```

This command may click the checkbox and challenge tiles. It is deliberately
excluded from CI and refuses to run without the explicit approval variable.

## Release safety

- Source code and npm packages are licensed under AGPL-3.0-only.
- Model files are excluded from Git and are distributed as hash-pinned GitHub
  Release assets.
- The model publication workflow refuses to replace an existing release.
- Model publication remains blocked until the training-data provenance review
  is completed.
- npm publication should use registry provenance and an explicit files
  allowlist.

See [model licensing](MODEL_LICENSES.md),
[dataset provenance](DATASET_PROVENANCE.md), and
[third-party notices](THIRD_PARTY_NOTICES.md). Maintainers should follow the
[release process](docs/RELEASE.md), which covers the model gate, SBOM/license
evidence, npm Trusted Publishing, and the required GitHub/npm configuration.

## Responsible use

Use this library only on systems you own or are explicitly authorized to test.
Users are responsible for complying with applicable law, website terms, and
service policies.

## License

Copyright holders license this project under the
[GNU Affero General Public License v3.0](LICENSE). Third-party components and
model assets retain the notices documented in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
