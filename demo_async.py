from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
SRC_PATH = ROOT / "src"
if SRC_PATH.exists():
    sys.path.insert(0, str(SRC_PATH))

import asyncio
import time

from vision_ai_recaptcha_solver import AsyncRecaptchaSolver, SolverConfig

async def solve_single(solver: AsyncRecaptchaSolver, name: str) -> dict:
    """Solve a single captcha and return info."""
    start = time.time()
    print(f"[{name}] Starting solve...")
    
    result = await solver.solve(
        website_key="6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-",
        website_url="https://www.google.com/recaptcha/api2/demo"
    )
    
    elapsed = round(time.time() - start, 2)
    print(f"[{name}] Completed in {elapsed}s - Type: {result.captcha_type.value}")
    
    return {
        "name": name,
        "token": result.token[:50] + "...",
        "time": elapsed,
        "attempts": result.attempts,
    }

async def demo_concurrent_solving():
    """Solving multiple captchas concurrently."""
    
    # Each solver needs its own port and download_dir to avoid conflicts
    config1 = SolverConfig(
        log_level="INFO",
        timeout=180,
        server_port=8443,
        download_dir=Path("tmp1"),
    )
    
    config2 = SolverConfig(
        log_level="INFO",
        timeout=180,
        server_port=8444,
        download_dir=Path("tmp2"),
    )

    print("=" * 30)
    print("Concurrent captcha solving demo")
    print("=" * 30)
    
    total_start = time.time()

    async with AsyncRecaptchaSolver(config1) as solver1, \
               AsyncRecaptchaSolver(config2) as solver2:
        print("\nLaunching 2 concurrent captcha solves...\n")
        
        results = await asyncio.gather(
            solve_single(solver1, "Captcha-1"),
            solve_single(solver2, "Captcha-2"),
        )

    total_time = round(time.time() - total_start, 2)
    
    print("\n" + "=" * 30)
    print("RESULTS")
    print("=" * 30)
    
    sequential_time = sum(r["time"] for r in results)
    
    for r in results:
        print(f"\n{r['name']}:")
        print(f"  Token: {r['token']}")
        print(f"  Time: {r['time']}s")
        print(f"  Attempts: {r['attempts']}")
    
    print(f"\n{'-' * 40}")
    print(f"Total wall clock time: {total_time}s")
    print(f"Sum of individual times: {sequential_time}s")
    print(f"Time saved by concurrency: {round(sequential_time - total_time, 2)}s")
    print(f"Speedup: {round(sequential_time / total_time, 2)}x faster!")
    print("=" * 30)


async def demo_with_other_tasks():
    """Doing other work while captcha solves."""
    
    config = SolverConfig(
        log_level="INFO",
        timeout=180,
    )

    print("=" * 30)
    print("Non blocking operations demo")
    print("=" * 30)
    
    async with AsyncRecaptchaSolver(config) as solver:
        print("\nStarting captcha solve in background...")
        captcha_task = asyncio.create_task(
            solver.solve(
                website_key="6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-",
                website_url="https://www.google.com/recaptcha/api2/demo"
            )
        )
        
        print("Doing other work while captcha solves...")
        for i in range(5):
            await asyncio.sleep(2)
            print(f"...still working on other tasks while solving ({i+1}/5)")
        
        print("\nTasks finished, waiting for captcha result...")
        result = await captcha_task
        
        print(f"\nCaptcha solved!")
        print(f"   Token: {result.token[:50]}...")
        print(f"   Time: {result.time_taken}s")


if __name__ == "__main__":
    print("\nChoose demo:")
    print("1. Concurrent solving (2 captchas at once)")
    print("2. Non-blocking (do work while solving)")
    
    choice = input("\nEnter choice (1 or 2): ").strip()
    
    if choice == "2":
        asyncio.run(demo_with_other_tasks())
    else:
        asyncio.run(demo_concurrent_solving())
