"""Fail CI when public package licensing or release routing regresses."""

# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import tomllib

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PUBLISHED_PACKAGES = (
    PROJECT_ROOT / "npm" / "recaptcha-solver",
    PROJECT_ROOT / "npm" / "platforms" / "win32-x64",
    PROJECT_ROOT / "npm" / "platforms" / "linux-x64",
    PROJECT_ROOT / "npm" / "platforms" / "darwin-x64",
    PROJECT_ROOT / "npm" / "platforms" / "darwin-arm64",
)
PUBLIC_REPOSITORY = "git+https://github.com/conghuy113/solveReCaptchaByAIVision.git"
MODEL_RELEASE_PREFIX = (
    "https://github.com/conghuy113/solveReCaptchaByAIVision/releases/download/"
)


def require_file(relative_path: str) -> Path:
    path = PROJECT_ROOT / relative_path
    if not path.is_file():
        raise RuntimeError(f"Required compliance file is missing: {relative_path}")
    return path


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"Expected a JSON object: {path}")
    return value


def check_root_licenses() -> None:
    license_text = require_file("LICENSE").read_text(encoding="utf-8")
    if "GNU AFFERO GENERAL PUBLIC LICENSE" not in license_text or "Version 3" not in license_text:
        raise RuntimeError("Root LICENSE is not the complete GNU AGPL v3 text")

    for relative_path in (
        "LICENSES/vision-ai-recaptcha-solver-MIT.txt",
        "LICENSES/recaptcha-domain-replicator-MIT.txt",
    ):
        notice = require_file(relative_path).read_text(encoding="utf-8")
        if "Copyright 2025 Danny Luna" not in notice or "Permission is hereby granted" not in notice:
            raise RuntimeError(f"Upstream MIT notice is incomplete: {relative_path}")

    for relative_path in (
        "THIRD_PARTY_NOTICES.md",
        "MODEL_LICENSES.md",
        "DATASET_PROVENANCE.md",
    ):
        require_file(relative_path)


def check_python_metadata() -> None:
    pyproject = tomllib.loads(require_file("pyproject.toml").read_text(encoding="utf-8"))
    project = pyproject.get("project")
    if not isinstance(project, dict) or project.get("license") != {"file": "LICENSE"}:
        raise RuntimeError("pyproject.toml must package the root AGPL LICENSE file")


def check_npm_packages() -> None:
    for package_root in PUBLISHED_PACKAGES:
        manifest = load_json(package_root / "package.json")
        if manifest.get("license") != "AGPL-3.0-only":
            raise RuntimeError(f"npm package is not AGPL-3.0-only: {package_root}")

        publish_config = manifest.get("publishConfig")
        if not isinstance(publish_config, dict):
            raise RuntimeError(f"npm package has no publishConfig: {package_root}")
        if publish_config.get("access") != "public" or publish_config.get("provenance") is not True:
            raise RuntimeError(f"npm package must publish publicly with provenance: {package_root}")

        files = manifest.get("files")
        if not isinstance(files, list):
            raise RuntimeError(f"npm package has no explicit files allowlist: {package_root}")
        for required_name in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
            if required_name not in files or not (package_root / required_name).is_file():
                raise RuntimeError(
                    f"npm package does not include {required_name}: {package_root}"
                )

    solver_root = PROJECT_ROOT / "npm" / "recaptcha-solver"
    solver_package = load_json(solver_root / "package.json")
    repository = solver_package.get("repository")
    if not isinstance(repository, dict) or repository.get("url") != PUBLIC_REPOSITORY:
        raise RuntimeError("Main npm package must point to the public source repository")
    if "model-manifest.json" not in solver_package.get("files", []):
        raise RuntimeError("Main npm package must publish model-manifest.json")

    model_manifest = load_json(solver_root / "model-manifest.json")
    models = model_manifest.get("models")
    if (
        model_manifest.get("schemaVersion") != 1
        or model_manifest.get("license") != "AGPL-3.0-only"
        or not isinstance(models, list)
        or {model.get("id") for model in models if isinstance(model, dict)}
        != {"classification", "detection"}
    ):
        raise RuntimeError("Model manifest must pin exactly the two AGPL model assets")
    for model in models:
        if not isinstance(model, dict):
            raise RuntimeError("Invalid model manifest entry")
        if not str(model.get("url", "")).startswith(MODEL_RELEASE_PREFIX):
            raise RuntimeError("Model assets must use the public GitHub Release")
        if not isinstance(model.get("size"), int) or model["size"] < 1:
            raise RuntimeError("Model assets must pin a positive byte size")
        sha256 = model.get("sha256")
        if not isinstance(sha256, str) or len(sha256) != 64:
            raise RuntimeError("Model assets must pin a SHA-256 digest")


def check_release_routing() -> None:
    workflow = require_file(".github/workflows/publish.yml").read_text(encoding="utf-8")
    if '"python-v*"' not in workflow:
        raise RuntimeError("PyPI workflow must be restricted to python-v* tags")
    if "release:" in workflow or "types: [published]" in workflow:
        raise RuntimeError("PyPI workflow must not run for generic GitHub Releases")


def main() -> int:
    check_root_licenses()
    check_python_metadata()
    check_npm_packages()
    check_release_routing()
    print("Public-package compliance checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
