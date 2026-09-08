from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from ai_engine.adapters.base import AdapterSource
from ai_engine.contracts.states import AI_JOB_STEP
from ai_engine.reviewer import (
    DefaultResearchReviewer,
    _citation_ledger,
    _extract_json_object,
    _parse_review_payload,
    _reconcile_unbound_evidence,
    _review_source_text,
)


def _source(url: str) -> AdapterSource:
    return AdapterSource(
        source_ref={"type": "url", "value": url},
        canonical_key=url,
        title="source",
        snippet="captured evidence",
        score=1.0,
        step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
    )


def _discovered_source(url: str) -> AdapterSource:
    return AdapterSource(
        source_ref={"type": "url", "value": url},
        canonical_key=url,
        title="discovered only",
        snippet=None,
        score=1.0,
        step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
        evidence_status="discovered",
    )


def test_review_parser_rejects_unnamed_claim_placeholders() -> None:
    result = _parse_review_payload({
        "status": "needs_revision",
        "claims": [
            {"claim_id": "empty", "claim": "", "verdict": "unverified"},
            {"claim_id": "real", "statement": "真实声明", "verdict": "unverified"},
        ],
        "revision_instructions": [],
    })

    assert [claim.claim for claim in result.claims] == ["真实声明"]


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
    assert result.claims[0].location == (0, len("loopx 有 181 Star。"))
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
    assert result.claims[0].location == (0, len("loopx 有 2.2k stars。"))


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
async def test_dynamic_resolver_failure_still_builds_full_inventory_without_duplicate_claims(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A resolver outage must not short-circuit the claim inventory phase."""
    async def fetch(*_: object, **__: object) -> None:
        return None

    calls: list[dict[str, object]] = []

    async def review(**kwargs: object) -> SimpleNamespace:
        calls.append(kwargs)
        if len(calls) == 1:
            return SimpleNamespace(text=json.dumps({
                "coverage_status": "complete",
                "claims": [
                    {
                        "claim_id": "C1",
                        "claim": "loopx 有 181 Star",
                        "claim_type": "external_fact",
                        "risk": "high",
                    },
                    {
                        "claim_id": "C2",
                        "claim": "本轮没有抓取到发布说明正文",
                        "claim_type": "research_process",
                        "risk": "medium",
                    },
                ],
            }, ensure_ascii=False))
        return SimpleNamespace(text=json.dumps({
            "claims": [{
                "claim_id": "C1",
                "claim": "loopx 有 181 Star",
                "verdict": "verified",
                "evidence": {
                    "source_url": "https://github.com/huangruiteng/loopx",
                    "excerpt": "captured evidence",
                },
            }],
            "revision_instructions": [],
        }, ensure_ascii=False))

    monkeypatch.setattr("ai_engine.reviewer._fetch_github_stars", fetch)
    monkeypatch.setattr("ai_engine.reviewer.generate_text", review)
    result = await DefaultResearchReviewer().review(
        "loopx 有 181 Star\n本轮没有抓取到发布说明正文",
        (_source("https://github.com/huangruiteng/loopx"),),
        "loopx",
    )

    assert [call["operation"] for call in calls] == [
        "research.fact_review.inventory",
        "research.fact_review.adjudication",
    ]
    assert result.status == "needs_revision"
    assert result.factual_claim_count == 1
    assert len([claim for claim in result.claims if claim.claim_type == "external_fact"]) == 1
    assert {claim.claim_id for claim in result.claims} == {"C1", "C2"}
    assert next(claim for claim in result.claims if claim.claim_id == "C1").verdict == "unverified"


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
    [("unsupported", "passed"), ("contradicted", "passed"), ("not_applicable", "passed")],
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


@pytest.mark.asyncio
async def test_not_applicable_is_not_counted_as_a_factual_review_item(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def review(**_: object) -> SimpleNamespace:
        return SimpleNamespace(
            text=(
                '{"status":"passed","claims":['
                '{"claim_id":"opinion-1","claim":"建议优先采用方案 A",'
                '"risk":"medium","verdict":"not_applicable",'
                '"reason":"这是建议，不是事实"}],"revision_instructions":[]}'
            )
        )

    monkeypatch.setattr("ai_engine.reviewer.generate_text", review)
    result = await DefaultResearchReviewer().review(
        "建议优先采用方案 A。",
        (_source("https://example.com/source"),),
        "方案选择",
    )

    assert result.status == "passed"
    assert result.factual_claim_count == 0
    assert result.evidence_gap_count == 0


@pytest.mark.asyncio
async def test_research_process_observation_does_not_create_fact_review_work(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def review(**_: object) -> SimpleNamespace:
        return SimpleNamespace(
            text=(
                '{"status":"needs_revision","claims":['
                '{"claim_id":"process-1",'
                '"claim":"本轮仅抓取到官方文档的目录页，未抓取到安装正文",'
                '"risk":"medium","verdict":"unverified",'
                '"reason":"没有保存可核对摘录"}],"revision_instructions":[]}'
            )
        )

    monkeypatch.setattr("ai_engine.reviewer.generate_text", review)
    result = await DefaultResearchReviewer().review(
        "本轮仅抓取到官方文档的目录页。",
        (_source("https://example.com/source"),),
        "安装资料",
    )

    assert result.status == "passed"
    assert result.factual_claim_count == 0
    assert result.evidence_gap_count == 0
    assert result.claims[0].claim_type == "research_process"


@pytest.mark.asyncio
async def test_review_separates_claim_inventory_from_evidence_adjudication(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []

    async def review(**kwargs: object) -> SimpleNamespace:
        calls.append(kwargs)
        if len(calls) == 1:
            return SimpleNamespace(
                text=json.dumps({
                    "coverage_status": "complete",
                    "claims": [
                        {
                            "claim_id": "C1",
                            "claim": "本轮仅抓取到目录页",
                            "claim_type": "research_process",
                            "risk": "medium",
                        },
                        {
                            "claim_id": "C2",
                            "claim": "目录包含 Installation",
                            "claim_type": "external_fact",
                            "risk": "medium",
                        },
                    ],
                }, ensure_ascii=False),
            )
        return SimpleNamespace(
            text=json.dumps({
                "claims": [{
                    "claim_id": "C2",
                    "claim": "目录包含 Installation",
                    "verdict": "verified",
                    "evidence": {
                        "source_url": "https://example.com/source",
                        "excerpt": "Installation",
                    },
                }],
                "revision_instructions": [],
            }, ensure_ascii=False),
        )

    monkeypatch.setattr("ai_engine.reviewer.generate_text", review)
    result = await DefaultResearchReviewer().review(
        "本轮仅抓取到目录页。目录包含 Installation。",
        (AdapterSource(
            source_ref={"type": "url", "value": "https://example.com/source"},
            canonical_key="https://example.com/source",
            title="source",
            snippet="Installation",
            score=1.0,
            step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
        ),),
        "安装资料",
    )

    assert len(calls) == 2
    assert calls[0]["operation"] == "research.fact_review.inventory"
    assert calls[1]["operation"] == "research.fact_review.adjudication"
    assert "C1" not in str(calls[1]["user_prompt"])
    assert result.factual_claim_count == 1
    assert result.evidence_gap_count == 0
    assert result.claims[0].claim_type == "research_process"
    assert result.claims[0].verdict == "not_applicable"
    assert result.to_dict()["claims"][0]["claim_type"] == "research_process"


@pytest.mark.asyncio
async def test_review_checkpoint_persists_inventory_before_adjudication(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    phases: list[tuple[str, dict[str, object]]] = []

    async def review(**kwargs: object) -> SimpleNamespace:
        operation = kwargs["operation"]
        if operation == "research.fact_review.inventory":
            return SimpleNamespace(text=json.dumps({
                "coverage_status": "complete",
                "claims": [{
                    "claim_id": "C1",
                    "claim": "项目支持 Playwright",
                    "claim_type": "external_fact",
                    "risk": "medium",
                }],
            }, ensure_ascii=False))
        return SimpleNamespace(text=json.dumps({
            "claims": [{
                "claim_id": "C1",
                "claim": "项目支持 Playwright",
                "verdict": "verified",
                "evidence": {
                    "source_url": "https://example.com/source",
                    "excerpt": "captured evidence",
                },
            }],
            "revision_instructions": [],
        }, ensure_ascii=False))

    async def on_phase(phase: str, payload: dict[str, object]) -> None:
        phases.append((phase, payload))

    monkeypatch.setattr("ai_engine.reviewer.generate_text", review)
    result = await DefaultResearchReviewer().review(
        "项目支持 Playwright。",
        (_source("https://example.com/source"),),
        "Playwright",
        phase_callback=on_phase,
    )

    inventory = next(payload for phase, payload in phases if phase == "adjudicating")
    assert inventory["coverage_status"] == "complete"
    assert inventory["inventory"] == [{
        "claim_id": "C1",
        "claim": "项目支持 Playwright",
        "risk": "medium",
        "claim_type": "external_fact",
        "legacy_verdict": None,
    }]
    assert result.claims[0].verdict == "verified"


@pytest.mark.asyncio
async def test_fact_adjudication_is_batched_and_prioritizes_high_risk_claims(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FACT_REVIEW_BATCH_SIZE", "2")
    calls: list[dict[str, object]] = []
    claim_ids = ["C1", "C2", "C3", "C4", "C5"]

    async def review(**kwargs: object) -> SimpleNamespace:
        calls.append(kwargs)
        if kwargs["operation"] == "research.fact_review.inventory":
            return SimpleNamespace(text=json.dumps({
                "coverage_status": "complete",
                "claims": [
                    {
                        "claim_id": claim_id,
                        "claim": f"外部事实 {claim_id}",
                        "claim_type": "external_fact",
                        "risk": "high" if claim_id == "C3" else "medium",
                    }
                    for claim_id in claim_ids
                ],
            }, ensure_ascii=False))
        prompt = str(kwargs["user_prompt"])
        batch_claim_ids = [claim_id for claim_id in claim_ids if claim_id in prompt]
        return SimpleNamespace(text=json.dumps({
            "claims": [{
                "claim_id": claim_id,
                "claim": f"外部事实 {claim_id}",
                "verdict": "verified",
                "evidence": {
                    "source_url": "https://example.com/source",
                    "excerpt": "captured evidence",
                },
            } for claim_id in batch_claim_ids],
            "revision_instructions": [],
        }, ensure_ascii=False))

    monkeypatch.setattr("ai_engine.reviewer.generate_text", review)
    result = await DefaultResearchReviewer().review(
        "\n".join(f"外部事实 {claim_id}。" for claim_id in claim_ids),
        (_source("https://example.com/source"),),
        "批次审核",
    )

    assert len(calls) == 4  # one inventory call + three independent batches
    adjudication_prompts = [
        str(call["user_prompt"])
        for call in calls
        if call["operation"] == "research.fact_review.adjudication"
    ]
    # C3 is high risk and therefore appears in the first evidence batch.
    assert "C3" in adjudication_prompts[0]
    assert result.batch_count == 3
    assert result.completed_batch_count == 3
    assert result.failed_batch_count == 0
    assert result.judged_claim_count == 5
    assert result.total_claim_count == 5
    assert {claim.verdict for claim in result.claims} == {"verified"}


@pytest.mark.asyncio
async def test_failed_adjudication_batch_is_unverified_without_discarding_other_batches(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FACT_REVIEW_BATCH_SIZE", "2")
    calls: list[dict[str, object]] = []
    claim_ids = ["C1", "C2", "C3", "C4", "C5"]

    async def review(**kwargs: object) -> SimpleNamespace:
        calls.append(kwargs)
        if kwargs["operation"] == "research.fact_review.inventory":
            return SimpleNamespace(text=json.dumps({
                "coverage_status": "complete",
                "claims": [{
                    "claim_id": claim_id,
                    "claim": f"外部事实 {claim_id}",
                    "claim_type": "external_fact",
                    "risk": "medium",
                } for claim_id in claim_ids],
            }, ensure_ascii=False))
        prompt = str(kwargs["user_prompt"])
        if "C3" in prompt or "C4" in prompt:
            raise RuntimeError("batch provider unavailable")
        batch_claim_ids = [claim_id for claim_id in claim_ids if claim_id in prompt]
        return SimpleNamespace(text=json.dumps({
            "claims": [{
                "claim_id": claim_id,
                "claim": f"外部事实 {claim_id}",
                "verdict": "verified",
                "evidence": {
                    "source_url": "https://example.com/source",
                    "excerpt": "captured evidence",
                },
            } for claim_id in batch_claim_ids],
            "revision_instructions": [],
        }, ensure_ascii=False))

    monkeypatch.setattr("ai_engine.reviewer.generate_text", review)
    result = await DefaultResearchReviewer().review(
        "\n".join(f"外部事实 {claim_id}。" for claim_id in claim_ids),
        (_source("https://example.com/source"),),
        "部分批次失败",
    )

    # Inventory + batch 1 + failed batch attempt/retry + batch 3.
    assert len(calls) == 5
    verdicts = {claim.claim_id: claim.verdict for claim in result.claims}
    assert verdicts["C1"] == "verified"
    assert verdicts["C2"] == "verified"
    assert verdicts["C3"] == "unverified"
    assert verdicts["C4"] == "unverified"
    assert verdicts["C5"] == "verified"
    assert result.status == "needs_revision"
    assert result.coverage_status == "insufficient"
    assert result.batch_count == 3
    assert result.completed_batch_count == 2
    assert result.failed_batch_count == 1
    assert result.judged_claim_count == 3
    assert result.total_claim_count == 5
    assert result.contradicted_count == 0


@pytest.mark.asyncio
async def test_missing_inventory_coverage_marker_is_not_treated_as_complete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []

    async def review(**kwargs: object) -> SimpleNamespace:
        calls.append(kwargs)
        if len(calls) == 1:
            return SimpleNamespace(text=json.dumps({
                "claims": [{
                    "claim_id": "C1",
                    "claim": "事实声明",
                    "claim_type": "external_fact",
                    "risk": "medium",
                }],
            }, ensure_ascii=False))
        return SimpleNamespace(text=json.dumps({
            "claims": [{
                "claim_id": "C1",
                "claim": "事实声明",
                "verdict": "verified",
                "evidence": {
                    "source_url": "https://example.com/source",
                    "excerpt": "captured evidence",
                },
            }],
            "revision_instructions": [],
        }, ensure_ascii=False))

    monkeypatch.setattr("ai_engine.reviewer.generate_text", review)
    result = await DefaultResearchReviewer().review(
        "事实声明。\n" + "补充背景。" * 300,
        (_source("https://example.com/source"),),
        "覆盖检查",
    )

    assert len(calls) == 2
    assert result.coverage_status == "insufficient"
    assert result.to_dict()["review_outcome"] == "attention"


@pytest.mark.parametrize(
    ("risk", "expected_status"),
    [("high", "blocked"), ("medium", "needs_revision"), ("low", "needs_revision")],
)
def test_only_high_risk_contradiction_blocks_publication(risk: str, expected_status: str) -> None:
    result = _parse_review_payload({
        "claims": [{
            "claim_id": "claim-1",
            "claim": "有明确证据的事实声明",
            "risk": risk,
            "verdict": "contradicted",
        }],
    })

    assert result.status == expected_status


@pytest.mark.asyncio
async def test_unverified_claims_create_a_bounded_claim_level_repair_queue(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def review(**_: object) -> SimpleNamespace:
        claims = [
            {
                "claim_id": f"claim-{index}",
                "claim": f"事实声明 {index}",
                "risk": "high" if index < 3 else "medium",
                "verdict": "unverified",
                "reason": "来源摘录没有直接支持",
            }
            for index in range(10)
        ]
        return SimpleNamespace(
            text=(
                '{"status":"needs_revision","claims":'
                + json.dumps(claims, ensure_ascii=False)
                + ',"revision_instructions":[]}'
            )
        )

    monkeypatch.setattr("ai_engine.reviewer.generate_text", review)
    result = await DefaultResearchReviewer().review(
        "事实声明 0\n事实声明 1",
        (_source("https://example.com/source"),),
        "证据质量",
    )

    assert result.status == "needs_revision"
    assert result.evidence_gap_count == 10
    assert result.evidence_gap_instruction_count == 8
    assert len(result.revision_instructions) == 8
    assert all("声明级证据缺口" in item for item in result.revision_instructions)


@pytest.mark.asyncio
async def test_malformed_reviewer_output_does_not_become_passed_and_keeps_citation_ledger(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def malformed(**_: object) -> SimpleNamespace:
        return SimpleNamespace(text="<think>我正在审核报告，但输出被截断")

    monkeypatch.setattr("ai_engine.reviewer.generate_text", malformed)
    result = await DefaultResearchReviewer().review(
        "Playwright 支持跨浏览器测试 (Checkly, 2025)。",
        (_source("https://www.checklyhq.com/docs/comparisons/frameworks/playwright-vs-cypress"),),
        "Playwright 与 Cypress",
    )

    assert result.status == "review_unavailable"
    assert result.error_code == "invalid_output"
    assert result.claims[0].verdict == "unverified"
    assert result.claims[0].evidence is not None
    assert result.claims[0].evidence.resolver == "captured-source-citation"


@pytest.mark.asyncio
async def test_reviewer_retries_with_strict_json_prompt_after_parse_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = 0

    async def retryable(**_: object) -> SimpleNamespace:
        nonlocal calls
        calls += 1
        if calls == 1:
            return SimpleNamespace(text="<think>被截断")
        return SimpleNamespace(
            text=(
                '{"status":"passed","claims":['
                '{"claim_id":"claim-1","claim":"事实声明","risk":"medium",'
                '"verdict":"verified","evidence":{"source_url":"https://example.com/source",'
                '"excerpt":"captured evidence","observed_at":null,"resolver":null},'
                '"reason":null}],"revision_instructions":[]}'
            )
        )

    monkeypatch.setattr("ai_engine.reviewer.generate_text", retryable)
    result = await DefaultResearchReviewer().review(
        "事实声明。",
        (_source("https://example.com/source"),),
        "证据质量",
    )

    assert calls == 2
    assert result.status == "passed"
    assert result.claims[0].verdict == "verified"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("evidence", "expected_reason"),
    [
        (None, "没有提供可核对的来源地址和原文摘录"),
        ({"source_url": "https://other.example/article", "excerpt": "captured evidence"}, "不属于本轮已抓取来源"),
        ({"source_url": "https://example.com/source", "excerpt": "not in the saved source"}, "无法在本轮保存的来源正文中找到"),
    ],
)
async def test_llm_supported_claims_fail_closed_without_captured_evidence(
    monkeypatch: pytest.MonkeyPatch,
    evidence: dict[str, str] | None,
    expected_reason: str,
) -> None:
    async def review(**_: object) -> SimpleNamespace:
        claim = {
            "claim_id": "claim-1",
            "claim": "事实声明",
            "risk": "high",
            "verdict": "verified",
            "reason": None,
        }
        if evidence is not None:
            claim["evidence"] = evidence
        return SimpleNamespace(
            text=json.dumps(
                {"status": "passed", "claims": [claim], "revision_instructions": []},
                ensure_ascii=False,
            )
        )

    monkeypatch.setattr("ai_engine.reviewer.generate_text", review)
    result = await DefaultResearchReviewer().review(
        "事实声明。",
        (_source("https://example.com/source"),),
        "证据质量",
    )

    assert result.status == "needs_revision"
    assert result.claims[0].verdict == "unverified"
    assert result.claims[0].evidence is None
    assert result.claims[0].location == (0, len("事实声明"))
    assert expected_reason in (result.claims[0].reason or "")


@pytest.mark.asyncio
async def test_llm_claim_location_uses_sentence_match_for_normalized_claim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def review(**_: object) -> SimpleNamespace:
        return SimpleNamespace(
            text=json.dumps(
                {
                    "status": "passed",
                    "claims": [{
                        "claim_id": "claim-1",
                        "claim": "Playwright 官方文档覆盖 Node.js、Python、Java、.NET 四种语言绑定",
                        "risk": "medium",
                        "verdict": "verified",
                    }],
                    "revision_instructions": [],
                },
                ensure_ascii=False,
            )
        )

    monkeypatch.setattr("ai_engine.reviewer.generate_text", review)
    report = "该页面表明 Playwright 文档体系覆盖 Node.js、Python、Java、.NET 四种绑定入口。"
    result = await DefaultResearchReviewer().review(
        report,
        (_source("https://example.com/source"),),
        "Playwright",
    )

    assert result.claims[0].verdict == "unverified"
    assert result.claims[0].location == (0, len(report))


@pytest.mark.asyncio
async def test_llm_supported_claim_requires_excerpt_from_exact_captured_source(monkeypatch: pytest.MonkeyPatch) -> None:
    async def review(**_: object) -> SimpleNamespace:
        return SimpleNamespace(
            text=json.dumps(
                {
                    "status": "passed",
                    "claims": [
                        {
                            "claim_id": "claim-1",
                            "claim": "事实声明",
                            "risk": "high",
                            "verdict": "verified",
                            "evidence": {
                                "source_url": "https://example.com/source/",
                                "excerpt": "captured   evidence",
                            },
                        }
                    ],
                    "revision_instructions": [],
                },
                ensure_ascii=False,
            )
        )

    monkeypatch.setattr("ai_engine.reviewer.generate_text", review)
    result = await DefaultResearchReviewer().review(
        "事实声明。",
        (_source("https://example.com/source"),),
        "证据质量",
    )

    assert result.status == "passed"
    assert result.claims[0].verdict == "verified"
    assert result.claims[0].evidence is not None


@pytest.mark.asyncio
async def test_reconciles_unbound_claim_against_saved_source_without_marking_it_verified(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def review(**_: object) -> SimpleNamespace:
        return SimpleNamespace(
            text=json.dumps(
                {
                    "status": "passed",
                    "claims": [{
                        "claim_id": "claim-1",
                        "claim": "目录中提及 Playwright MCP、CLI、API、Test、Agents、Annotations 等条目",
                        "risk": "medium",
                        "verdict": "verified",
                    }],
                    "revision_instructions": [],
                },
                ensure_ascii=False,
            )
        )

    monkeypatch.setattr("ai_engine.reviewer.generate_text", review)
    source = AdapterSource(
        source_ref={"type": "url", "value": "https://example.com/playwright"},
        canonical_key="https://example.com/playwright",
        title="Playwright documentation index",
        snippet="目录中提及 Playwright MCP、CLI、API、Test、Agents、Annotations 等条目。",
        score=1.0,
        step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
    )

    result = await DefaultResearchReviewer().review(
        "目录中提及 Playwright MCP、CLI、API、Test、Agents、Annotations 等条目。",
        (source,),
        "Playwright",
    )

    assert result.status == "needs_revision"
    assert result.evidence_binding_repaired_count == 1
    assert result.claims[0].verdict == "unverified"
    assert result.claims[0].evidence is not None
    assert result.claims[0].evidence.resolver == "captured-source-reconciler"
    assert "尚未据此判定" in (result.claims[0].reason or "")


def test_does_not_reconcile_a_weak_or_unrelated_source() -> None:
    result = _reconcile_unbound_evidence(
        _parse_review_payload({
            "claims": [{
                "claim_id": "claim-1",
                "claim": "Playwright 支持四种语言绑定",
                "risk": "medium",
                "verdict": "unverified",
            }],
        }),
        (_source("https://example.com/source"),),
    )

    assert result.claims[0].evidence is None
    assert result.evidence_binding_repaired_count == 0


def test_reconciles_mixed_language_technical_term_list() -> None:
    """A source excerpt must not be lost because Chinese glue words dilute ASCII hits."""
    source = AdapterSource(
        source_ref={"type": "url", "value": "https://example.com/playwright"},
        canonical_key="https://example.com/playwright",
        title="Playwright documentation index",
        snippet=(
            "Installation | Playwright Skip to main content Playwright Docs MCP CLI API "
            "Node.js Node.js Python Java .NET Search Getting Started Installation Writing tests "
            "Generating tests Running and debugging tests Trace viewer Setting up CI VS Code "
            "Release notes Canary releases Playwright Test Agents Annotations Command line Configuration"
        ),
        score=1.0,
        step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
    )
    result = _reconcile_unbound_evidence(
        _parse_review_payload({
            "claims": [{
                "claim_id": "claim-1",
                "claim": "目录中提及 Playwright MCP、CLI、API、Test、Agents、Annotations 等条目",
                "risk": "medium",
                "verdict": "unverified",
            }],
        }),
        (source,),
    )

    assert result.evidence_binding_repaired_count == 1
    assert result.claims[0].evidence is not None
    assert result.claims[0].evidence.resolver == "captured-source-reconciler"


def test_reviewer_parser_ignores_thinking_preamble_and_finds_json() -> None:
    payload = _extract_json_object(
        '<think>先分析。{"example":"not the answer"}</think>\n'
        '{"status":"passed","claims":[],"revision_instructions":[]}'
    )
    assert payload["status"] == "passed"


@pytest.mark.parametrize(
    "citation",
    ["Autonoma, 2026", "Autonoma，2026", "Autonoma 2026", "Autonoma 2026 比较（链接未被本次来源验证）"],
)
def test_citation_ledger_maps_author_year_variants_to_captured_source(citation: str) -> None:
    ledger = _citation_ledger(
        f"结论需要核对：{citation}。",
        (_source("https://autonoma.example/compare"),),
    )

    assert len(ledger) == 1
    assert ledger[0].verdict == "unverified"
    assert ledger[0].evidence is not None
    assert ledger[0].evidence.source_url == "https://autonoma.example/compare"
    assert ledger[0].evidence.resolver == "captured-source-citation"


def test_citation_ledger_maps_direct_markdown_link_without_reading_bibliography() -> None:
    ledger = _citation_ledger(
        "正文参考 [Autonoma comparison](https://autonoma.example/compare)。\n\n"
        "## 参考文献\n\n- [Autonoma comparison](https://autonoma.example/compare)",
        (_source("https://autonoma.example/compare"),),
    )

    assert len(ledger) == 1
    assert ledger[0].claim.startswith("正文参考")


def test_citation_ledger_matches_www_and_non_www_variants() -> None:
    ledger = _citation_ledger(
        "正文参考 [官方资料](https://www.autonoma.example/compare/)。",
        (_source("https://autonoma.example/compare"),),
    )

    assert len(ledger) == 1
    assert ledger[0].evidence is not None
    assert ledger[0].evidence.source_url == "https://autonoma.example/compare"


def test_citation_ledger_ignores_discovered_url_without_excerpt() -> None:
    ledger = _citation_ledger(
        "正文参考 [仅发现](https://discovered.example/article)。",
        (_discovered_source("https://discovered.example/article"),),
    )

    assert ledger == []


def test_citation_ledger_keeps_unmatched_unverified_citations_visible() -> None:
    ledger = _citation_ledger(
        "这个精确数字来自某篇文章（链接未被本次来源验证）。",
        (_source("https://example.com/captured"),),
    )

    assert len(ledger) == 1
    assert ledger[0].verdict == "unverified"
    assert ledger[0].evidence is None
    assert ledger[0].claim.startswith("这个精确数字")


def test_review_prompt_keeps_all_captured_sources_on_deep_runs() -> None:
    sources = tuple(
        AdapterSource(
            source_ref={"type": "url", "value": f"https://example.com/source-{index}"},
            canonical_key=f"https://example.com/source-{index}",
            title=f"Source {index}",
            snippet=f"独立来源 {index} 的原文证据。",
            score=1.0,
            step_captured=AI_JOB_STEP["SEARCH"],  # type: ignore[arg-type]
        )
        for index in range(30)
    )

    prompt = _review_source_text("一个需要审核的报告", sources)

    assert "source_id=1" in prompt
    assert "source_id=30" in prompt
    assert prompt.count("source_id=") == 30
