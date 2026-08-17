"""Prepare immutable model assets for a native worker build.

Downloads happen only in controlled build/release workflows. The frozen worker
never calls this module and requires the verified model cache supplied by npm.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = Path(__file__).with_name("model-assets.json")


@dataclass(frozen=True)
class ModelAsset:
    """One model pinned by URL, byte size, and SHA-256."""

    name: str
    target: Path
    url: str
    sha256: str
    size: int


@dataclass(frozen=True)
class GeneratedAsset:
    """A runtime model derived from a pinned source model during native build."""

    name: str
    target: Path
    source: Path
    minimum_size: int


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_assets(manifest_path: Path = MANIFEST_PATH) -> list[ModelAsset]:
    raw: Any = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("schema_version") != 1:
        raise ValueError(f"Unsupported model manifest: {manifest_path}")
    entries = raw.get("assets")
    if not isinstance(entries, list) or not entries:
        raise ValueError(f"Model manifest has no assets: {manifest_path}")

    assets: list[ModelAsset] = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("Every model asset must be an object")
        relative_target = Path(str(entry["target"]))
        if relative_target.is_absolute() or ".." in relative_target.parts:
            raise ValueError(f"Model target must stay inside the project: {relative_target}")
        assets.append(
            ModelAsset(
                name=str(entry["name"]),
                target=PROJECT_ROOT / relative_target,
                url=str(entry["url"]),
                sha256=str(entry["sha256"]).lower(),
                size=int(entry["size"]),
            )
        )
    return assets


def load_generated_assets(manifest_path: Path = MANIFEST_PATH) -> list[GeneratedAsset]:
    raw: Any = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = raw.get("generated_assets", []) if isinstance(raw, dict) else []
    if not isinstance(entries, list):
        raise ValueError("generated_assets must be an array")
    generated: list[GeneratedAsset] = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("Every generated model asset must be an object")
        target = Path(str(entry["target"]))
        source = Path(str(entry["source"]))
        for relative_path in (target, source):
            if relative_path.is_absolute() or ".." in relative_path.parts:
                raise ValueError(
                    f"Generated model path must stay inside the project: {relative_path}"
                )
        generated.append(
            GeneratedAsset(
                name=str(entry["name"]),
                target=PROJECT_ROOT / target,
                source=PROJECT_ROOT / source,
                minimum_size=int(entry["minimum_size"]),
            )
        )
    return generated


def verify_asset(asset: ModelAsset) -> tuple[bool, str]:
    if not asset.target.is_file():
        return False, "missing"
    actual_size = asset.target.stat().st_size
    if actual_size != asset.size:
        return False, f"size {actual_size}, expected {asset.size}"
    actual_hash = file_sha256(asset.target)
    if actual_hash != asset.sha256:
        return False, f"sha256 {actual_hash}, expected {asset.sha256}"
    return True, "verified"


def download_asset(asset: ModelAsset) -> None:
    asset.target.parent.mkdir(parents=True, exist_ok=True)
    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{asset.name}.",
        suffix=".download",
        dir=asset.target.parent,
    )
    os.close(file_descriptor)
    temporary_path = Path(temporary_name)
    request = urllib.request.Request(
        asset.url,
        headers={"User-Agent": "@conghuy113/recaptcha-solver native builder"},
    )
    try:
        digest = hashlib.sha256()
        size = 0
        with urllib.request.urlopen(request, timeout=60) as response, temporary_path.open(
            "wb"
        ) as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
                digest.update(chunk)
                size += len(chunk)

        if size != asset.size:
            raise ValueError(
                f"Downloaded {asset.name} has size {size}; expected {asset.size}"
            )
        actual_hash = digest.hexdigest()
        if actual_hash != asset.sha256:
            raise ValueError(
                f"Downloaded {asset.name} has SHA-256 {actual_hash}; "
                f"expected {asset.sha256}"
            )
        temporary_path.replace(asset.target)
    finally:
        temporary_path.unlink(missing_ok=True)


def verify_generated_asset(asset: GeneratedAsset) -> tuple[bool, str]:
    if not asset.target.is_file():
        return False, "missing"
    size = asset.target.stat().st_size
    if size < asset.minimum_size:
        return False, f"size {size}, expected at least {asset.minimum_size}"
    try:
        import onnxruntime as ort

        session = ort.InferenceSession(
            str(asset.target),
            providers=["CPUExecutionProvider"],
        )
        input_shape = session.get_inputs()[0].shape
        output_shape = session.get_outputs()[0].shape
        if input_shape != [1, 3, 640, 640] or output_shape != [1, 84, 8400]:
            return False, f"unexpected input/output shapes: {input_shape}, {output_shape}"
    except Exception as error:
        return False, f"ONNX validation failed: {error}"
    return True, "verified"


def export_generated_asset(asset: GeneratedAsset) -> None:
    if asset.name != "yolo12x.onnx":
        raise ValueError(f"No exporter is configured for {asset.name}")
    if not asset.source.is_file():
        raise ValueError(f"Generated model source is missing: {asset.source}")
    from ultralytics import YOLO

    exported = Path(
        YOLO(str(asset.source)).export(
            format="onnx",
            imgsz=640,
            dynamic=False,
            simplify=False,
            opset=17,
            nms=False,
        )
    ).resolve()
    if exported != asset.target.resolve():
        asset.target.parent.mkdir(parents=True, exist_ok=True)
        exported.replace(asset.target)


def prepare_assets(*, check_only: bool) -> None:
    failures: list[str] = []
    for asset in load_assets():
        valid, reason = verify_asset(asset)
        if valid:
            print(f"Verified model: {asset.name}")
            continue
        if check_only:
            failures.append(f"{asset.name}: {reason}")
            continue
        print(f"Preparing model {asset.name} ({reason})...")
        download_asset(asset)
        valid, reason = verify_asset(asset)
        if not valid:
            failures.append(f"{asset.name}: {reason}")

    for asset in load_generated_assets():
        valid, reason = verify_generated_asset(asset)
        if valid:
            print(f"Verified generated model: {asset.name}")
            continue
        if check_only:
            failures.append(f"{asset.name}: {reason}")
            continue
        print(f"Exporting generated model {asset.name} ({reason})...")
        export_generated_asset(asset)
        valid, reason = verify_generated_asset(asset)
        if not valid:
            failures.append(f"{asset.name}: {reason}")

    if failures:
        raise SystemExit("Model verification failed: " + "; ".join(failures))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify local assets without making network requests.",
    )
    args = parser.parse_args()
    prepare_assets(check_only=args.check)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
