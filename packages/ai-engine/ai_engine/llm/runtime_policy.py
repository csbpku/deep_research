"""Local model execution is an explicit, budgeted opt-in."""

from __future__ import annotations

import os
import sys


class LiveModelCallsDisabled(RuntimeError):
    pass


def ensure_live_calls_allowed() -> None:
    environment = os.environ.get("LLM_RUNTIME_ENV", "development").lower()
    if environment == "production":
        return
    # Unit tests exercise SDK adapters with fakes. conftest independently
    # blocks outbound network traffic, including native research SDK calls.
    if environment == "test" and "pytest" in sys.modules and os.environ.get("PYTEST_CURRENT_TEST"):
        return
    if os.environ.get("LLM_ALLOW_LIVE_CALLS", "0").lower() not in {"1", "true", "yes"}:
        raise LiveModelCallsDisabled(
            "Local live model calls are disabled; use a dedicated test credential, "
            "set LLM_ALLOW_LIVE_CALLS=1 and an explicit LLM_TOKEN_BUDGET_PLATFORM_DAILY_LIMIT"
        )
    if int(os.environ.get("LLM_TOKEN_BUDGET_PLATFORM_DAILY_LIMIT", "0")) < 1:
        raise LiveModelCallsDisabled("Local live model calls require a positive daily token budget")
