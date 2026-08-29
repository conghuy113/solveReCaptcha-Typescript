# @conghuy113/recaptcha-solver

AGPL-3.0 TypeScript package that solves reCAPTCHA in an already-open Chrome
browser.

The package entrypoint exports only `solveReCaptcha()` and its TypeScript
types. Classification, detection, CDP, challenge handlers, and solve
orchestration run directly in TypeScript and remain internal implementation
details.

```ts
import { solveReCaptcha } from "@conghuy113/recaptcha-solver";

const result = await solveReCaptcha({
  targetUrl: "https://example.com/signup",
  port: 9222,
  clickCheckbox: true,
  confidence: {
    classificationMinConfidence: 0.35,
    detectionConfidence: 0.7,
  },
});

console.log(result.token);
```

CommonJS is supported too:

```js
const { solveReCaptcha } = require("@conghuy113/recaptcha-solver");
```

Chrome must already be running with remote debugging enabled on the supplied
loopback port. The package only attaches to that existing browser and never
starts or closes Chrome.

Visible and headless Chrome use the same CDP path. Headless Chrome must expose
a usable, non-zero viewport. Checkbox, tile, and Verify input is accepted only
after an observable widget state change, with at most one retry per action.

Use this package only on systems and pages you own or are explicitly authorized
to test.

## Result verification

The package snapshots response tokens before it interacts with the widget. A
pre-existing token can never complete a solve. When `clickCheckbox` is `true`,
`status: "success"` requires a new token and a solved checkbox. When it is
`false`, navigation away from the pre-Verify URL is also a successful
completion. A new token without solved widget state resolves with
`status: "unverified"` and `verification: "token_observed"`.

Existing result fields remain available. The additional `verification` field
describes whether completion was confirmed by widget plus token, navigation,
or only an observed client-side signal. Server-side token verification remains
the caller's responsibility so this package does not consume a one-use token.

## Confidence options

`confidence` is an optional per-call object. It accepts only:

- `classificationMinConfidence` (default: `0.2`), which gates each of the top
  three 3x3 Classification cells.
- `detectionConfidence` (default: `0.6`), which filters 4x4 Detection boxes
  before NMS.

Each supplied value must be a finite number between `0` and `1`. Unknown fields
or invalid values throw `TypeError` before Chrome is connected. The thresholds
are scoped to one solve call. Higher values are more selective; lower values
accept more predictions and may increase incorrect clicks. Scores from the two
models are not directly comparable.

When an image model is used, the result echoes only the confidence fields that
the caller explicitly supplied. The `confidence` field is omitted for a solve
that did not use an image model or did not supply an override.

## Model installation

`npm install` downloads the pinned classification and detection ONNX files from
the package's public GitHub Release. Every download is restricted to trusted
GitHub hosts and verified against the byte size and SHA-256 in
`model-manifest.json` before it is atomically added to the local cache.

Set `RECAPTCHA_SOLVER_MODEL_DIR` to select the exact directory in which both
model files are verified or downloaded. For offline or image-build installs, set
`RECAPTCHA_SOLVER_SKIP_MODEL_DOWNLOAD=1`; the first call to `solveReCaptcha`
will verify/download the models before the first image challenge unless
`RECAPTCHA_SOLVER_MODEL_DIR` is set.

### Custom model directory before `npm install`

Use an absolute path and provide the same `RECAPTCHA_SOLVER_MODEL_DIR` to both
the install process and the application process. Existing model files are
verified by size and SHA-256; missing or invalid files are downloaded into the
directory during installation.

Merely creating `.env` does not affect npm dependency lifecycle scripts. Load
it explicitly for installation:

```dotenv
RECAPTCHA_SOLVER_MODEL_DIR=/opt/recaptcha-solver-models
```

```bash
npx --yes dotenv-cli -e .env -- npm install @conghuy113/recaptcha-solver
node --env-file=.env dist/app.js
```

PowerShell can configure the current install and runtime session directly:

```powershell
$ModelDirectory = [IO.Path]::GetFullPath((Join-Path $PWD "recaptcha-solver-models"))
New-Item -ItemType Directory -Force -Path $ModelDirectory | Out-Null
$env:RECAPTCHA_SOLVER_MODEL_DIR = $ModelDirectory

npm install @conghuy113/recaptcha-solver
node .\dist\app.js
```

For Docker, declare the directory before the dependency installation:

```dockerfile
ARG RECAPTCHA_SOLVER_MODEL_DIR=/opt/recaptcha-solver-models
ENV RECAPTCHA_SOLVER_MODEL_DIR=${RECAPTCHA_SOLVER_MODEL_DIR}
RUN npm ci
```

When Docker Compose supplies the value from its `.env`, pass it to both build
and runtime:

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

A Compose `environment` entry alone does not affect `npm ci` inside
`docker build`. Also avoid mounting an empty volume over a directory containing
models baked into the image.

## License

GNU Affero General Public License v3.0. Upstream and model notices are included
in `THIRD_PARTY_NOTICES.md`.
