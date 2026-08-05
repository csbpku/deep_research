"""Regression tests for ``_resolve_ranked_links`` dedup behavior.

Background: the LLM occasionally emits two ranked entries that point at the
same radar candidate — for example, one with the candidate's real title and
another with a hallucinated title but the same URL. Before this fix, both
rows survived link resolution as identical ``(summaryId, url)`` tuples, which
the web client then rendered twice (and React warned about duplicate keys).
"""

from __future__ import annotations

from typing import Any

import pytest

from ai_engine.radar.daily_digest import _resolve_ranked_links


def _candidate(cid: str, url: str, title: str, canonical: str | None = None) -> dict[str, Any]:
    return {
        "id": cid,
        "url": url,
        "title": title,
        "canonicalUrl": canonical,
    }


def test_resolve_ranked_links_dedupes_same_candidate_twice() -> None:
    """Two LLM-emitted entries that resolve to the same candidate collapse to one."""
    swiftlet_url = "https://github.com/leonickson1/Swiftlet"
    swiftlet_id = "aab114c6-8054-4c1a-b21f-497a0ee95d54"
    candidates = [
        _candidate(swiftlet_id, swiftlet_url, "Swiftlet: Run 80B Qwen in 4.3 GB"),
    ]
    # LLM hallucinated a second entry with a different title but same URL
    digest = {
        "ranked": [
            {
                "title": "Swiftlet: Run 80B Qwen in 4.3 GB on Mac, 35B on iPhone",
                "url": swiftlet_url,
                "oneLineReason": "端侧 MoE 推理。",
            },
            {
                "title": "Frame selection is the whole game: notes on making LLMs watch video",
                "url": swiftlet_url,  # same URL — the failure mode we want to fix
                "oneLineReason": "另一条 LLM 自创的标题。",
            },
        ]
    }

    _resolve_ranked_links(digest, candidates)

    assert len(digest["ranked"]) == 1, (
        f"expected deduped single ranked entry, got {len(digest['ranked'])}: "
        f"{digest['ranked']}"
    )
    only = digest["ranked"][0]
    assert only["summaryId"] == swiftlet_id
    assert only["url"] == swiftlet_url
    assert only["radarUrl"] == f"/radar/{swiftlet_id}"


def test_resolve_ranked_links_keeps_distinct_candidates() -> None:
    """Dedup must not collapse genuinely different candidates."""
    candidates = [
        _candidate("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "https://example.com/a", "Article A"),
        _candidate("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "https://example.com/b", "Article B"),
        _candidate("cccccccc-cccc-cccc-cccc-cccccccccccc", "https://example.com/c", "Article C"),
    ]
    digest = {
        "ranked": [
            {"title": "Article A", "url": "https://example.com/a", "oneLineReason": "x"},
            {"title": "Article B", "url": "https://example.com/b", "oneLineReason": "y"},
            {"title": "Article C", "url": "https://example.com/c", "oneLineReason": "z"},
        ]
    }

    _resolve_ranked_links(digest, candidates)

    assert len(digest["ranked"]) == 3
    assert [r["summaryId"] for r in digest["ranked"]] == [
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        "cccccccc-cccc-cccc-cccc-cccccccccccc",
    ]


def test_resolve_ranked_links_dedupes_unresolved_by_url() -> None:
    """If two entries cannot be resolved to a candidate but share a URL, dedup by URL."""
    digest = {
        "ranked": [
            {"title": "Unknown article one", "url": "https://nowhere.example/x", "oneLineReason": "a"},
            {"title": "Unknown article two", "url": "https://nowhere.example/x", "oneLineReason": "b"},
            {"title": "Unknown article three", "url": "https://nowhere.example/y", "oneLineReason": "c"},
        ]
    }

    _resolve_ranked_links(digest, [])

    assert len(digest["ranked"]) == 2
    assert [r["url"] for r in digest["ranked"]] == [
        "https://nowhere.example/x",
        "https://nowhere.example/y",
    ]
    assert all(r["summaryId"] is None for r in digest["ranked"])


def test_resolve_ranked_links_first_occurrence_wins() -> None:
    """When deduplicating, keep the first ranked entry (LLM's primary pick)."""
    candidates = [
        _candidate("id-1", "https://example.com/x", "Real title"),
    ]
    digest = {
        "ranked": [
            {"title": "First pick with real title", "url": "https://example.com/x", "oneLineReason": "real"},
            {"title": "Hallucinated alternate title", "url": "https://example.com/x", "oneLineReason": "fake"},
        ]
    }

    _resolve_ranked_links(digest, candidates)

    assert len(digest["ranked"]) == 1
    assert digest["ranked"][0]["oneLineReason"] == "real"