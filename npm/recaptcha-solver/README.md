# @conghuy113/recaptcha-solver

AGPL-3.0 TypeScript package that solves reCAPTCHA in an already-open Chrome
browser. Python and a hosted inference API are not required on the consumer
machine.

The package entrypoint exports only `solveReCaptcha()` and its TypeScript
types. Classification, detection, CDP, and challenge-navigation
implementations are internal and are being integrated incrementally; the
current solve path still uses a transitional platform worker installed as an
optional dependency.

```ts
import { solveReCaptcha } from "@conghuy113/recaptcha-solver";

const result = await solveReCaptcha({
  targetUrl: "https://example.com/signup",
  port: 9222,
  clickCheckbox: true,
});

console.log(result.token);
```

Chrome must already be running with remote debugging enabled on the supplied
loopback port. The package only attaches to that existing browser and never
starts or closes Chrome.

Use this package only on systems and pages you own or are explicitly authorized
to test.

## Model installation

`npm install` downloads the pinned classification and detection ONNX files from
the package's public GitHub Release. Every download is restricted to trusted
GitHub hosts and verified against the byte size and SHA-256 in
`model-manifest.json` before it is atomically added to the local cache.

Set `RECAPTCHA_SOLVER_CACHE_DIR` to move the cache, or
`RECAPTCHA_SOLVER_MODEL_DIR` to use a directory that already contains both
verified model files. For offline or image-build installs, set
`RECAPTCHA_SOLVER_SKIP_MODEL_DOWNLOAD=1`; the first call to `solveReCaptcha`
will verify/download the models unless `RECAPTCHA_SOLVER_MODEL_DIR` is set.

## License

GNU Affero General Public License v3.0. Upstream and model notices are included
in `THIRD_PARTY_NOTICES.md`.
