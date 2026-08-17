# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

PROJECT_ROOT = Path(SPECPATH).parent.resolve()
PACKAGE_ROOT = PROJECT_ROOT / "src" / "vision_ai_recaptcha_solver"

datas = [
    (str(PACKAGE_ROOT / "assets" / "bus.jpg"), "vision_ai_recaptcha_solver/assets"),
]
binaries = []
hiddenimports = [
    # Both are imported dynamically to keep check_browser lightweight.
    "vision_ai_recaptcha_solver.solver",
    "onnxruntime",
]

a = Analysis(
    [str(PROJECT_ROOT / "main.py")],
    pathex=[str(PROJECT_ROOT), str(PROJECT_ROOT / "src")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "pytest",
        "mypy",
        "ruff",
        "IPython",
        "jupyter",
        "ultralytics",
        "torch",
        "torchvision",
        "onnx",
        "scipy",
        "matplotlib",
        "pandas",
        "polars",
        "tkinter",
        "cryptography",
        "lxml",
        "openpyxl",
        "aiohttp",
        "flask",
    ],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="recaptcha-solver-worker",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    contents_directory=".",
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="recaptcha-solver-worker",
)
