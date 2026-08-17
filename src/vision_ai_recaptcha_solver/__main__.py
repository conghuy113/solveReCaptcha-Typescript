"""CLI."""

from __future__ import annotations

import json
import sys

import click

from vision_ai_recaptcha_solver import __version__
from vision_ai_recaptcha_solver.config import SolverConfig
from vision_ai_recaptcha_solver.exceptions import RecaptchaSolverError
from vision_ai_recaptcha_solver.logging_config import setup_logging
from vision_ai_recaptcha_solver.solver import RecaptchaSolver


@click.group()
@click.version_option(version=__version__, prog_name="recaptcha-solver")
@click.option(
    "--log-level",
    type=click.Choice(["DEBUG", "INFO", "WARNING", "ERROR"], case_sensitive=False),
    default="INFO",
    help="Set the logging level.",
)
@click.pass_context
def cli(ctx: click.Context, log_level: str) -> None:
    """VisionAIRecaptchaSolver.

    Solve reCAPTCHA challenges using YOLO object detection.
    """
    ctx.ensure_object(dict)
    ctx.obj["log_level"] = log_level
    setup_logging(log_level, "vision_ai_recaptcha_solver")


@cli.command()
@click.option("--website-key", "-k", required=True, help="The reCAPTCHA site key.")
@click.option("--website-url", "-u", required=True, help="The URL containing the captcha.")
@click.option("--proxy", "-p", default=None, help="Proxy URL (protocol://user:pass@host:port).")
@click.option("--browser-path", "-b", default=None, help="Path to Chromium executable.")
@click.option(
    "--headless/--no-headless",
    default=False,
    help="Run browser in headless mode.",
)
@click.option(
    "--timeout",
    "-t",
    type=float,
    default=350.0,
    help="Maximum time in seconds to wait for token.",
)
@click.option(
    "--invisible",
    is_flag=True,
    default=False,
    help="Solve invisible reCAPTCHA.",
)
@click.option("--action", default=None, help="Action name for invisible reCAPTCHA.")
@click.option(
    "--enterprise",
    is_flag=True,
    default=False,
    help="Solve enterprise reCAPTCHA.",
)
@click.option(
    "--api-domain",
    type=click.Choice(["google.com", "recaptcha.net"]),
    default="google.com",
    help="API domain to use.",
)
@click.option(
    "--output",
    "-o",
    type=click.Choice(["json", "text"]),
    default="text",
    help="Output format.",
)
@click.pass_context
def solve(
    ctx: click.Context,
    website_key: str,
    website_url: str,
    proxy: str | None,
    browser_path: str | None,
    headless: bool,
    timeout: float,
    invisible: bool,
    action: str | None,
    enterprise: bool,
    api_domain: str,
    output: str,
) -> None:
    """Solve a reCAPTCHA challenge and print the token."""
    log_level = ctx.obj.get("log_level", "INFO")

    config = SolverConfig(
        proxy=proxy,
        browser_path=browser_path,
        headless=headless,
        timeout=timeout,
        log_level=log_level,
    )

    try:
        with RecaptchaSolver(config) as solver:
            result = solver.solve(
                website_key=website_key,
                website_url=website_url,
                is_invisible=invisible,
                action=action,
                is_enterprise=enterprise,
                api_domain=api_domain,
            )

        if output == "json":
            output_data = {
                "token": result.token,
                "time_taken": result.time_taken,
                "captcha_type": result.captcha_type.value,
                "attempts": result.attempts,
                "cookies": result.cookies,
            }
            click.echo(json.dumps(output_data, indent=2))
        else:
            click.echo(f"Token: {result.token}")
            click.echo(f"Time: {result.time_taken}s")
            click.echo(f"Type: {result.captcha_type.value}")
            click.echo(f"Attempts: {result.attempts}")

        sys.exit(0)

    except KeyboardInterrupt:
        click.echo("\nInterrupted.", err=True)
        sys.exit(130)

    except RecaptchaSolverError as e:
        click.echo(f"Error: {e.message}", err=True)
        sys.exit(2)


@cli.command()
@click.option(
    "--headless/--no-headless",
    default=False,
    help="Run browser in headless mode.",
)
@click.pass_context
def demo(ctx: click.Context, headless: bool) -> None:
    """Run a demo solve using Google's test reCAPTCHA."""
    log_level = ctx.obj.get("log_level", "INFO")

    demo_key = "6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-"
    demo_url = "https://www.google.com/recaptcha/api2/demo"

    click.echo("Starting demo solve...")
    click.echo(f"Site Key: {demo_key}")
    click.echo(f"URL: {demo_url}")
    click.echo()

    config = SolverConfig(
        headless=headless,
        log_level=log_level,
        verbose=log_level == "DEBUG",
    )

    try:
        with RecaptchaSolver(config) as solver:
            result = solver.solve(
                website_key=demo_key,
                website_url=demo_url,
            )

        click.echo()
        click.echo("Demo completed successfully!")
        click.echo(f"Token: {result.token[:50]}...")
        click.echo(f"Time: {result.time_taken}s")
        click.echo(f"Captcha Type: {result.captcha_type.value}")
        click.echo(f"Attempts: {result.attempts}")

        sys.exit(0)

    except KeyboardInterrupt:
        click.echo("\nInterrupted.", err=True)
        sys.exit(130)

    except RecaptchaSolverError as e:
        click.echo(f"Error: {e.message}", err=True)
        sys.exit(2)


def main() -> None:
    """Entry point."""
    cli()


if __name__ == "__main__":
    main()
