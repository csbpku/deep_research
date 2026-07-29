"""Test configuration — load `.env` if present, set defaults that make
unit tests runnable without a real Postgres.

`DATABASE_URL` is required for the DbJobStore constructor to even return;
we default to the local dev DB so tests that *do* want to hit the DB can.
The `requires_db` pytest marker (declared in pyproject.toml below) skips
tests that hit Postgres when no DB is reachable.
"""

from __future__ import annotations

import os
from pathlib import Path

# Load .env so DATABASE_URL is set in test env.
ROOT = Path(__file__).resolve().parent.parent
_ENV_PATH = ROOT / ".env"
if _ENV_PATH.exists():
    for line in _ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value

# Sane default if .env doesn't ship DATABASE_URL (CI without local DB).
os.environ.setdefault(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/deep_research"
)
# Default in-memory backend for unit tests; DB tests opt in via marker.
# Force-override: a local `.env` may set JOB_RUNNER_BACKEND=db for runtime;
# setdefault would silently flip the unit suite onto DbJobStore.
os.environ["JOB_RUNNER_BACKEND"] = "memory"
os.environ["AI_ENGINE_ADAPTER"] = "fake"  # tests always use fake adapter