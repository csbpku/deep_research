"""P1.6: tiered radar scheduling — per-source polling interval resolution."""

from __future__ import annotations

import pytest

from ai_engine.server.app import (
    _RADAR_DEFAULT_TIER_MINUTES,
    _radar_polling_interval_minutes,
)


def test_default_tier_map_covers_every_active_source_type() -> None:
    """Every sourceType that the platform ships in seed.sql has a tier."""
    expected = {
        "github", "github_trending", "github_tracked", "arxiv", "rss",
        "hackernews", "hn_algolia", "reddit", "lobsters", "devto",
        "producthunt", "vendor_news", "vendor_changelog",
        "github_topic_search", "huggingface_models", "huggingface_papers",
        "openreview", "wechat", "sitemap_watch",
    }
    missing = expected - set(_RADAR_DEFAULT_TIER_MINUTES.keys())
    assert not missing, f"missing tier defaults: {missing}"


@pytest.mark.parametrize(
    "source_type,expected_minutes",
    [
        ("hn_algolia", 30),
        ("huggingface_papers", 30),
        ("vendor_changelog", 60),
        ("vendor_news", 60),
        ("arxiv", 60),
        ("huggingface_models", 120),
        ("reddit", 120),
        ("github_tracked", 720),
        ("sitemap_watch", 360),
    ],
)
def test_default_tier_assigns_expected_minutes(
    source_type: str, expected_minutes: int
) -> None:
    assert _radar_polling_interval_minutes(source_type, {}) == expected_minutes


def test_explicit_config_overrides_default_tier() -> None:
    # Vendor news is tier-default 60min; an explicit override trumps that.
    assert _radar_polling_interval_minutes("vendor_news", {"pollingIntervalMinutes": 15}) == 15


def test_unknown_source_type_falls_back_to_60() -> None:
    """A source we don't know about still polls hourly."""
    assert _radar_polling_interval_minutes("future_source_type", {}) == 60


def test_explicit_interval_is_clamped_to_safe_range() -> None:
    # 1-minute polling would hammer public APIs; clamp to floor 5.
    too_short = _radar_polling_interval_minutes("arxiv", {"pollingIntervalMinutes": 1})
    assert too_short >= 5
    # 25h polling defeats the daily cron; clamp to ceiling 1440 (24h).
    too_long = _radar_polling_interval_minutes("arxiv", {"pollingIntervalMinutes": 25 * 60})
    assert too_long <= 24 * 60


def test_garbage_config_value_is_dropped() -> None:
    """Strings, negatives, zero all fall back to the tier default."""
    # Negative / zero falls through to the tier default (60 for vendor_news)
    assert _radar_polling_interval_minutes("vendor_news", {"pollingIntervalMinutes": 0}) == 60
    assert _radar_polling_interval_minutes("vendor_news", {"pollingIntervalMinutes": -5}) == 60
    # String that isn't an int — same.
    assert _radar_polling_interval_minutes("vendor_news", {"pollingIntervalMinutes": "soon"}) == 60
