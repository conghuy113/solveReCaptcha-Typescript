"""Resource allocation helpers for solver instances."""

from __future__ import annotations

import logging
import socket
import threading
import weakref
from pathlib import Path
from typing import Any

from vision_ai_recaptcha_solver.config import SolverConfig

# {solver: (server_port, download_dir)}, mapping of solver instances to their reserved resources
_ALLOCATIONS: weakref.WeakKeyDictionary[Any, tuple[int, Path]] = weakref.WeakKeyDictionary()
_LOCK = threading.Lock()


def _normalize_download_dir(path: Path) -> Path:
    try:
        return path.resolve(strict=False)
    except OSError:
        return path.absolute()


def _is_port_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def _pick_available_port(preferred: int, used_ports: set[int]) -> int:
    if preferred not in used_ports and _is_port_available(preferred):
        return preferred

    for _ in range(50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            candidate = int(sock.getsockname()[1])
        if candidate not in used_ports and _is_port_available(candidate):
            return candidate

    raise RuntimeError("Unable to allocate a free server port.")


def _pick_unique_download_dir(base: Path, used_dirs: set[Path]) -> Path:
    if _normalize_download_dir(base) not in used_dirs:
        return base

    for index in range(1, 1000):
        candidate = base.with_name(f"{base.name}-{index}")
        if _normalize_download_dir(candidate) not in used_dirs:
            return candidate

    raise RuntimeError("Unable to allocate a unique download directory.")


def reserve_solver_resources(
    solver: Any, config: SolverConfig, logger: logging.Logger | None = None
) -> None:
    """Reserve a server port and download directory for a solver."""
    with _LOCK:
        used_ports = {port for port, _ in _ALLOCATIONS.values()}
        used_dirs = {path for _, path in _ALLOCATIONS.values()}

        if config._server_port_explicit:
            if config.server_port in used_ports and logger:
                logger.warning(
                    "server_port %s is already in use by another running solver",
                    config.server_port,
                )
        else:
            if config.server_port in used_ports or not _is_port_available(config.server_port):
                new_port = _pick_available_port(config.server_port, used_ports)
                object.__setattr__(config, "server_port", new_port)
                if logger:
                    logger.info("Auto selected free server port: %s", new_port)

        normalized_dir = _normalize_download_dir(config.download_dir)
        if config._download_dir_explicit:
            if normalized_dir in used_dirs and logger:
                logger.warning(
                    "download_dir '%s' is already in use by another running solver",
                    config.download_dir,
                )
        else:
            if normalized_dir in used_dirs:
                new_dir = _pick_unique_download_dir(config.download_dir, used_dirs)
                object.__setattr__(config, "download_dir", new_dir)
                normalized_dir = _normalize_download_dir(new_dir)
                if logger:
                    logger.info("Auto selected unique download dir: %s", new_dir)

        _ALLOCATIONS[solver] = (config.server_port, normalized_dir)


def release_solver_resources(solver: Any) -> None:
    """Release reserved resources."""
    with _LOCK:
        _ALLOCATIONS.pop(solver, None)
