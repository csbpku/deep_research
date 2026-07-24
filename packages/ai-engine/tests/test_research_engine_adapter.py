"""Tests for the FakeAdapter — covers all state-machine paths.

These tests double as the Week 1 verification of the
`ResearchEngineAdapter` Protocol: any new adapter implementation must
pass the same contract checks before the Week 5 worker trusts it.
"""

from __future__ import annotations

import asyncio
import pytest

from ai_engine.adapters.base import (
    ResearchEngineAdapter,
    ResearchRequest,
    build_adapter,
)
from ai_engine.adapters.fake import FakeAdapter, make_job_id
from ai_engine.contracts.errors import AdapterError
from ai_engine.contracts.states import (
    AI_JOB_STATUS,
    PARTIAL_MIN_SOURCES,
    SOURCE_POLICY,
)


def _request(
    *,
    job_id: str | None = None,
    topic: str = "RAG 在企业知识库的落地挑战",
    mode_sources: int = 5,
) -> ResearchRequest:
    return ResearchRequest(
        job_id=job_id or make_job_id(),
        request_id="req-1",
        topic=topic,
        context="用于评估 fake adapter",
        report_type="research_report",
        source_policy=SOURCE_POLICY["PREFER_USER_SOURCES"],  # type: ignore[arg-type]
        source_refs=(),
        timeout_seconds=60,
    )


@pytest.mark.asyncio
async def test_build_adapter_default_is_fake() -> None:
    adapter = build_adapter()
    assert isinstance(adapter, FakeAdapter)
    assert adapter.name == "fake"


@pytest.mark.asyncio
async def test_build_adapter_explicit_fake() -> None:
    adapter = build_adapter(name="fake")
    assert isinstance(adapter, FakeAdapter)


@pytest.mark.asyncio
async def test_factory_result_uses_the_same_adapter_protocol() -> None:
    adapter: ResearchEngineAdapter = build_adapter(name="fake")
    job_id = await adapter.submit(_request())
    status = await adapter.get_status(job_id)
    assert status.job_id == job_id


@pytest.mark.asyncio
async def test_build_adapter_unknown_raises_validation_failed() -> None:
    with pytest.raises(AdapterError) as exc_info:
        build_adapter(name="bogus")
    assert exc_info.value.code == "VALIDATION_FAILED"


@pytest.mark.asyncio
async def test_submit_returns_job_id_and_completes_successfully() -> None:
    adapter = FakeAdapter(default_mode="success")
    req = _request()
    returned = await adapter.submit(req)
    assert returned == req.job_id

    final = await adapter.wait_completion(req.job_id, timeout=2.0)
    assert final.status == AI_JOB_STATUS["SUCCEEDED"]
    assert final.current_step == "write"
    assert final.attempts == 1
    assert len(final.sources) >= PARTIAL_MIN_SOURCES
    # Cost snapshot is numeric, never a string of body.
    assert isinstance(final.cost.token_input_total, int)
    assert isinstance(final.cost.token_output_total, int)
    assert final.cost.cost_cents >= 0
    assert final.error_code is None
    assert final.error_message is None


@pytest.mark.asyncio
async def test_partial_path_when_search_fails_but_has_enough_sources() -> None:
    adapter = FakeAdapter(default_mode="partial")
    req = _request()
    await adapter.submit(req)
    final = await adapter.wait_completion(req.job_id, timeout=2.0)
    # state-machines §1: partial = mid-failure with >= 3 sources, terminal, no draft.
    assert final.status == AI_JOB_STATUS["PARTIAL"]
    assert final.error_code == "WORKER_TIMEOUT"
    assert len(final.sources) >= PARTIAL_MIN_SOURCES
    # `current_step` points to the last successful step. We aborted in
    # `compress`; the last completed step is `search`.
    assert final.current_step == "search"


@pytest.mark.asyncio
async def test_failed_path_when_search_fails_below_threshold() -> None:
    # sources_per_job=1 keeps the source count below PARTIAL_MIN_SOURCES so the
    # script aborts in `search` with FAILED (not PARTIAL).
    adapter = FakeAdapter(default_mode="failed", sources_per_job=1)
    req = _request()
    await adapter.submit(req)
    final = await adapter.wait_completion(req.job_id, timeout=2.0)
    assert final.status == AI_JOB_STATUS["FAILED"]
    assert final.error_code == "AI_ENGINE_UNAVAILABLE"
    # Sources are insufficient (< PARTIAL_MIN_SOURCES), so partial is not allowed.
    assert len(final.sources) < PARTIAL_MIN_SOURCES


@pytest.mark.asyncio
async def test_cancel_queued_job_marks_cancelled() -> None:
    # step_seconds > 0 keeps the job in-flight; we cancel mid-run.
    adapter = FakeAdapter(default_mode="success", step_seconds=0.5)
    req = _request()
    await adapter.submit(req)
    # Cancel as quickly as possible to land before write completes.
    await asyncio.sleep(0.05)
    outcome = await adapter.cancel(req.job_id)
    assert outcome.was_running is True or outcome.was_queued is True
    final = await adapter.get_status(req.job_id)
    assert final.status == AI_JOB_STATUS["CANCELLED"]


@pytest.mark.asyncio
async def test_cancel_succeeded_raises_not_cancellable() -> None:
    adapter = FakeAdapter(default_mode="success")
    req = _request()
    await adapter.submit(req)
    await adapter.wait_completion(req.job_id, timeout=2.0)
    with pytest.raises(AdapterError) as exc_info:
        await adapter.cancel(req.job_id)
    assert exc_info.value.code == "AI_JOB_NOT_CANCELLABLE"


@pytest.mark.asyncio
async def test_get_status_unknown_job_raises_not_found() -> None:
    adapter = FakeAdapter()
    with pytest.raises(AdapterError) as exc_info:
        await adapter.get_status("00000000-0000-0000-0000-000000000000")
    assert exc_info.value.code == "AI_JOB_NOT_FOUND"


@pytest.mark.asyncio
async def test_submit_is_idempotent_on_job_id() -> None:
    adapter = FakeAdapter(default_mode="success")
    req = _request()
    first = await adapter.submit(req)
    second = await adapter.submit(req)
    assert first == second == req.job_id


@pytest.mark.asyncio
async def test_seed_sources_used_by_search_step() -> None:
    adapter = FakeAdapter(default_mode="success")
    req = _request()
    await adapter.submit(req)
    # Overwrite with curated sources; search step should NOT generate new ones.
    from ai_engine.adapters.fake import _default_topic_sources  # noqa: PLC0415

    curated = _default_topic_sources("custom", 3)
    adapter.seed_sources(req.job_id, curated)
    final = await adapter.wait_completion(req.job_id, timeout=2.0)
    keys = {s.canonical_key for s in final.sources}
    assert {s.canonical_key for s in curated}.issubset(keys)


@pytest.mark.asyncio
async def test_health_ok() -> None:
    adapter = FakeAdapter()
    h = await adapter.health()
    assert h.ok is True
    assert h.adapter_name == "fake"


def test_adapter_satisfies_protocol() -> None:
    # Static check: the Protocol is satisfied without a running event loop.
    adapter: ResearchEngineAdapter = FakeAdapter()
    assert isinstance(adapter, ResearchEngineAdapter)
