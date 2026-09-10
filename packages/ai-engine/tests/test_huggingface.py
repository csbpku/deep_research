from __future__ import annotations

import httpx
import pytest

from ai_engine.radar.huggingface import (
    huggingface_endpoint,
    rewrite_huggingface_url,
)
from ai_engine.radar.huggingface_fetcher import fetch_huggingface_models


def test_huggingface_urls_use_configured_mirror(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HUGGINGFACE_BASE_URL", "https://hf-mirror.com/")

    assert huggingface_endpoint("/api/models") == "https://hf-mirror.com/api/models"
    assert rewrite_huggingface_url(
        "https://huggingface.co/blog/example?x=1"
    ) == "https://hf-mirror.com/blog/example?x=1"
    assert rewrite_huggingface_url("https://example.com/article") == (
        "https://example.com/article"
    )


@pytest.mark.asyncio
async def test_huggingface_models_retry_transient_upstream_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        assert request.url.host == "hf-mirror.com"
        if calls == 1:
            return httpx.Response(503, request=request)
        return httpx.Response(
            200,
            request=request,
            json=[{"id": "org/model", "likes": 10, "downloads": 20}],
        )

    monkeypatch.setenv("HUGGINGFACE_BASE_URL", "https://hf-mirror.com")
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        candidates = await fetch_huggingface_models(
            {"max_results": 1, "timeoutSeconds": 5, "retries": 1},
            client=client,
        )

    assert calls == 2
    assert candidates[0].url == "https://huggingface.co/org/model"
