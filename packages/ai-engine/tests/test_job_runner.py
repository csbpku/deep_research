"""Job runner skeleton tests — protocol-level only (Week 1).

We exercise the in-memory store + fake adapter. The DB-backed store is
Week 5 work; tests for it will live in `tests/test_job_runner_db.py`.
"""

from __future__ import annotations

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
from ai_engine.job_runner.runner import run_once, run_one_available_job
from ai_engine.job_runner.store import (
    InMemoryJobStore,
    build_store,
    make_job_snapshot,
)


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