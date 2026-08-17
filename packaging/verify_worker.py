"""Verify a staged native worker through its JSON-lines protocol."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PROTOCOL_VERSION = 1


def executable_path(platform_directory: str) -> Path:
    executable = (
        "recaptcha-solver-worker.exe"
        if platform_directory == "win32-x64"
        else "recaptcha-solver-worker"
    )
    return (
        PROJECT_ROOT
        / "npm"
        / "platforms"
        / platform_directory
        / "bin"
        / "recaptcha-solver-worker"
        / executable
    )


def _require_success(response: dict[str, Any], request_id: str) -> dict[str, Any]:
    if response.get("id") != request_id or response.get("ok") is not True:
        raise SystemExit(f"Native worker request {request_id} failed: {response}")
    result = response.get("result")
    if not isinstance(result, dict):
        raise SystemExit(f"Native worker request {request_id} has no result: {response}")
    return result


def verify(
    platform_directory: str,
    *,
    initialize: bool,
    model_directory: Path | None = None,
) -> None:
    executable = executable_path(platform_directory)
    if not executable.is_file():
        raise SystemExit(f"Native worker executable is missing: {executable}")

    commands: list[dict[str, Any]] = [
        {"id": "status-before", "command": "status", "params": {}},
    ]
    if initialize:
        if model_directory is None or not model_directory.is_dir():
            raise SystemExit("--model-dir must point to the two verified ONNX model files")
        commands.append(
            {
                "id": "initialize",
                "command": "initialize",
                "params": {
                    "timeout_ms": 600_000,
                    "log_level": "WARNING",
                    "model_dir": str(model_directory.resolve()),
                },
            }
        )
        commands.append({"id": "status-after", "command": "status", "params": {}})
    commands.append({"id": "close", "command": "close", "params": {}})

    with tempfile.TemporaryDirectory(prefix="recaptcha-worker-smoke-") as cache_directory:
        environment = os.environ.copy()
        environment["VISION_AI_RECAPTCHA_CACHE_DIR"] = cache_directory
        completed = subprocess.run(
            [str(executable)],
            input="".join(json.dumps(command) + "\n" for command in commands),
            text=True,
            capture_output=True,
            env=environment,
            timeout=900,
            check=False,
        )

    if completed.returncode != 0:
        raise SystemExit(
            f"Native worker exited with {completed.returncode}.\n"
            f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
        )
    try:
        responses = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
    except json.JSONDecodeError as error:
        raise SystemExit(f"Native worker returned invalid JSON: {completed.stdout}") from error

    expected_count = len(commands)
    if len(responses) != expected_count:
        raise SystemExit(
            f"Native worker returned {len(responses)} responses; expected {expected_count}. "
            f"stderr: {completed.stderr}"
        )

    before = _require_success(responses[0], "status-before")
    if before.get("protocol_version") != PROTOCOL_VERSION:
        raise SystemExit(f"Unexpected worker protocol: {before}")
    if before.get("frozen") is not True:
        raise SystemExit(f"Staged worker is not a frozen native executable: {before}")

    if initialize:
        initialized = _require_success(responses[1], "initialize")
        if initialized.get("ready") is not True or initialized.get("warmup_completed") is not True:
            raise SystemExit(f"Native model initialization failed: {initialized}")
        after = _require_success(responses[2], "status-after")
        if after.get("models_loaded") is not True or after.get("state") != "ready":
            raise SystemExit(f"Native worker is not ready after initialization: {after}")

    closed = _require_success(responses[-1], "close")
    if closed.get("closed") is not True:
        raise SystemExit(f"Native worker did not close cleanly: {closed}")

    print(
        f"Verified native worker protocol for {platform_directory}"
        + (" with model warmup" if initialize else "")
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--platform",
        required=True,
        choices=("win32-x64", "linux-x64", "darwin-x64", "darwin-arm64"),
    )
    parser.add_argument("--initialize", action="store_true")
    parser.add_argument("--model-dir", type=Path)
    args = parser.parse_args()
    verify(args.platform, initialize=args.initialize, model_directory=args.model_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
