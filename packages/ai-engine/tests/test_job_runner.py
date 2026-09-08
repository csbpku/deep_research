"""Job runner skeleton tests — protocol-level only (Week 1).

We exercise the in-memory store + fake adapter. The DB-backed store is
Week 5 work; tests for it will live in `tests/test_job_runner_db.py`.
"""

from __future__ import annotations

import asyncio

import pytest

from ai_engine.adapters.fake import FakeAdapter
from ai_engine.contracts.states import (
    AI_JOB_STATUS,
    PARTIAL_MIN_SOURCES,
)
from ai_engine.job_runner.models import (
    HeartbeatResult,
    LeaseLostError,
    RunOutcome,
)
from ai_engine.job_runner.db_store import DbJobStore, _clip_db_text
from ai_engine.job_runner.runner import (
    _resolve_worker_timeout,
    _review_details,
    run_once,
    run_one_available_job,
)
from ai_engine.job_runner.store import (
    InMemoryJobStore,
    build_store,
    make_job_snapshot,
)


def test_review_details_persists_deep_progress_without_review_data() -> None:
    progress = {"mode": "deep", "totalBranchesCompleted": 4, "totalBranches": 24}
    assert _review_details({"research_progress": progress}) == {
        "research_progress": progress,
    }


def test_review_details_preserves_review_and_namespaces_deep_progress() -> None:
    review = {"status": "passed", "attempts": 1}
    progress = {"mode": "deep", "state": "searching"}
    assert _review_details({"review": review, "research_progress": progress}) == {
        **review,
        "research_progress": progress,
    }


def test_clip_db_text_keeps_source_excerpt_within_schema_limit() -> None:
    clipped = _clip_db_text("证据" * 600, 1000)
    assert clipped is not None
    assert len(clipped) == 1000
    assert clipped.endswith("…")
    assert _clip_db_text("short", 1000) == "short"
    assert _clip_db_text(None, 1000) is None


def test_deep_research_gets_a_longer_budget_than_standard_runs() -> None:
    assert _resolve_worker_timeout("standard", {}) == 300
    assert _resolve_worker_timeout("deep", {}) == 1200
    assert _resolve_worker_timeout("deep", {"DEEP_RESEARCH_TIMEOUT_SECONDS": "900"}) == 900


def test_deep_timeout_has_precedence_when_both_budgets_are_configured() -> None:
    assert _resolve_worker_timeout(
        "deep",
        {
            "WORKER_JOB_TIMEOUT_SECONDS": "45",
            "DEEP_RESEARCH_TIMEOUT_SECONDS": "1200",
        },
    ) == 1200
    assert _resolve_worker_timeout("deep", {"WORKER_JOB_TIMEOUT_SECONDS": "invalid"}) == 300


def test_db_ai_lease_covers_deep_budget_with_recovery_margin(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEP_RESEARCH_TIMEOUT_SECONDS", "1800")
    store = DbJobStore(
        dsn="postgresql://postgres:postgres@localhost:5432/deep_research",
        lease_seconds=1020,
    )
    assert store._lease_seconds == 1920


@pytest.mark.asyncio
async def test_build_store_default_is_memory() -> None:
    store = build_store()
    assert isinstance(store, InMemoryJobStore)


@pytest.mark.asyncio
async def test_build_store_db_constructs_without_connecting() -> None:
    """Week 2: DbJobStore is implemented but the pool opens lazily.

    `build_store(name='db')` returns a DbJobStore without dialing Postgres.
    The first acquire/enqueue hits the real DB. This lets the unit-test
    suite (which doesn't need DB) keep using the memory backend.
    """
    from ai_engine.job_runner.db_store import DbJobStore

    store = build_store(name="db")
    assert isinstance(store, DbJobStore)
    # Pool must not be open yet (no side-effects at construction).
    assert store._pool_open is False


@pytest.mark.asyncio
async def test_acquire_then_run_happy_path() -> None:
    store = InMemoryJobStore()
    adapter = FakeAdapter(default_mode="success")
    snap = make_job_snapshot(topic="happy path")
    await store.enqueue(snap)

    lease_tuple = await store.acquire_next_job("w-1")
    assert lease_tuple is not None
    lease, snapshot = lease_tuple
    assert snapshot.status == "running"

    outcome = await run_once(
        store=store, adapter=adapter, lease=lease, snapshot=snapshot
    )
    assert isinstance(outcome, RunOutcome)
    assert outcome.final_status == AI_JOB_STATUS["SUCCEEDED"]
    assert len(outcome.sources) >= PARTIAL_MIN_SOURCES
    # Store has recorded the terminal state.
    row = store.get_row(lease.job_id)
    assert row is not None
    assert row.snapshot.status == AI_JOB_STATUS["SUCCEEDED"]
    assert row.locked_by is None  # terminal → lease released


@pytest.mark.asyncio
async def test_acquire_skips_already_held_lease() -> None:
    store = InMemoryJobStore()
    snap = make_job_snapshot()
    await store.enqueue(snap)

    first = await store.acquire_next_job("w-1")
    assert first is not None
    second = await store.acquire_next_job("w-2")
    assert second is None  # w-1 still holds the lease


@pytest.mark.asyncio
async def test_heartbeat_renews_lease() -> None:
    store = InMemoryJobStore()
    snap = make_job_snapshot()
    await store.enqueue(snap)

    lease_tuple = await store.acquire_next_job("w-1")
    assert lease_tuple is not None
    lease, _ = lease_tuple

    result = await store.heartbeat(lease)
    assert isinstance(result, HeartbeatResult)
    assert result.renewed is True
    assert result.lease_expires_at is not None


@pytest.mark.asyncio
async def test_heartbeat_rejects_wrong_worker() -> None:
    store = InMemoryJobStore()
    snap = make_job_snapshot()
    await store.enqueue(snap)

    lease_tuple = await store.acquire_next_job("w-1")
    assert lease_tuple is not None
    lease, _ = lease_tuple

    foreign = type(lease)(
        job_id=lease.job_id,
        worker_id="w-2",
        locked_by=lease.locked_by,
        lease_expires_at=lease.lease_expires_at,
        heartbeat_interval_seconds=lease.heartbeat_interval_seconds,
    )
    result = await store.heartbeat(foreign)
    assert result.renewed is False
    assert result.reason == "lease_lost"


@pytest.mark.asyncio
async def test_runner_stops_immediately_when_heartbeat_loses_lease() -> None:
    class LostLeaseStore(InMemoryJobStore):
        async def heartbeat(self, lease):  # type: ignore[no-untyped-def]
            return HeartbeatResult(
                renewed=False,
                lease_expires_at=None,
                reason="lease_lost",
            )

    store = LostLeaseStore()
    adapter = FakeAdapter(default_mode="success")
    snap = make_job_snapshot(topic="lost lease")
    await store.enqueue(snap)
    acquired = await store.acquire_next_job("w-1")
    assert acquired is not None
    lease, snapshot = acquired

    outcome = await run_once(
        store=store,
        adapter=adapter,
        lease=lease,
        snapshot=snapshot,
    )

    assert outcome.final_status == "failed"
    assert outcome.error_code == "WORKER_LEASE_LOST"
    assert outcome.error_message == "lease_lost"


@pytest.mark.asyncio
async def test_mark_terminal_rejects_wrong_worker() -> None:
    store = InMemoryJobStore()
    snap = make_job_snapshot()
    await store.enqueue(snap)

    lease_tuple = await store.acquire_next_job("w-1")
    assert lease_tuple is not None
    lease, _ = lease_tuple

    foreign = type(lease)(
        job_id=lease.job_id,
        worker_id="w-2",
        locked_by=lease.locked_by,
        lease_expires_at=lease.lease_expires_at,
        heartbeat_interval_seconds=lease.heartbeat_interval_seconds,
    )
    with pytest.raises(LeaseLostError):
        await store.mark_terminal(
            foreign,
            "failed",
            current_step=None,
            error_code="WORKER_LEASE_LOST",
            error_message="not ours",
            draft_research_id=None,
        )


@pytest.mark.asyncio
async def test_run_one_available_job_picks_and_completes() -> None:
    store = InMemoryJobStore()
    adapter = FakeAdapter(default_mode="success")
    snap = make_job_snapshot()
    await store.enqueue(snap)

    outcome = await run_one_available_job(store=store, adapter=adapter)
    assert outcome is not None
    assert outcome.final_status == AI_JOB_STATUS["SUCCEEDED"]


@pytest.mark.asyncio
async def test_unexpected_finalize_error_is_persisted_as_terminal_failure() -> None:
    store = InMemoryJobStore()
    adapter = FakeAdapter(default_mode="success")
    snap = make_job_snapshot(topic="draft persistence failure")
    await store.enqueue(snap)

    async def broken_draft_factory(*_: object) -> str | None:
        raise RuntimeError("simulated draft write failure")

    outcome = await run_one_available_job(
        store=store,
        adapter=adapter,
        draft_factory=broken_draft_factory,
    )

    assert outcome is not None
    assert outcome.final_status == "failed"
    assert outcome.error_code == "RESEARCH_DRAFT_PERSIST_FAILED"
    row = store.get_row(snap.job_id)
    assert row is not None
    assert row.snapshot.status == "failed"
    assert row.locked_by is None
    assert row.last_error_message == "研究报告已生成，但保存研究稿失败，请重新运行。"


@pytest.mark.asyncio
async def test_unexpected_runner_error_does_not_leave_job_running() -> None:
    class BrokenAdapter(FakeAdapter):
        async def submit(self, request):  # type: ignore[no-untyped-def]
            raise RuntimeError("simulated submit failure")

    store = InMemoryJobStore()
    snap = make_job_snapshot(topic="runner failure")
    await store.enqueue(snap)

    outcome = await run_one_available_job(store=store, adapter=BrokenAdapter())

    assert outcome is not None
    assert outcome.final_status == "failed"
    assert outcome.error_code == "WORKER_UNHANDLED"
    row = store.get_row(snap.job_id)
    assert row is not None
    assert row.snapshot.status == "failed"
    assert row.locked_by is None


@pytest.mark.asyncio
async def test_summary_brief_persists_inline_output_without_draft() -> None:
    store = InMemoryJobStore()
    adapter = FakeAdapter(default_mode="success", sources_per_job=0)
    snap = make_job_snapshot(report_type="summary_brief")
    await store.enqueue(snap)

    outcome = await run_one_available_job(store=store, adapter=adapter)

    assert outcome is not None
    assert outcome.final_status == AI_JOB_STATUS["SUCCEEDED"]
    assert outcome.draft_research_id is None
    assert outcome.output_text
    row = store.get_row(snap.job_id)
    assert row is not None
    assert row.snapshot.status == AI_JOB_STATUS["SUCCEEDED"]
    assert row.draft_research_id is None
    assert row.output_text == outcome.output_text


@pytest.mark.asyncio
async def test_evidence_search_persists_inline_receipt_without_draft() -> None:
    """Claim-scoped retrieval must never create a second Research asset."""
    store = InMemoryJobStore()
    adapter = FakeAdapter(default_mode="success")
    snap = make_job_snapshot(report_type="evidence_search")
    await store.enqueue(snap)

    captured: list[str] = []

    async def draft_factory(*_: object) -> str | None:
        captured.append("called")
        return "must-not-exist"

    outcome = await run_one_available_job(
        store=store,
        adapter=adapter,
        draft_factory=draft_factory,
    )

    assert outcome is not None
    assert outcome.final_status == AI_JOB_STATUS["SUCCEEDED"]
    assert outcome.draft_research_id is None
    assert outcome.output_text
    assert captured == []


@pytest.mark.asyncio
async def test_slides_report_renders_as_slide_markdown_before_draft_creation() -> None:
    store = InMemoryJobStore()
    adapter = FakeAdapter(default_mode="success")
    snap = make_job_snapshot(topic="Slides topic", report_type="slides")
    await store.enqueue(snap)
    captured: dict[str, str] = {}

    async def draft_factory(snapshot, sources, body, review):  # type: ignore[no-untyped-def]
        captured["body"] = body
        return "draft-slides"

    outcome = await run_one_available_job(
        store=store,
        adapter=adapter,
        draft_factory=draft_factory,
    )

    assert outcome is not None
    assert outcome.final_status == AI_JOB_STATUS["SUCCEEDED"]
    assert outcome.draft_research_id == "draft-slides"
    assert captured["body"].startswith("## Slide 1:")
    assert "Slides topic" in captured["body"]


@pytest.mark.asyncio
async def test_run_one_available_job_returns_none_on_empty_queue() -> None:
    store = InMemoryJobStore()
    adapter = FakeAdapter()
    outcome = await run_one_available_job(store=store, adapter=adapter)
    assert outcome is None


@pytest.mark.asyncio
async def test_partial_path_records_partial_status() -> None:
    store = InMemoryJobStore()
    adapter = FakeAdapter(default_mode="partial")
    snap = make_job_snapshot()
    await store.enqueue(snap)

    lease_tuple = await store.acquire_next_job("w-1")
    assert lease_tuple is not None
    lease, snapshot = lease_tuple
    outcome = await run_once(
        store=store, adapter=adapter, lease=lease, snapshot=snapshot
    )
    assert outcome.final_status == AI_JOB_STATUS["PARTIAL"]
    row = store.get_row(lease.job_id)
    assert row is not None
    assert row.snapshot.status == AI_JOB_STATUS["PARTIAL"]
    # Terminal state releases lease.
    assert row.locked_by is None


@pytest.mark.asyncio
async def test_partial_path_preserves_readable_report_checkpoint() -> None:
    store = InMemoryJobStore()
    adapter = FakeAdapter(default_mode="partial_after_write")
    snap = make_job_snapshot(report_length="deep")
    await store.enqueue(snap)

    lease_tuple = await store.acquire_next_job("w-1")
    assert lease_tuple is not None
    lease, snapshot = lease_tuple
    outcome = await run_once(
        store=store, adapter=adapter, lease=lease, snapshot=snapshot
    )

    assert outcome.final_status == AI_JOB_STATUS["PARTIAL"]
    assert outcome.output_text is not None
    assert "基于已验证来源生成的简要摘要" in outcome.output_text
    row = store.get_row(lease.job_id)
    assert row is not None
    assert row.output_text == outcome.output_text
    assert row.draft_research_id is None


@pytest.mark.asyncio
async def test_runner_bounds_a_hanging_status_poll(monkeypatch: pytest.MonkeyPatch) -> None:
    """A stuck provider status read must not leave a job running forever."""

    class HangingStatusAdapter(FakeAdapter):
        async def get_status(self, job_id):  # type: ignore[no-untyped-def]
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

    monkeypatch.setenv("WORKER_JOB_TIMEOUT_SECONDS", "1")
    store = InMemoryJobStore()
    adapter = HangingStatusAdapter(default_mode="timeout")
    snap = make_job_snapshot(topic="bounded provider status")
    await store.enqueue(snap)

    outcome = await run_one_available_job(store=store, adapter=adapter)

    assert outcome is not None
    assert outcome.final_status == "failed"
    assert outcome.error_code == "WORKER_TIMEOUT"
    row = store.get_row(snap.job_id)
    assert row is not None
    assert row.snapshot.status == "failed"
    assert row.locked_by is None


@pytest.mark.asyncio
async def test_running_checkpoint_is_available_before_terminal_persistence() -> None:
    store = InMemoryJobStore()
    snap = make_job_snapshot(report_length="deep")
    await store.enqueue(snap)
    acquired = await store.acquire_next_job("w-1")
    assert acquired is not None
    lease, _ = acquired

    await store.record_progress(
        lease,
        current_step="write",
        token_in=10,
        token_out=20,
        cost_cents=1,
        sources=[],
        output_text="# 可读研究稿\n\n阶段性结论",
    )

    row = store.get_row(snap.job_id)
    assert row is not None
    assert row.snapshot.status == "running"
    assert row.output_text == "# 可读研究稿\n\n阶段性结论"


@pytest.mark.asyncio
async def test_failed_path_uses_proper_error_code() -> None:
    store = InMemoryJobStore()
    adapter = FakeAdapter(default_mode="failed", sources_per_job=1)
    snap = make_job_snapshot()
    await store.enqueue(snap)
    lease_tuple = await store.acquire_next_job("w-1")
    assert lease_tuple is not None
    lease, snapshot = lease_tuple
    outcome = await run_once(
        store=store, adapter=adapter, lease=lease, snapshot=snapshot
    )
    assert outcome.final_status == AI_JOB_STATUS["FAILED"]
    assert outcome.error_code == "AI_ENGINE_UNAVAILABLE"
    assert outcome.error_details is not None
    assert outcome.error_details["phase"] == "plan"
    assert outcome.error_details["adapter"] == "FakeAdapter"
    row = store.get_row(snap.job_id)
    assert row is not None
    assert row.last_error_details == outcome.error_details
