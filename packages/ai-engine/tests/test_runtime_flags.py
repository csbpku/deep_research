from __future__ import annotations

from ai_engine.radar.runtime_flags import (
    browser_reading_mode_enabled,
    radar_enrichment_enabled,
)


def test_browser_reading_mode_is_the_safe_default(monkeypatch) -> None:
    monkeypatch.delenv("RADAR_READING_MODE", raising=False)
    monkeypatch.delenv("RADAR_ENRICHMENT_ENABLED", raising=False)

    assert browser_reading_mode_enabled()
    assert not radar_enrichment_enabled()


def test_explicit_pause_wins_over_enriched_mode(monkeypatch) -> None:
    monkeypatch.setenv("RADAR_READING_MODE", "enriched")
    monkeypatch.setenv("RADAR_ENRICHMENT_ENABLED", "0")

    assert not browser_reading_mode_enabled()
    assert not radar_enrichment_enabled()


def test_enrichment_requires_an_explicit_rollback_or_enable_flag(monkeypatch) -> None:
    monkeypatch.setenv("RADAR_READING_MODE", "enriched")
    monkeypatch.delenv("RADAR_ENRICHMENT_ENABLED", raising=False)
    assert radar_enrichment_enabled()

    monkeypatch.setenv("RADAR_READING_MODE", "browser")
    monkeypatch.setenv("RADAR_ENRICHMENT_ENABLED", "1")
    assert radar_enrichment_enabled()
