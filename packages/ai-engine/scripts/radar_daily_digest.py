"""CLI wrapper for the radar daily digest generator.

The implementation lives in ai_engine/radar/daily_digest.py so the FastAPI
server can generate a digest after a radar sync without importing scripts.

Usage:
  cd packages/ai-engine
  uv run python scripts/radar_daily_digest.py --date 2026-07-31
  uv run python scripts/radar_daily_digest.py --date 2026-07-31 --dry-run
"""

# ruff: noqa: E402
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

from ai_engine.radar.daily_digest import main


if __name__ == "__main__":
    raise SystemExit(main())
