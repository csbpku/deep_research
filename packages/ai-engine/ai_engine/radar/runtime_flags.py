"""Runtime switches shared by radar sync and enrichment entrypoints."""

from __future__ import annotations

import os

_BROWSER_READING_MODES = frozenset({"browser", "external", "plugin"})
_TRUE_VALUES = frozenset({"1", "true", "yes", "on"})
_FALSE_VALUES = frozenset({"0", "false", "no", "off"})


def browser_reading_mode_enabled() -> bool:
    """Return whether full text is transient-only and user reading uses Reader."""
    return os.environ.get("RADAR_READING_MODE", "browser").strip().lower() in _BROWSER_READING_MODES


def radar_enrichment_enabled() -> bool:
    """Return whether any server-side radar enrichment may execute.

    The explicit switch is an emergency stop and wins over the reading mode.
    Without it, browser-reading mode still fetches source text transiently for
    sync-time summaries and scoring, but does not persist full text or run
    follow-up enrichment. The historical ``enriched`` mode is an explicit
    opt-in for server-side reader assets.
    """
    configured = os.environ.get("RADAR_ENRICHMENT_ENABLED")
    if configured is not None:
        normalized = configured.strip().lower()
        if normalized in _TRUE_VALUES:
            return True
        if normalized in _FALSE_VALUES:
            return False
    return not browser_reading_mode_enabled()


def enrichment_pause_reason() -> str:
    """Return a stable operator-facing explanation for a paused worker."""
    if os.environ.get("RADAR_ENRICHMENT_ENABLED", "").strip().lower() in _FALSE_VALUES:
        return "RADAR_ENRICHMENT_ENABLED=0"
    return "RADAR_READING_MODE=browser"


__all__ = [
    "browser_reading_mode_enabled",
    "enrichment_pause_reason",
    "radar_enrichment_enabled",
]
