# PR-01 baseline

This document records the verified local baseline before the Python worker is
ported to a single TypeScript npm package.

## Versions and scope

- Python package: `vision-ai-recaptcha-solver` `1.0.5`
- TypeScript package: `@conghuy113/recaptcha-solver` `0.1.0`
- Public runtime API: `solveReCaptcha(options)`
- Legacy runtime: TypeScript SDK plus a PyInstaller Python worker
- Current runtime models: `recaptcha_classification_57k.onnx` and `yolo12x.onnx`

## Verified tests

- Python: 92 tests passed.
- TypeScript: 5 tests passed.
- TypeScript type-check and ESM/declaration build passed.
- Python wheel build passed and includes the root AGPL license.
- npm pack inspection passed and includes `LICENSE` and
  `THIRD_PARTY_NOTICES.md`.

## Repository state

The supplied workspace did not contain Git metadata, so a baseline tag could
not be created here. Before opening the public pull request, apply these changes
to a fork that retains the MIT upstream history, then create the tag
`python-baseline-v1.0.5` on the pre-refactor commit.

Do not initialize a history-less replacement repository unless preserving the
upstream history is intentionally impossible. The original MIT copyright and
permission notices must remain available in all substantial copies.

## Release blocks after PR-01

- Configure the exact public repository URL in npm and Python metadata.
- Complete the training-dataset provenance review.
- Create immutable model release assets and model cards.
- Port the Python runtime to TypeScript before removing the legacy baseline.
