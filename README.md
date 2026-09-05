# recaptcha-solver

[![CI](https://github.com/conghuy113/solveReCaptcha-Typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/conghuy113/solveReCaptcha-Typescript/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

An npm-first TypeScript library for solving reCAPTCHA challenges in an
already-open Chrome browser. The package exports one runtime function:
`solveReCaptcha()`.

Inference runs locally with ONNX models. The library does not send challenge
images to a hosted inference service, does not launch Chrome, and does not close
the user's browser.

## Features

- TypeScript types and an ESM entry point.
- A single, promise-based `solveReCaptcha()` API.
- Reuses an existing Page, or connects through a loopback remote-debugging
  port, local `ws://`, or remote `wss://` browser-level CDP endpoint.
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
- A Puppeteer Page backed by CDP, or Google Chrome/compatible Chromium exposed
  through a loopback remote-debugging port or reconnectable browser-level CDP
  WebSocket.
- Permission to automate and test the target website.

## Installation

```bash
npm install @conghuy113/recaptcha-solver
```

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

The same CDP solve path supports Chrome with or without a visible window. In
headless mode, use a non-zero viewport. Every checkbox, tile, and Verify action
is confirmed by an observable widget state change and retried at most once.

## Quick start with Puppeteer and Browserless

When the application already controls Browserless through Puppeteer, pass the
exact Page to the solver. This reuses Puppeteer's CDP connection and does not
depend on Browserless `/sessions`:

```ts
import puppeteer from "puppeteer-core";
import { solveReCaptcha } from "@conghuy113/recaptcha-solver";

const token = process.env.BROWSERLESS_TOKEN;
if (!token) throw new Error("BROWSERLESS_TOKEN is required.");
const browser = await puppeteer.connect({
  browserWSEndpoint: `wss://production-sfo.browserless.io?token=${encodeURIComponent(token)}`,
});
const page = await browser.newPage();
await page.goto("https://example.com/signup");

const result = await solveReCaptcha({
  page,
  clickCheckbox: true,
});

console.log(await page.title()); // Continue application work on this same page.
// Close the browser only when all application work is finished.
```

The solver only detaches the CDP sessions it creates. It does not close or
disconnect the supplied Page or Browser. `targetUrl` is optional in Page mode
and, when supplied, is only an assertion; it is never used to discover another
tab. Concurrent calls using the same Page are rejected.

Checkbox discovery skips hidden and empty widgets, includes nested frames,
and prefers the first visible unchecked `#recaptcha-anchor`. The solver keeps
the selected widget's identity while checking completion. Keep the Page
stable during a solve. When frame access fails, inspect the error's `cause`
for the underlying CDP failure.

## Port mode

```ts
import { solveReCaptcha } from "@conghuy113/recaptcha-solver";

const result = await solveReCaptcha({
  targetUrl: "https://example.com/signup",
  port: 9222,
  clickCheckbox: true,
});

console.log({
  status: result.status,
  verification: result.verification,
  token: result.token,
  completionReason: result.completionReason,
  attempts: result.attempts,
  timeTaken: result.timeTaken,
  currentUrl: result.currentUrl,
});
```

## Direct WebSocket mode

To connect directly to a reconnectable browser-level CDP WebSocket, supply an
endpoint that identifies the existing browser. The tab must already exist in
that same browser:

```ts
const result = await solveReCaptcha({
  targetUrl: "https://example.com/signup",
  browserWSEndpoint: "ws://localhost:3000/devtools/browser/<id>",
  clickCheckbox: true,
});
```

Direct mode accepts `wss://` browser CDP endpoints, including remote hosts,
with certificate and hostname verification enabled. Query parameters such as
`token` are preserved; credentials and session paths are redacted from
connection errors. Redirects are not followed. The default direct-WSS
connection/command timeout is 30 seconds.

Unencrypted `ws://` remains limited to `localhost`, `127.0.0.1`, and `[::1]`.
Port discovery remains limited to local `ws://` endpoints. Exactly one of
`page`, `browserWSEndpoint`, or `port` must be supplied; ambiguous combinations
fail before any browser connection is made.

### Browserless cloud: use the existing session

`wss://production-sfo.browserless.io?token=...` is a launch endpoint. Passing
that same string to Puppeteer and then to the solver can allocate two separate
browsers. `targetUrl` selects an already-open tab; it never opens or navigates
one. Use the Page example above when the application already owns the page
and needs to keep working with it after solving.

Direct WSS mode instead requires a browser-specific reconnect endpoint, with
its token included. Browserless documents how to obtain one using
[`Browserless.reconnect`](https://docs.browserless.io/baas/session-management/standard-sessions).
The caller must manage reconnect lifetime and any subsequent reconnection.
The solver closes its own socket and detaches its sessions; it does not send
`Browser.close` or extend the provider's session lifetime. A launch URL alone
cannot identify another Puppeteer connection's browser. Only browser-level
CDP endpoints are supported, not Playwright-native endpoints.

CommonJS projects can load the same API with `require()`:

```js
const { solveReCaptcha } = require("@conghuy113/recaptcha-solver");
```

### Options

| Option              | Type                | Description                                                            |
| ------------------- | ------------------- | ---------------------------------------------------------------------- |
| `page`              | `PuppeteerPageLike` | Existing Puppeteer Page; reuses its CDP connection and exact target.   |
| `targetUrl`         | `string`            | Required in port/WebSocket modes. Optional URL assertion in Page mode. |
| `port`              | `number`            | Loopback Chrome remote-debugging port.                                 |
| `browserWSEndpoint` | `string`            | Existing browser CDP endpoint: local `ws://` or verified `wss://`.     |
| `clickCheckbox`     | `boolean`           | Whether to click the checkbox before handling an image challenge.      |
| `confidence`        | `object`            | Optional per-call Classification and Detection confidence overrides.   |

`page`, `browserWSEndpoint`, and `port` are mutually exclusive connection
modes. The structural `PuppeteerPageLike` type keeps Puppeteer optional for
consumers that use port or direct WebSocket mode and works with Pages from both
`puppeteer` and `puppeteer-core`.

The optional `confidence` object accepts only:

- `classificationMinConfidence` (default: `0.2`): minimum target-class score
  required for each of the top three cells in a 3x3 Classification challenge.
- `detectionConfidence` (default: `0.6`): minimum target-class score required
  to retain a bounding box in a 4x4 Detection challenge before NMS.

Each supplied value must be a finite number between `0` and `1`. Unknown
properties and invalid values fail fast with `TypeError` before Chrome is
connected. Example custom thresholds:

```ts
const result = await solveReCaptcha({
  targetUrl: "https://example.com/signup",
  port: 9222,
  clickCheckbox: true,
  confidence: {
    classificationMinConfidence: 0.35,
    detectionConfidence: 0.7,
  },
});
```

The configuration is scoped to that call. Increasing a threshold is more
selective but may reload or miss more challenges; decreasing it accepts more
predictions but can increase incorrect clicks. Scores from the two models are
not directly comparable.

### Result

`solveReCaptcha()` resolves to a typed object containing:

- `status`: `success` when completion is confirmed, otherwise `unverified`.
- `verification`: the evidence used for the status. A token alone is reported
  as `token_observed`; it is not treated as a successful solve.
- `token`: extracted response token, or `null` when completion does not require
  one.
- `completionReason`: `token_found`, `url_changed`, or `checkbox_solved`.
- `captchaType`: challenge type reported by the solver.
- `attempts` and `timeTaken`: solve metrics.
- `cookies`: cookies from the connected browser context.
- `currentUrl`: final page URL.
- `confidence`: present only after an image challenge when the caller supplied
  at least one confidence override. It contains only the fields supplied by
  the caller; internal fallback values are not returned.

The solver snapshots all response tokens before the first interaction. With
`clickCheckbox: true`, success requires both a newly observed token and the
checkbox solved state. With `clickCheckbox: false`, navigation away from the
pre-Verify URL is also a confirmed success. A new token without a solved widget
resolves as `unverified` so callers can decide whether to continue or retry.

The promise rejects when input validation, model preparation, browser
connection, model initialization, or challenge solving fails.

### Environment variables

| Variable                                 | Purpose                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `RECAPTCHA_SOLVER_MODEL_DIR`             | Selects the exact directory where both models are verified or downloaded. |
| `RECAPTCHA_SOLVER_SKIP_MODEL_DOWNLOAD=1` | Skips the install-time download, useful for offline image builds.         |

For offline deployment, populate `RECAPTCHA_SOLVER_MODEL_DIR` from a trusted
artifact source. Files are still checked against the package manifest before
use.

#### Configure a custom model directory before installation

`RECAPTCHA_SOLVER_MODEL_DIR` is the exact directory in which the package looks
for `recaptcha_classification_57k.onnx` and `yolo12x.onnx`. Existing files are
verified against `model-manifest.json`; missing or invalid files are downloaded
again during `npm install`. Use an absolute path and expose the same value to
both the `npm install` process and the application process. Otherwise the
application may look in a different directory and download the models again.

The directory must be writable during installation and large enough for both
models. The package creates it when necessary.

##### Load the value from `.env`

Create a `.env` file in the consumer project. For example, on Windows:

```dotenv
RECAPTCHA_SOLVER_MODEL_DIR=D:\recaptcha-solver-models
```

Or on Linux and macOS:

```dotenv
RECAPTCHA_SOLVER_MODEL_DIR=/opt/recaptcha-solver-models
```

npm does not automatically load `.env` for dependency lifecycle scripts. Load
the file into the `npm install` process explicitly:

```bash
npx --yes dotenv-cli -e .env -- npm install @conghuy113/recaptcha-solver
```

Load the same file when starting the application. Node.js 20.9 and newer can do
this without an application dependency:

```bash
node --env-file=.env dist/app.js
```

Alternatively, an application that already depends on `dotenv` can import
`dotenv/config` before calling `solveReCaptcha()`. Keep a machine-independent
`.env.example` in source control and normally exclude the real `.env` file.

##### PowerShell

To configure the current PowerShell session, create an absolute directory and
set the process environment before running both installation and the app:

```powershell
$ModelDirectory = [IO.Path]::GetFullPath((Join-Path $PWD "recaptcha-solver-models"))
New-Item -ItemType Directory -Force -Path $ModelDirectory | Out-Null
$env:RECAPTCHA_SOLVER_MODEL_DIR = $ModelDirectory

npm install @conghuy113/recaptcha-solver
node .\dist\app.js
```

The value disappears when that PowerShell session closes. To save a fixed path
for the current Windows user:

```powershell
[Environment]::SetEnvironmentVariable(
  "RECAPTCHA_SOLVER_MODEL_DIR",
  "D:\recaptcha-solver-models",
  "User"
)
```

Open a new terminal after setting a persistent user variable.

##### Docker

Set the variable before `npm ci` so the model files are downloaded into the
chosen image directory, and preserve the same value at runtime:

```dockerfile
FROM node:20-bookworm-slim

WORKDIR /app

ARG RECAPTCHA_SOLVER_MODEL_DIR=/opt/recaptcha-solver-models
ENV RECAPTCHA_SOLVER_MODEL_DIR=${RECAPTCHA_SOLVER_MODEL_DIR}

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
CMD ["node", "dist/app.js"]
```

Do not mount an empty runtime volume over this directory: the mount would hide
the model files baked into the image. If a persistent model volume is required,
populate and verify that volume before starting the application.

##### Docker Compose

Docker Compose reads its project `.env` for interpolation, but the value must
still be passed separately to the image build and the running container.

Project `.env`:

```dotenv
RECAPTCHA_SOLVER_MODEL_DIR=/opt/recaptcha-solver-models
```

`compose.yaml`:

```yaml
services:
  app:
    build:
      context: .
      args:
        RECAPTCHA_SOLVER_MODEL_DIR: ${RECAPTCHA_SOLVER_MODEL_DIR}
    environment:
      RECAPTCHA_SOLVER_MODEL_DIR: ${RECAPTCHA_SOLVER_MODEL_DIR}
```

The Dockerfile must declare the matching `ARG` and `ENV` shown above. A Compose
`environment` entry alone applies only after the image has been built, so it
cannot change the model destination used by `npm ci` during `docker build`.

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

## Release safety

- Source code and npm packages are licensed under AGPL-3.0-only.
- Model files are excluded from Git and are distributed as hash-pinned GitHub
  Release assets.
- The model publication workflow refuses to replace an existing release.
- Model publication remains blocked until the training-data provenance review
  is completed.
- npm publication should use registry provenance and an explicit files
  allowlist.

## License

Copyright holders license this project under the
[GNU Affero General Public License v3.0](LICENSE). Third-party components and
model assets retain the notices documented in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
