from __future__ import annotations

import json
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from ai_engine import reviewer as review_module
from ai_engine.adapters.base import AdapterSource
from ai_engine.reviewer import ClaimInventoryItem, DefaultResearchReviewer, _adjudicate_fact_batches


@pytest.mark.parametrize(("declared_coverage", "floor"), [("insufficient", 0), ("complete", 3)])
async def test_slides_preserve_inventory_gaps(
    monkeypatch: pytest.MonkeyPatch, declared_coverage: str, floor: int,
) -> None:
    statement = "Model latency is 10 ms."

    @asynccontextmanager
    async def no_reservation(**kwargs: object):  # type: ignore[no-untyped-def]
        yield None

    async def generate(**kwargs: object) -> SimpleNamespace:
        inventory = "coverage_status" in str(kwargs.get("system_prompt"))
        payload = {
            "coverage_status": declared_coverage,
            "claims": [{
                "claim_id": "C1", "claim": statement, "risk": "low", "claim_type": "external_fact",
                **({} if inventory else {
                    "verdict": "verified", "judgment_status": "settled",
                    "evidence": {"source_url": "https://example.com/source", "excerpt": statement},
                }),
            }],
        }
        return SimpleNamespace(text=json.dumps(payload), truncated=False)

    monkeypatch.setattr(review_module, "generate_text", generate)
    monkeypatch.setattr(review_module, "reserve_llm_token_task", no_reservation)
    monkeypatch.setattr(review_module, "_deterministic_claim_floor", lambda report: floor)
    source = AdapterSource(
        source_ref={"type": "url", "value": "https://example.com/source"},
        canonical_key="https://example.com/source", title="source", snippet=statement,
        score=1.0, step_captured="search",
    )
    result = await DefaultResearchReviewer().review(f"# Slides\n\n{statement}", (source,), "topic", report_type="slides")
    assert result.claims
    assert result.coverage_status == "insufficient"
    assert result.to_dict()["review_outcome"] != "clear"


async def test_nested_partial_recovery_retains_failed_coverage(monkeypatch: pytest.MonkeyPatch) -> None:
    inventory = tuple(ClaimInventoryItem(f"C{i}", f"statement {i}", "low", "external_fact") for i in range(1, 5))

    async def generate(**kwargs: object) -> SimpleNamespace:
        prompt = str(kwargs["user_prompt"])
        ids = ["C1", "C2"] if '"claim_id": "C1"' in prompt else ["C3"] if '"claim_id": "C3"' in prompt else []
        return SimpleNamespace(text=json.dumps({"claims": [
            {"claim_id": key, "claim": f"statement {key[1:]}", "risk": "low", "verdict": "verified"}
            for key in ids
        ]}))

    async def emit(phase: str, details: dict[str, object]) -> None:
        pass

    monkeypatch.setattr(review_module, "generate_text", generate)
    result = await _adjudicate_fact_batches(
        inventory=inventory, source_text="captured", topic="topic", report_type="research_report",
        llm_spec=None, inventory_coverage="complete", emit_phase=emit,
    )
    assert {claim.claim_id for claim in result.claims} == {"C1", "C2", "C3", "C4"}
    assert result.coverage_status == "insufficient"
    assert result.failed_batch_count == 1
    assert result.judged_claim_count == 3
    assert result.execution_failed_claim_count == 1
