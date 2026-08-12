"""PR5: vendor_news YAML loader + source-URL picker regression tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from ai_engine.radar.vendor_news_fetcher import _load_vendor_configs, _vendor_source_url


CONFIG_PATH = Path(__file__).resolve().parents[2] / "configs" / "vendor_news.yml"


def test_vendor_yaml_loads_with_all_required_vendors() -> None:
    """The shipped YAML must include Anthropic + OpenAI (legacy) plus the
    four new vendors added in this PR."""

    configs = _load_vendor_configs()
    assert "anthropic" in configs
    assert "openai" in configs
    assert "google_deepmind" in configs
    assert "mistral" in configs
    assert "xai" in configs
    assert "huggingface_blog" in configs
    # Each must surface a usable source URL and a url pattern.
    for key in ("anthropic", "openai", "google_deepmind", "mistral", "xai", "huggingface_blog"):
        cfg = configs[key]
        assert cfg["url_pattern"], cfg
        assert cfg["rss_url"] or cfg["sitemap_url"], cfg
        assert cfg["tags"], cfg
        assert cfg["quality_hint"] > 0, cfg


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
