"""Stage the two immutable, hash-pinned ONNX assets for a GitHub Release."""

# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PACKAGE_MANIFEST = PROJECT_ROOT / "npm" / "recaptcha-solver" / "model-manifest.json"
SOURCE_PATHS = {
    "recaptcha_classification_57k.onnx": (
        PROJECT_ROOT
        / "src"
        / "vision_ai_recaptcha_solver"
        / "models"
        / "recaptcha_classification_57k.onnx"
    ),
    "yolo12x.onnx": PROJECT_ROOT / "yolo12x.onnx",
}
NOTICE_PATHS = (
    PROJECT_ROOT / "LICENSE",
    PROJECT_ROOT / "MODEL_LICENSES.md",
    PROJECT_ROOT / "DATASET_PROVENANCE.md",
    PROJECT_ROOT / "docs" / "model-cards" / "classification.md",
    PROJECT_ROOT / "docs" / "model-cards" / "detection.md",
    PACKAGE_MANIFEST,
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest() -> dict[str, Any]:
    value: Any = json.loads(PACKAGE_MANIFEST.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise SystemExit("Unsupported npm model manifest")
    return value


def require_provenance_gate() -> None:
    provenance = (PROJECT_ROOT / "DATASET_PROVENANCE.md").read_text(encoding="utf-8")
    if "remain blocked from public release" in provenance:
        raise SystemExit(
            "Public model release is blocked by DATASET_PROVENANCE.md; complete the review first"
        )


def stage(output: Path, expected_tag: str) -> None:
    manifest = load_manifest()
    if manifest.get("releaseTag") != expected_tag:
        raise SystemExit(
            f"Requested tag {expected_tag!r} does not match manifest tag "
            f"{manifest.get('releaseTag')!r}"
        )
    if output.exists() and any(output.iterdir()):
        raise SystemExit(f"Release staging directory must be empty: {output}")
    output.mkdir(parents=True, exist_ok=True)

    checksum_lines: list[str] = []
    models = manifest.get("models")
    if not isinstance(models, list) or len(models) != 2:
        raise SystemExit("Model manifest must contain exactly two assets")
    for model in models:
        if not isinstance(model, dict):
            raise SystemExit("Invalid model manifest entry")
        file_name = str(model.get("fileName", ""))
        source = SOURCE_PATHS.get(file_name)
        if source is None or not source.is_file():
            raise SystemExit(f"Prepared model is missing: {file_name}")
        expected_size = model.get("size")
        expected_hash = model.get("sha256")
        actual_hash = sha256(source)
        if source.stat().st_size != expected_size or actual_hash != expected_hash:
            raise SystemExit(f"Prepared model does not match the immutable manifest: {file_name}")
        shutil.copy2(source, output / file_name)
        checksum_lines.append(f"{actual_hash}  {file_name}")

    for notice in NOTICE_PATHS:
        if not notice.is_file():
            raise SystemExit(f"Required release notice is missing: {notice}")
        destination_name = (
            f"MODEL_CARD_{notice.stem.upper()}.md"
            if notice.parent.name == "model-cards"
            else notice.name
        )
        shutil.copy2(notice, output / destination_name)
    (output / "SHA256SUMS").write_text("\n".join(checksum_lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--require-provenance-review", action="store_true")
    args = parser.parse_args()
    if args.require_provenance_review:
        require_provenance_gate()
    stage(args.output.resolve(), args.tag)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
