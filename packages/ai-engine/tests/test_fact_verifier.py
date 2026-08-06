from __future__ import annotations

import httpx

from ai_engine.adapters.base import AdapterSource
from ai_engine.contracts.states import AI_JOB_STEP
from ai_engine.fact_verifier import verify_github_star_claims


def _source(url: str) -> AdapterSource:
    return AdapterSource(
        source_ref={"type": "url", "value": url},
        canonical_key=url,
        title="GitHub",
        snippet="repo",
        score=1.0,
        step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
    )


async def test_corrects_stale_github_star_count() -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            json={"stargazers_count": 2200},
            request=request,
        )
    )
    async with httpx.AsyncClient(transport=transport) as client:
        result = await verify_github_star_claims(
            "项目目前有 181 Star。",
            [_source("https://github.com/huangruiteng/loopx")],
            client=client,
        )

    assert result.report == "项目目前有 2,200 Star。"
    assert result.checked == 1
    assert result.corrected == 1


async def test_accepts_compact_count_when_it_matches() -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            json={"stargazers_count": 2200},
            request=request,
        )
    )
    async with httpx.AsyncClient(transport=transport) as client:
        result = await verify_github_star_claims(
            "项目约有 2.2k stars。",
            [_source("https://github.com/huangruiteng/loopx")],
            client=client,
        )

    assert result.report == "项目约有 2.2k stars。"
    assert result.checked == 1
    assert result.corrected == 0


async def test_api_failure_does_not_invent_a_value() -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(503, request=request)
    )
    async with httpx.AsyncClient(transport=transport) as client:
        result = await verify_github_star_claims(
            "项目目前有 181 Star。",
            [_source("https://github.com/huangruiteng/loopx")],
            client=client,
        )

    assert result.report == "项目目前有 181 Star。"
    assert result.checked == 0
    assert result.unavailable == 1
