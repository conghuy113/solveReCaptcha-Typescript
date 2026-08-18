"""Fail CI when npm package licensing, contents, or release routing regresses."""

# SPDX-License-Identifier: AGPL-3.0-only

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PACKAGE_ROOT = PROJECT_ROOT / "npm" / "recaptcha-solver"
PUBLIC_REPOSITORY = "git+https://github.com/conghuy113/solveReCaptchaByAIVision.git"
MODEL_RELEASE_PREFIX = (
    "https://github.com/conghuy113/solveReCaptchaByAIVision/releases/download/"
)
NPM_PUBLISH_WORKFLOW = ".github/workflows/npm-publish.yml"
CI_WORKFLOW = ".github/workflows/ci.yml"
REMOVED_RUNTIME_PATHS = (
    ".github/workflows/native-npm-build.yml",
    ".github/workflows/publish.yml",
    "npm/platforms",
    "npm/recaptcha-solver/src/platform.ts",
    "npm/recaptcha-solver/src/worker-client.ts",
    "packaging/build_worker.py",
    "packaging/verify_worker.py",
    "packaging/worker.spec",
    "pyproject.toml",
    "src/vision_ai_recaptcha_solver",
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
        if not notice.startswith("Copyright 2026 ") or "Permission is hereby granted" not in notice:
            raise RuntimeError(f"Upstream MIT notice is incomplete: {relative_path}")

    for relative_path in (
        "THIRD_PARTY_NOTICES.md",
        "MODEL_LICENSES.md",
        "DATASET_PROVENANCE.md",
        "CHANGELOG.md",
        "docs/RELEASE.md",
    ):
        require_file(relative_path)


def check_npm_package() -> None:
    package = load_json(PACKAGE_ROOT / "package.json")
    if package.get("license") != "AGPL-3.0-only":
        raise RuntimeError("npm package is not AGPL-3.0-only")

    publish_config = package.get("publishConfig")
    if not isinstance(publish_config, dict):
        raise RuntimeError("npm package has no publishConfig")
    if publish_config.get("access") != "public" or publish_config.get("provenance") is not True:
        raise RuntimeError("npm package must publish publicly with provenance")

    files = package.get("files")
    if not isinstance(files, list):
        raise RuntimeError("npm package has no explicit files allowlist")
    for required_name in ("LICENSE", "THIRD_PARTY_NOTICES.md", "model-manifest.json"):
        if required_name not in files or not (PACKAGE_ROOT / required_name).is_file():
            raise RuntimeError(f"npm package does not include {required_name}")
    package_notice = (PACKAGE_ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8")
    if "Copyright 2026 " not in package_notice or "Permission is hereby granted" not in package_notice:
        raise RuntimeError("npm package does not preserve the required upstream MIT notice")

    repository = package.get("repository")
    if not isinstance(repository, dict) or repository.get("url") != PUBLIC_REPOSITORY:
        raise RuntimeError("npm package must point to the public source repository")
    if "optionalDependencies" in package:
        raise RuntimeError("TypeScript-only package must not declare platform workers")

    exports = package.get("exports")
    root_export = exports.get(".") if isinstance(exports, dict) else None
    expected_entrypoints = {
        "main": "./dist/index.cjs",
        "module": "./dist/index.js",
        "types": "./dist/index.d.ts",
    }
    for field, expected in expected_entrypoints.items():
        if package.get(field) != expected:
            raise RuntimeError(f"npm package {field} must point to {expected}")
    if not isinstance(root_export, dict):
        raise RuntimeError("npm package has no root conditional export")
    expected_exports = {
        "types": "./dist/index.d.ts",
        "import": "./dist/index.js",
        "require": "./dist/index.cjs",
        "default": "./dist/index.js",
    }
    for condition, expected in expected_exports.items():
        if root_export.get(condition) != expected:
            raise RuntimeError(
                f"npm package export condition {condition} must point to {expected}"
            )

    entrypoint = require_file("npm/recaptcha-solver/src/index.ts").read_text(encoding="utf-8")
    if entrypoint.count("export { solveReCaptcha }") != 1 or "WorkerClient" in entrypoint:
        raise RuntimeError("Public entrypoint must export only the TypeScript solve path")


def check_model_manifest() -> None:
    manifest = load_json(PACKAGE_ROOT / "model-manifest.json")
    models = manifest.get("models")
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("license") != "AGPL-3.0-only"
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


def check_removed_runtime() -> None:
    for relative_path in REMOVED_RUNTIME_PATHS:
        if (PROJECT_ROOT / relative_path).exists():
            raise RuntimeError(f"Removed Python/native runtime returned: {relative_path}")
    workspace = require_file("npm/pnpm-workspace.yaml").read_text(encoding="utf-8")
    if "platforms" in workspace:
        raise RuntimeError("npm workspace must contain only the TypeScript package")


def check_release_routing() -> None:
    model_workflow = require_file(".github/workflows/model-release.yml").read_text(
        encoding="utf-8"
    )
    if "workflow_dispatch:" not in model_workflow or "gh release create" not in model_workflow:
        raise RuntimeError("Model release must remain an explicit immutable workflow")
    for pinned_dependency in ("torch==2.9.1", "torchvision==0.24.1"):
        if pinned_dependency not in model_workflow:
            raise RuntimeError(f"Model export dependency is not pinned: {pinned_dependency}")

    npm_workflow = require_file(NPM_PUBLISH_WORKFLOW).read_text(encoding="utf-8")
    required_fragments = (
        "types: [published]",
        "id-token: write",
        "environment: npm-publish",
        'node-version: "24"',
        "pnpm/action-setup@v6",
        "actions/upload-artifact@v6",
        "npm@11.18.0",
        "check_release_candidate.mjs",
        "generate_release_evidence.mjs",
        "check_registry_version.mjs",
        "npm publish ./artifacts/recaptcha-solver.tgz --access public --provenance",
    )
    for fragment in required_fragments:
        if fragment not in npm_workflow:
            raise RuntimeError(f"npm Trusted Publishing workflow is missing: {fragment}")
    for forbidden_secret in ("NPM_TOKEN", "NODE_AUTH_TOKEN"):
        if forbidden_secret in npm_workflow:
            raise RuntimeError(
                f"npm workflow must not contain a long-lived token fallback: {forbidden_secret}"
            )

    ci_workflow = require_file(CI_WORKFLOW).read_text(encoding="utf-8")
    for action in (
        "actions/checkout@v6",
        "actions/setup-node@v6",
        "actions/setup-python@v6",
        "pnpm/action-setup@v6",
        "actions/upload-artifact@v6",
    ):
        if action not in ci_workflow:
            raise RuntimeError(f"CI workflow must use the Node.js 24 action release: {action}")


def check_release_evidence_policy() -> None:
    for relative_path in (
        "packaging/generate_release_evidence.mjs",
        "packaging/check_release_candidate.mjs",
        "packaging/check_registry_version.mjs",
    ):
        require_file(relative_path)
    policy = load_json(require_file("packaging/license-policy.json"))
    allowed = policy.get("allowedExpressions")
    if policy.get("schemaVersion") != 1 or not isinstance(allowed, list) or not allowed:
        raise RuntimeError("Dependency-license policy must be a non-empty versioned allowlist")
    if any(not isinstance(expression, str) or not expression for expression in allowed):
        raise RuntimeError("Dependency-license policy contains an invalid expression")
    if "AGPL-3.0-only" not in allowed:
        raise RuntimeError("Dependency-license policy must include the public package license")

    approval = load_json(require_file("packaging/model-release-approval.json"))
    if approval.get("schemaVersion") != 1 or approval.get("status") not in {
        "blocked",
        "approved",
    }:
        raise RuntimeError("Model release approval record has an invalid state")
    if approval.get("status") == "approved":
        evidence = approval.get("evidence")
        if (
            not isinstance(approval.get("reviewedBy"), str)
            or not approval["reviewedBy"].strip()
            or not isinstance(approval.get("reviewedAt"), str)
            or not approval["reviewedAt"].strip()
            or not isinstance(evidence, list)
            or not evidence
        ):
            raise RuntimeError("Approved model release record has incomplete review evidence")


def main() -> int:
    check_root_licenses()
    check_npm_package()
    check_model_manifest()
    check_removed_runtime()
    check_release_routing()
    check_release_evidence_policy()
    print("Public-package compliance checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
