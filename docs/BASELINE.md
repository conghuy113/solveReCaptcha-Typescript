# PR-01 baseline (historical)

This document records the verified local baseline before the Python worker was
ported to a single TypeScript npm package. It is retained as migration history;
it does not describe the current runtime.

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

## Resolution

- The repository URL and npm metadata now target the public repository.
- The Python/native worker has been replaced by the TypeScript runtime and
  removed from the active codebase.
- Immutable, hash-pinned model release tooling is in place.
- Training-dataset provenance review and the final model/npm publication gates
  remain release prerequisites.
