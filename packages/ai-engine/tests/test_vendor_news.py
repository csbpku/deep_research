"""PR5: vendor_news YAML loader + source-URL picker regression tests."""

from __future__ import annotations

from pathlib import Path
from datetime import datetime, timedelta, timezone

import pytest

from ai_engine.radar.vendor_news_fetcher import (
    _coerce_utc,
    _load_vendor_configs,
    _vendor_source_url,
    check_and_fetch_vendor_news,
)


CONFIG_PATH = Path(__file__).resolve().parents[2] / "configs" / "vendor_news.yml"


def test_vendor_yaml_loads_with_all_required_vendors() -> None:
    """The shipped YAML must include Anthropic + OpenAI (legacy) plus the
    four new vendors added in this PR.

    Note: Mistral was removed in the firewall cleanup commit ``febd392``
    because the smoke test could not reach mistral.ai from the deploy
    environment. We assert it is absent here so the cleanup sticks.
    """

    configs = _load_vendor_configs()
    assert "anthropic" in configs
    assert "openai" in configs
    assert "google_deepmind" in configs
    assert "xai" in configs
    assert "huggingface_blog" in configs
    assert "mistral" not in configs, "mistral.ai removed in febd392"
    # Each remaining vendor must surface a usable source URL and a url pattern.
    for key in ("anthropic", "openai", "google_deepmind", "xai", "huggingface_blog"):
        cfg = configs[key]
        assert cfg["url_pattern"], cfg
        assert cfg["rss_url"] or cfg["sitemap_url"], cfg
        assert cfg["tags"], cfg
        assert cfg["quality_hint"] > 0, cfg
    # Anthropic research pages live under /research/ and must not be dropped
    # by the sitemap filter (regression: automated-researchers-mitigate-*).
    assert "/research/" in configs["anthropic"]["url_pattern"]


def test_vendor_yaml_quality_hints_are_in_unit_interval() -> None:
    configs = _load_vendor_configs()
    for cfg in configs.values():
        assert 0.0 < cfg["quality_hint"] <= 1.0, cfg


def test_vendor_source_url_prefers_rss_over_sitemap() -> None:
    cfg = {
        "rss_url": "https://example.com/rss.xml",
        "sitemap_url": "https://example.com/sitemap.xml",
    }
    assert _vendor_source_url(cfg) == "https://example.com/rss.xml"


def test_vendor_source_url_falls_back_to_sitemap() -> None:
    cfg = {"sitemap_url": "https://example.com/sitemap.xml"}
    assert _vendor_source_url(cfg) == "https://example.com/sitemap.xml"


def test_vendor_source_url_raises_when_neither_is_set() -> None:
    cfg = {"name": "broken"}
    with pytest.raises(ValueError, match="rss_url and sitemap_url"):
        _vendor_source_url(cfg)


def test_vendor_yaml_uses_environment_override_path(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Operators can point the loader at a fork via VENDOR_NEWS_CONFIG_PATH."""
    custom = tmp_path / "vendor_news.yml"
    custom.write_text(
        "vendors:\n"
        "  anthropic:\n"
        "    name: Anthropic\n"
        "    sitemap_url: https://www.anthropic.com/sitemap.xml\n"
        "    url_pattern: '/news/'\n"
        "    quality_hint: 0.9\n"
        "    tags: [vendor, anthropic]\n"
        "    max_age_hours: 72\n"
        "  openai:\n"
        "    name: OpenAI\n"
        "    rss_url: https://openai.com/news/rss.xml\n"
        "    url_pattern: '/news/'\n"
        "    quality_hint: 0.9\n"
        "    tags: [vendor, openai]\n"
        "    max_age_hours: 72\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("VENDOR_NEWS_CONFIG_PATH", str(custom))
    # lru_cache is process-wide; restart by reimporting the loader.
    _load_vendor_configs.cache_clear()
    try:
        configs = _load_vendor_configs()
        assert "mistral" not in configs, "Override file should replace the default; mistral must be absent"
        assert configs["openai"]["rss_url"] == "https://openai.com/news/rss.xml"
    finally:
        _load_vendor_configs.cache_clear()
        # Reload from default path so the next test gets the real config.
        _load_vendor_configs()


def test_coerce_utc_parses_sitemap_lastmod() -> None:
    parsed = _coerce_utc("2026-08-30T00:00:00.000Z")
    assert parsed is not None
    assert parsed == datetime(2026, 8, 30, tzinfo=timezone.utc)
    assert parsed.tzinfo is not None


def test_coerce_utc_assumes_utc_for_naive_dates() -> None:
    parsed = _coerce_utc("2026-08-30")
    assert parsed is not None
    assert parsed == datetime(2026, 8, 30, tzinfo=timezone.utc)


def test_coerce_utc_rejects_garbage() -> None:
    assert _coerce_utc("") is None
    assert _coerce_utc("not-a-date") is None


class _FakeResponse:
    def __init__(self, text: str) -> None:
        self.text = text

    def raise_for_status(self) -> None:
        return None


class _FakeClient:
    def __init__(self) -> None:
        self.fetched: list[str] = []

    async def get(self, url: str, **kwargs: object) -> _FakeResponse:
        self.fetched.append(url)
        return _FakeResponse(
            "<html><body>"
            "Automated researchers can reliably mitigate alignment failures. "
            "This is a longer synthetic article body used to satisfy the "
            "vendor fetcher minimum-length guard while exercising the "
            "sitemap lastmod time-window filter end to end."
            "</body></html>"
        )


@pytest.mark.asyncio
async def test_fetch_applies_lastmod_window_to_sitemap_only_vendor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without RSS pubDate, <lastmod> must bound the fetch window so enabling
    /research/ does not pull the whole research archive in one sync."""
    now = datetime.now(timezone.utc)
    old = (now - timedelta(days=30)).isoformat()
    recent = (now - timedelta(hours=12)).isoformat()
    sitemap = f"""
    <urlset>
      <url><loc>https://www.anthropic.com/research/old</loc><lastmod>{old}</lastmod></url>
      <url><loc>https://www.anthropic.com/research/recent</loc><lastmod>{recent}</lastmod></url>
      <url><loc>https://www.anthropic.com/news/some-news</loc><lastmod>{recent}</lastmod></url>
    </urlset>
    """
    async def fake_sitemap(url: str, *, client: object) -> str:
        return sitemap

    monkeypatch.setattr("ai_engine.radar.vendor_news_fetcher._fetch_sitemap", fake_sitemap)
    monkeypatch.setattr(
        "ai_engine.radar.vendor_news_fetcher._load_state",
        lambda: {},
    )
    saved: dict[str, object] = {}
    monkeypatch.setattr(
        "ai_engine.radar.vendor_news_fetcher._save_state",
        lambda state: saved.update(state),
    )

    client = _FakeClient()
    candidates = await check_and_fetch_vendor_news(
        "anthropic",
        lookback_hours=72,
        client=client,  # type: ignore[arg-type]
    )

    assert client.fetched == [
        "https://www.anthropic.com/research/recent",
        "https://www.anthropic.com/news/some-news",
    ]
    assert len(candidates) == 2
    assert all("old" not in c.url for c in candidates)
    assert saved["anthropic"]  # state persisted with current urls
