# Release process

This repository separates model publication from npm publication. Both paths
are fail-closed: a failed or incomplete gate must not be bypassed by editing a
generated artifact after it has been checked.

## Current release blockers

The classification training-data review in `DATASET_PROVENANCE.md` is not
complete. Do not run the model release workflow with `RELEASE_APPROVED` until a
maintainer has recorded the missing source/permission evidence or an
appropriate license review has concluded that redistribution of the weights is
permitted.

The npm workflow also cannot succeed until the immutable model release exists,
because it downloads both files and verifies their exact byte sizes and SHA-256
digests before publishing.

## One-time GitHub and npm configuration

1. Create the protected GitHub environments `model-release` and `npm-publish`.
2. Add the repository owner as the required reviewer for both environments.
3. On npmjs.com, configure the Trusted Publisher for
   `@conghuy113/recaptcha-solver` with:
   - provider: GitHub Actions;
   - repository owner: `conghuy113`;
   - repository: `solveReCaptchaByAIVision`;
   - workflow filename: `npm-publish.yml`;
   - environment: `npm-publish`;
   - allowed action: `npm publish`.
4. After Trusted Publishing works, require 2FA and disallow token-based
   publication. The workflow intentionally contains no `NPM_TOKEN` or
   `NODE_AUTH_TOKEN` fallback.
5. Protect version tags matching `v*` and model tags matching `models-v*`.

If npmjs.com does not allow a Trusted Publisher to be configured before this
scoped package exists, the owner must perform the one-time namespace/bootstrap
step directly on npmjs.com. Do not add a reusable publish token to this
repository. Confirm the bootstrap procedure shown by npm at that time before
creating the first public version, because registry setup rules may change.

## Model release

1. Complete and review `DATASET_PROVENANCE.md`.
2. Set `packaging/model-release-approval.json` to `approved`, recording a
   non-empty reviewer, review date, and evidence list.
3. Merge both reviewed records to `main`.
4. Run **Publish immutable model release** from `main` with:
   - `release_tag`: the exact `releaseTag` from `model-manifest.json`;
   - `provenance_attestation`: `RELEASE_APPROVED`.
5. Approve the `model-release` environment deployment.
6. Verify that the resulting GitHub Release contains both ONNX files,
   `SHA256SUMS`, both model cards, the model manifest, the AGPL license, and the
   provenance and approval records.

The workflow refuses to mutate or replace an existing model Release.

## npm release

1. Update `npm/recaptcha-solver/package.json` to the intended immutable version.
2. Update `CHANGELOG.md` and run all CI gates on `main`.
3. Create an annotated tag named exactly `v<package-version>` on the reviewed
   commit and publish a GitHub Release from that tag.
4. Approve the `npm-publish` environment deployment.

The workflow checks the tag/manifest relationship, runs typecheck/tests/build,
packs and clean-installs the package, creates a CycloneDX SBOM and dependency
license inventory, downloads and verifies both released models, refuses an
already-published npm version, attaches the evidence to the GitHub Release, and
then calls `npm publish` through OIDC Trusted Publishing.

## Local release dry run

Run from a clean checkout with Node.js 20 or newer, pnpm 10.34.5, and Python
3.12:

```bash
RECAPTCHA_SOLVER_SKIP_MODEL_DOWNLOAD=1 pnpm --dir npm install --frozen-lockfile --ignore-scripts
python packaging/check_compliance.py
pnpm --dir npm --filter @conghuy113/recaptcha-solver run typecheck
pnpm --dir npm --filter @conghuy113/recaptcha-solver run test
pnpm --dir npm --filter @conghuy113/recaptcha-solver run build
mkdir -p artifacts
pnpm --dir npm/recaptcha-solver pack --out ../../artifacts/recaptcha-solver.tgz
node packaging/smoke_npm_install.mjs artifacts/recaptcha-solver.tgz
node packaging/generate_release_evidence.mjs artifacts/recaptcha-solver.tgz artifacts/release-evidence
node packaging/check_release_candidate.mjs v0.1.0 --manifest-only
```

The live model-download gate can be tested only after the model Release exists.
Never run `npm publish` as part of a local dry run.
