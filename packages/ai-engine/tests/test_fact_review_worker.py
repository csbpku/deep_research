"""Independent fact-review worker contract tests.

These tests intentionally stop at the store seam.  The important contract is
that reviewing produces a version-scoped assessment and never mutates the
research body or turns a reviewer failure into a factual verdict.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

import pytest

from ai_engine.adapters.base import AdapterSource
from ai_engine.job_runner.models import ReviewWorkItem
from ai_engine.server.app import _review_one_item
from ai_engine.reviewer import ReviewResult


def _work() -> ReviewWorkItem:
    return ReviewWorkItem(
        job_id="job-1",
        requester_id="user-1",
        topic="事实审核流程",
        report_type="research_report",
        report="# 报告\n\n结论 A。",
        sources=(
            AdapterSource(
                source_ref={"type": "url", "value": "https://example.com/source"},
                canonical_key="https://example.com/source",
                title="Source",
                snippet="原文摘录",
                score=1.0,
                step_captured="search",
            ),
        ),
        draft_research_id="research-1",
        attempts=1,
        review_details={"phase": "reviewing", "status": "reviewing"},
        claim_token="claim-1",
    )


@dataclass
class _RecordingStore:
    completed: list[tuple[ReviewWorkItem, dict[str, object]]]
    checkpoints: list[dict[str, object]] | None = None

    async def complete_review(self, work: ReviewWorkItem, details: dict[str, object]) -> None:
        self.completed.append((work, details))

    async def checkpoint_review(self, work: ReviewWorkItem, checkpoint: dict[str, object]) -> bool:
        del work
        if self.checkpoints is None:
            self.checkpoints = []
        self.checkpoints.append(checkpoint)
        return True


@pytest.mark.asyncio
async def test_review_worker_persists_assessment_without_rewriting_report(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ai_engine.reviewer as reviewer_module

    class FakeReviewer:
        def __init__(self, **_: object) -> None:
            pass

        async def review(self, *_: object, **__: object) -> ReviewResult:
            return ReviewResult("passed")

    monkeypatch.setattr(reviewer_module, "DefaultResearchReviewer", FakeReviewer)
    store = _RecordingStore([])
    work = _work()
    original_report = work.report

    await _review_one_item(store, work)

    assert work.report == original_report
    assert len(store.completed) == 1
    saved_work, details = store.completed[0]
    assert saved_work.claim_token == "claim-1"
    assert details["phase"] == "completed"
    assert details["status"] == "passed"
    assert [item["phase"] for item in store.checkpoints or []] == [
        "inventorying", "matching", "conflict_check",
    ]


@pytest.mark.asyncio
async def test_review_worker_persists_the_reviewer_phase_boundaries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ai_engine.reviewer as reviewer_module

    class PhaseAwareReviewer:
        def __init__(self, **_: object) -> None:
            pass

        async def review(self, *_: object, **kwargs: object) -> ReviewResult:
            callback = kwargs["phase_callback"]
            assert callable(callback)
            for phase in ("inventorying", "adjudicating", "matching", "conflict_check"):
                await callback(phase, {"test_phase": phase})
            return ReviewResult("passed")

    monkeypatch.setattr(reviewer_module, "DefaultResearchReviewer", PhaseAwareReviewer)
    store = _RecordingStore([])

    await _review_one_item(store, _work())

    assert [item["phase"] for item in store.checkpoints or []] == [
        "inventorying", "adjudicating", "matching", "conflict_check",
    ]
    details = store.completed[0][1]
    assert details["adjudicating"] == {"test_phase": "adjudicating"}


@pytest.mark.asyncio
async def test_review_worker_records_timeout_as_unavailable_not_passed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ai_engine.reviewer as reviewer_module
    import ai_engine.server.app as app_module

    class SlowReviewer:
        def __init__(self, **_: object) -> None:
            pass

        async def review(self, *_: object, **__: object) -> ReviewResult:
            await asyncio.sleep(0.05)
            return ReviewResult("passed")

    monkeypatch.setattr(reviewer_module, "DefaultResearchReviewer", SlowReviewer)
    monkeypatch.setattr(app_module, "_fact_review_timeout_seconds", lambda: 0.001)
    store = _RecordingStore([])

    await _review_one_item(store, _work())

    assert store.completed[0][1]["status"] == "review_unavailable"
    assert store.completed[0][1]["error_code"] == "timeout"


@pytest.mark.asyncio
async def test_review_timeout_keeps_settled_batches_and_marks_only_active_claims_unverified(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ai_engine.reviewer as reviewer_module
    import ai_engine.server.app as app_module

    class SlowAfterFirstBatch:
        def __init__(self, **_: object) -> None:
            pass

        async def review(self, *_: object, **kwargs: object) -> ReviewResult:
            callback = kwargs["phase_callback"]
            assert callable(callback)
            await callback("adjudicating", {
                "inventory": [
                    {
                        "claim_id": "C1",
                        "claim": "声明一",
                        "risk": "high",
                        "claim_type": "external_fact",
                    },
                    {
                        "claim_id": "C2",
                        "claim": "声明二",
                        "risk": "medium",
                        "claim_type": "external_fact",
                    },
                ],
                "batch_count": 2,
                "completed_batch_count": 1,
                "failed_batch_count": 0,
                "judged_claim_count": 1,
                "total_claim_count": 2,
                "batch_status": "running",
                "settled_claims": [{
                    "claim_id": "C1",
                    "claim": "声明一",
                    "risk": "high",
                    "verdict": "verified",
                    "claim_type": "external_fact",
                    "evidence": {
                        "source_url": "https://example.com/source",
                        "excerpt": "原文摘录",
                    },
                }],
            })
            await asyncio.sleep(0.05)
            return ReviewResult("passed")

    monkeypatch.setattr(reviewer_module, "DefaultResearchReviewer", SlowAfterFirstBatch)
    monkeypatch.setattr(app_module, "_fact_review_timeout_seconds", lambda: 0.001)
    store = _RecordingStore([])

    await _review_one_item(store, _work())

    details = store.completed[0][1]
    assert details["status"] == "review_unavailable"
    assert details["coverage_status"] == "insufficient"
    claims = {claim["claim_id"]: claim for claim in details["claims"]}
    assert claims["C1"]["verdict"] == "verified"
    assert claims["C2"]["verdict"] == "unverified"
    assert claims["C2"]["verdict"] != "contradicted"
