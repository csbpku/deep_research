"""Feed bodies that look like URLs/paths must be parsed as XML, never fetched."""

from __future__ import annotations

from pathlib import Path

import pytest

from ai_engine.ingestion.sources import _parse_via_feedparser

RSS = (
    '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>'
    "<item><title>Hello 世界</title><link>https://example.com/a</link></item>"
    "</channel></rss>"
)


def test_valid_rss_still_parsed() -> None:
    items = _parse_via_feedparser(RSS)
    assert items and items[0]["title"] == "Hello 世界"


def test_url_body_is_not_fetched(monkeypatch: pytest.MonkeyPatch) -> None:
    import urllib.request

    def boom(*args: object, **kwargs: object) -> None:
        raise AssertionError("feedparser attempted a network fetch")

    monkeypatch.setattr(urllib.request.OpenerDirector, "open", boom)
    assert _parse_via_feedparser("http://127.0.0.1:9999/internal/admin.xml") == []


def test_path_body_is_not_read(tmp_path: Path) -> None:
    secret = tmp_path / "secret.xml"
    secret.write_text(RSS.replace("Hello", "LOCAL FILE"), encoding="utf-8")
    assert _parse_via_feedparser(str(secret)) == []
