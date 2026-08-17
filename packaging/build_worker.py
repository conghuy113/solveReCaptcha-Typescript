"""Build and stage the native worker for the current operating system.

Run this script natively on every target OS/architecture. PyInstaller does not
cross-compile, so the CI workflow invokes it once per npm platform package.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from prepare_models import (
    load_assets,
    load_generated_assets,
    verify_asset,
    verify_generated_asset,
)

PROJECT_ROOT = Path(__file__).resolve().parent.parent
NPM_PLATFORMS = PROJECT_ROOT / "npm" / "platforms"
BUILD_ROOT = PROJECT_ROOT / "build" / "native"
PROTOCOL_VERSION = 1
NATIVE_FORMAT_VERSION = 1
PLATFORM_DIRECTORIES = {
    ("Windows", "AMD64"): "win32-x64",
    ("Windows", "x86_64"): "win32-x64",
    ("Linux", "x86_64"): "linux-x64",
    ("Darwin", "x86_64"): "darwin-x64",
    ("Darwin", "arm64"): "darwin-arm64",
}


def current_platform_directory() -> str:
    key = (platform.system(), platform.machine())
    try:
        return PLATFORM_DIRECTORIES[key]
    except KeyError as error:
        raise SystemExit(f"Unsupported build platform: {key[0]}-{key[1]}") from error


def verify_offline_assets() -> None:
    failures: list[str] = []
    for asset in load_assets():
        valid, reason = verify_asset(asset)
        if not valid:
            failures.append(f"{asset.name}: {reason}")
    for asset in load_generated_assets():
        valid, reason = verify_generated_asset(asset)
        if not valid:
            failures.append(f"{asset.name}: {reason}")
    if failures:
        raise SystemExit("Offline model verification failed: " + "; ".join(failures))


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _assert_path_inside(path: Path, parent: Path) -> None:
    resolved_path = path.resolve()
    resolved_parent = parent.resolve()
    if resolved_path == resolved_parent or resolved_parent not in resolved_path.parents:
        raise SystemExit(f"Refusing to modify path outside {resolved_parent}: {resolved_path}")


def _read_package_json(package_root: Path) -> dict[str, Any]:
    value: Any = json.loads((package_root / "package.json").read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit(f"Invalid package.json: {package_root / 'package.json'}")
    return value


def executable_name(platform_directory: str) -> str:
    return "recaptcha-solver-worker.exe" if platform_directory == "win32-x64" else "recaptcha-solver-worker"


def stage_build(platform_directory: str) -> Path:
    source = BUILD_ROOT / "dist" / "recaptcha-solver-worker"
    if not source.is_dir():
        raise SystemExit(f"PyInstaller output was not found: {source}")

    package_root = NPM_PLATFORMS / platform_directory
    destination = package_root / "bin" / "recaptcha-solver-worker"
    _assert_path_inside(destination, NPM_PLATFORMS)
    if destination.exists():
        shutil.rmtree(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, destination)

    executable = destination / executable_name(platform_directory)
    if not executable.is_file() or executable.stat().st_size == 0:
        raise SystemExit(f"Native worker executable is missing: {executable}")
    if os.name != "nt":
        executable.chmod(executable.stat().st_mode | 0o755)

    checksums = {
        str(path.relative_to(package_root)).replace("\\", "/"): file_sha256(path)
        for path in sorted(destination.rglob("*"))
        if path.is_file()
    }
    (package_root / "checksums.json").write_text(
        json.dumps(checksums, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    package_json = _read_package_json(package_root)
    build_info = {
        "schemaVersion": NATIVE_FORMAT_VERSION,
        "protocolVersion": PROTOCOL_VERSION,
        "package": package_json.get("name"),
        "version": package_json.get("version"),
        "platform": platform_directory,
        "system": platform.system(),
        "machine": platform.machine(),
        "pythonVersion": platform.python_version(),
        "executable": str(executable.relative_to(package_root)).replace("\\", "/"),
        "fileCount": len(checksums),
        "unpackedSize": sum(path.stat().st_size for path in destination.rglob("*") if path.is_file()),
    }
    (package_root / "build-info.json").write_text(
        json.dumps(build_info, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return destination


def prepare_smoke_model_directory() -> Path:
    """Copy verified models outside the npm artifact for native warm-up tests."""
    model_directory = BUILD_ROOT / "model-smoke"
    if model_directory.exists():
        shutil.rmtree(model_directory)
    model_directory.mkdir(parents=True)

    runtime_assets: list[tuple[str, Path]] = []
    runtime_assets.extend(
        (asset.name, asset.target) for asset in load_assets() if asset.target.suffix == ".onnx"
    )
    runtime_assets.extend((asset.name, asset.target) for asset in load_generated_assets())
    for name, source in runtime_assets:
        shutil.copy2(source, model_directory / name)
    return model_directory


def run_pyinstaller() -> None:
    os.environ.setdefault("PYINSTALLER_CONFIG_DIR", str(BUILD_ROOT / "pyinstaller-cache"))
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--distpath",
            str(BUILD_ROOT / "dist"),
            "--workpath",
            str(BUILD_ROOT / "work"),
            str(PROJECT_ROOT / "packaging" / "worker.spec"),
        ],
        cwd=PROJECT_ROOT,
        check=True,
    )


def verify_worker(
    platform_directory: str,
    *,
    initialize: bool,
    model_directory: Path | None = None,
) -> None:
    command = [
        sys.executable,
        str(PROJECT_ROOT / "packaging" / "verify_worker.py"),
        "--platform",
        platform_directory,
    ]
    if initialize:
        command.append("--initialize")
        if model_directory is None:
            raise SystemExit("Model directory is required for native worker warm-up")
        command.extend(("--model-dir", str(model_directory)))
    subprocess.run(command, cwd=PROJECT_ROOT, check=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--platform",
        choices=sorted(set(PLATFORM_DIRECTORIES.values())),
        default=current_platform_directory(),
        help="Expected npm platform package for this native build.",
    )
    parser.add_argument(
        "--skip-pyinstaller",
        action="store_true",
        help="Restage and verify an existing PyInstaller output.",
    )
    parser.add_argument(
        "--verify-initialize",
        action="store_true",
        help="Load and warm both externally staged models after building.",
    )
    args = parser.parse_args()
    actual_platform = current_platform_directory()
    if args.platform != actual_platform:
        raise SystemExit(
            f"Cannot build {args.platform} on {actual_platform}; run on the target OS/CPU."
        )

    verify_offline_assets()
    if not args.skip_pyinstaller:
        run_pyinstaller()
    destination = stage_build(actual_platform)
    smoke_models = prepare_smoke_model_directory() if args.verify_initialize else None
    verify_worker(
        actual_platform,
        initialize=args.verify_initialize,
        model_directory=smoke_models,
    )
    print(f"Native worker staged and verified at: {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
