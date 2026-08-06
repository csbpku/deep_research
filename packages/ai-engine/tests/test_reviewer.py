from __future__ import annotations

from types import SimpleNamespace

import pytest

from ai_engine.adapters.base import AdapterSource
from ai_engine.contracts.states import AI_JOB_STEP
from ai_engine.reviewer import DefaultResearchReviewer


def _source(url: str) -> AdapterSource:
    return AdapterSource(
        source_ref={"type": "url", "value": url},
        canonical_key=url,
        title="source",
        snippet="captured evidence",
        score=1.0,
        step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
    )


async def _llm_pass(**_: object) -> SimpleNamespace:
    return SimpleNamespace(text='{"status":"passed","claims":[],"revision_instructions":[]}')


@pytest.mark.asyncio
async def test_stale_github_stars_are_correctable(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fetch(*_: object, **__: object) -> tuple[int, str, str]:
        return 2200, "https://api.github.com/repos/huangruiteng/loopx", "2026-08-06T00:00:00+00:00"

    monkeypatch.setattr("ai_engine.reviewer._fetch_github_stars", fetch)
    monkeypatch.setattr("ai_engine.reviewer.generate_text", _llm_pass)

    result = await DefaultResearchReviewer().review(
        "loopx 有 181 Star。",
        (_source("https://github.com/huangruiteng/loopx"),),
        "loopx",
    )

    assert result.status == "needs_revision"
    assert result.claims[0].verdict == "correctable"
    assert result.claims[0].correction == "2,200"
    assert result.claims[0].evidence is not None
    assert result.claims[0].evidence.source_url.endswith("huangruiteng/loopx")


@pytest.mark.asyncio
async def test_corrected_github_stars_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fetch(*_: object, **__: object) -> tuple[int, str, str]:
        return 2200, "https://api.github.com/repos/huangruiteng/loopx", "2026-08-06T00:00:00+00:00"

    monkeypatch.setattr("ai_engine.reviewer._fetch_github_stars", fetch)
    monkeypatch.setattr("ai_engine.reviewer.generate_text", _llm_pass)

    result = await DefaultResearchReviewer().review(
        "loopx 有 2.2k stars。",
        (_source("https://github.com/huangruiteng/loopx"),),
        "loopx",
    )

    assert result.status == "passed"
    assert result.claims[0].verdict == "verified"


@pytest.mark.asyncio
async def test_github_license_and_forks_use_same_authoritative_resolver(monkeypatch: pytest.MonkeyPatch) -> None:
    async def resolve(_: str) -> SimpleNamespace:
        return SimpleNamespace(
            resolver="github.repository",
            source_url="https://api.github.com/repos/huangruiteng/loopx",
            excerpt='{"forks_count":120,"license":"Apache-2.0"}',
            observed_at="2026-08-06T00:00:00+00:00",
            fields={"forks_count": 120, "license": "Apache-2.0"},
        )

    monkeypatch.setattr("ai_engine.reviewer.resolve_github_repository", resolve)
    monkeypatch.setattr("ai_engine.reviewer.generate_text", _llm_pass)
    result = await DefaultResearchReviewer().review(
        "loopx 有 120 forks，许可证 Apache-2.0。",
        (_source("https://github.com/huangruiteng/loopx"),),
        "loopx",
    )
    assert result.status == "passed"
    assert {claim.verdict for claim in result.claims} == {"verified"}
    assert all(claim.evidence and claim.evidence.resolver == "github.repository" for claim in result.claims)


@pytest.mark.asyncio
async def test_github_api_failure_is_unverified_without_guessing(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fetch(*_: object, **__: object) -> None:
        return None

    monkeypatch.setattr("ai_engine.reviewer._fetch_github_stars", fetch)
    result = await DefaultResearchReviewer().review(
        "loopx 有 181 Star。",
        (_source("https://github.com/huangruiteng/loopx"),),
        "loopx",
    )

    assert result.claims[0].verdict == "unverified"
    assert result.claims[0].correction is None
    assert "API 不可用" in (result.claims[0].reason or "")


@pytest.mark.asyncio
async def test_multiple_repositories_are_not_cross_matched(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fail_if_called(*_: object, **__: object) -> None:
        raise AssertionError("ambiguous repositories must not call a resolver")

    monkeypatch.setattr("ai_engine.reviewer._fetch_github_stars", fail_if_called)
    result = await DefaultResearchReviewer().review(
        "loopx 有 181 Star。",
        (
            _source("https://github.com/huangruiteng/loopx"),
            _source("https://github.com/example/other"),
        ),
        "loopx",
    )

    assert result.claims[0].verdict == "unverified"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("verdict", "expected_status"),
    [("unsupported", "needs_revision"), ("contradicted", "blocked"), ("not_applicable", "passed")],
)
async def test_llm_citation_and_opinion_verdicts_are_preserved(
    monkeypatch: pytest.MonkeyPatch,
    verdict: str,
    expected_status: str,
) -> None:
    async def review(**_: object) -> SimpleNamespace:
        return SimpleNamespace(
            text=(
                '{"status":"passed","claims":['
                f'{{"claim_id":"claim-1","claim":"项目很流行","risk":"opinion","verdict":"{verdict}",'
                '"reason":"来源正文未直接支持"}],"revision_instructions":[]}'
            )
        )

    monkeypatch.setattr("ai_engine.reviewer.generate_text", review)
    result = await DefaultResearchReviewer().review(
        "项目很流行。",
        (_source("https://example.com/source"),),
        "项目",
    )

    assert result.status == expected_status
    assert result.claims[0].verdict == verdict
