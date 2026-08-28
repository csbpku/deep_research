"""P2.15 Semantic Scholar enrich — extract arxiv id + fetch paper metrics."""

from __future__ import annotations

import json

import httpx

from ai_engine.radar.semantic_scholar import (
    extract_arxiv_id,
    fetch_paper_metrics,
)


def test_extract_arxiv_id_handles_modern_and_legacy_id_shapes() -> None:
    # Modern YYMM.NNNNN
    assert extract_arxiv_id("https://arxiv.org/abs/2608.10720") == "2608.10720"
    # Versioned id
    assert extract_arxiv_id("https://arxiv.org/abs/2608.10720v2") == "2608.10720v2"
    # Legacy arch-ive/YYMMNNN
    assert extract_arxiv_id("https://arxiv.org/abs/cs.LG/0601001") == "cs.LG/0601001"
    # Empty / unrelated
    assert extract_arxiv_id("https://example.com/post") is None
    assert extract_arxiv_id(None) is None


def test_extract_arxiv_id_falls_back_to_canonical_and_body() -> None:
    # canonical URL contains id; main URL doesn't
    assert extract_arxiv_id(
        "https://example.com/post",
        canonical_url="https://huggingface.co/papers/2608.10720",
    ) == "2608.10720"
    # body contains id embedded as text
    assert extract_arxiv_id(
        "https://example.com/post",
        canonical_url="https://example.com/post",
        body="See paper at arxiv.org/abs/2608.10720 for details.",
    ) == "2608.10720"


async def test_fetch_paper_metrics_returns_counts_on_success() -> None:
    expected = {
        "data": {
            "paper": {
                "paperId": "ARXIV:2608.10720",
                "citationCount": 12,
                "referenceCount": 42,
                "influentialCitationCount": 3,
            }
        }
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert "query" in json.loads(request.content)  # graphql body
        return httpx.Response(200, json=expected)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        out = await fetch_paper_metrics("2608.10720", client=client)
    assert out["citationCount"] == 12
    assert out["referenceCount"] == 42
    assert out["influentialCitationCount"] == 3
    assert out["semanticScholarId"] == "ARXIV:2608.10720"


async def test_fetch_paper_metrics_returns_none_on_404() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": "not found"})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        out = await fetch_paper_metrics("0000.00000", client=client)
    assert out is None


async def test_fetch_paper_metrics_returns_none_on_rate_limit() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="rate limited")

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        out = await fetch_paper_metrics("2608.10720", client=client)
    assert out is None


async def test_fetch_paper_metrics_returns_none_on_malformed_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="not json")

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        out = await fetch_paper_metrics("2608.10720", client=client)
    assert out is None
