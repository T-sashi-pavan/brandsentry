"""Central logging setup. Every module does `logger = logging.getLogger(__name__)`
and calls `.debug/.info/.warning/.error/.exception(...)` — none of that has any
effect until this is applied, since Python's logging defaults to WARNING on
the root logger with no formatter/handler configured. Call configure_logging()
once, at process startup (see app/main.py), before anything else logs.
"""
import logging
import sys

_LEVEL_NAMES = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}

# Third-party libraries that log wire-level detail (full prompt text, raw
# HTTP headers/cookies) at INFO/DEBUG — always silenced to WARNING, even when
# our own LOG_LEVEL is DEBUG. "DEBUG for our pipeline" should never mean
# "dump every HTTP request body and response header from every dependency";
# that's rarely wanted and occasionally sensitive (session cookies etc.). The
# Anthropic SDK's vendored HTTP client logs under "httpx2"/"httpcore2", not
# the plain "httpx"/"httpcore" names, so both are listed. "boto3"/"botocore"
# cover the AWS SDK used for the Bedrock Titan embeddings client and the
# AsyncAnthropicBedrock SigV4 path.
_NOISY_THIRD_PARTY_LOGGERS = ("httpx", "httpx2", "httpcore", "httpcore2", "anthropic", "boto3", "botocore", "playwright", "asyncio")


def configure_logging(level: str) -> None:
    if sys.platform == "win32":
        try:
            if hasattr(sys.stdout, "reconfigure"):
                sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            if hasattr(sys.stderr, "reconfigure"):
                sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    level_name = (level or "INFO").upper()
    if level_name not in _LEVEL_NAMES:
        level_name = "INFO"
    numeric_level = getattr(logging, level_name)

    root = logging.getLogger()
    root.setLevel(numeric_level)
    root.handlers.clear()

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(
        fmt="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    ))
    root.addHandler(handler)

    for name in _NOISY_THIRD_PARTY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)

    logging.getLogger(__name__).info("Logging configured at %s level", level_name)
