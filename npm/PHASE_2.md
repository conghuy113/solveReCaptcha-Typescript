# Phase 2 — Verified model delivery

## Outcome

Both ONNX models are distributed as immutable GitHub Release assets rather
than committed to Git or duplicated across platform packages:

- `recaptcha_classification_57k.onnx`
- `yolo12x.onnx`

`model-manifest.json` pins the Release tag, URL, exact byte size, SHA-256,
input/output names, and tensor shapes. The model manager:

1. accepts downloads only from the configured GitHub repository and Release
   tag;
2. locks the cache to prevent concurrent writers;
3. downloads into a temporary file with bounded retries;
4. checks size and SHA-256 before an atomic rename;
5. removes partial or corrupt files; and
6. re-verifies cached or externally supplied models before use.

The package's `postinstall` downloads both assets. If lifecycle scripts are
disabled, the first runtime preparation can recover the same verified set.
Offline builds may supply a pre-populated directory through
`RECAPTCHA_SOLVER_MODEL_DIR`.

## Release gate

The repository and npm package are AGPL-3.0-only. Model publication remains
blocked until `DATASET_PROVENANCE.md` is completed and the model-release
workflow's licensing checks pass. A published model Release is immutable and
must never be silently replaced.
