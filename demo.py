from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
SRC_PATH = ROOT / "src"
if SRC_PATH.exists():
    sys.path.insert(0, str(SRC_PATH))

from vision_ai_recaptcha_solver import RecaptchaSolver, SolverConfig

config = SolverConfig(
    timeout=180,
)

with RecaptchaSolver(config) as solver:
    result = solver.solve(
        website_key="6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-",
        website_url="https://www.google.com/recaptcha/api2/demo"
    )

    print(f"Token 1: {result.token[:50]}...")
    print(f"Time: {result.time_taken}s")
    print(f"Type: {result.captcha_type.value}")
    print(f"Attempts: {result.attempts}")
