from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from scripts import rescore_active_radar as job


class QuotaError(RuntimeError):
    status_code = 429


def test_minimax_guard_rejects_fallback(monkeypatch):
    monkeypatch.setattr(job, "resolve_primary_and_fallback", lambda *a, **kw: (
        SimpleNamespace(vendor="minimax"), SimpleNamespace(vendor="deepseek"),
    ))
    with pytest.raises(RuntimeError, match="without fallback"):
        job.require_minimax_only()


def test_minimax_guard_checks_heavy_and_light(monkeypatch):
    calls = []

    def route(purpose, *, tier):
        calls.append((purpose, tier))
        return SimpleNamespace(vendor="minimax"), None

    monkeypatch.setattr(job, "resolve_primary_and_fallback", route)
    job.require_minimax_only()
    assert len(calls) == 4


def test_quota_wait_is_conservative():
    error = QuotaError()
    error.response = SimpleNamespace(headers={"retry-after": "30"})
    assert job.quota_wait_seconds(error, 18000) == 18000
    error.response.headers["retry-after"] = "20000"
    assert job.quota_wait_seconds(error, 18000) == 20000


@pytest.mark.asyncio
async def test_quota_pauses_and_retries_same_item_without_enrichment(monkeypatch, tmp_path):
    monkeypatch.setattr(job, "require_minimax_only", lambda: None)
    done = {"existing"}

    async def current(pool, ids):
        return done.intersection(ids)

    monkeypatch.setattr(job, "current_ids", current)
    calls = []
    generation = AsyncMock(side_effect=[QuotaError("limit"), object()])
    monkeypatch.setattr(job, "score_with_llm", generation)

    async def score(pool, **kwargs):
        assert kwargs["suppress_enrichment"] is True
        assert kwargs["concurrency"] == 1
        assert kwargs["only_unscored"] is True
        assert kwargs["rescore"] is False
        calls.append(kwargs["summary_ids"])
        try:
            await kwargs["scorer"]("title", "content")
        except QuotaError:
            return 0
        done.update(kwargs["summary_ids"])
        return 1

    monkeypatch.setattr(job, "score_missing_candidates", score)
    sleep = AsyncMock()
    monkeypatch.setattr(job.asyncio, "sleep", sleep)
    path = tmp_path / "state.json"
    result = await job.run_resumable(SimpleNamespace(pool=None), ("existing", "a"),
                                     path=path, timeout=30, quota_wait=18000)
    state = json.loads(path.read_text())
    assert state["scope"] == job.SCOPE
    assert result == 0
    assert calls == [("a",), ("a",)]
    assert sleep.await_args.args[0] > 17990
    assert state["completed"] == ["a"]
    assert generation.call_args.kwargs["raise_on_error"] is True


@pytest.mark.asyncio
async def test_resume_honors_saved_pause_and_reconciles_committed_score(monkeypatch, tmp_path):
    monkeypatch.setattr(job, "require_minimax_only", lambda: None)
    path = tmp_path / "state.json"
    job.save_state(path, {"version": job.DISTILLED_VERSION, "scope": job.SCOPE, "targets": ["a"],
                         "completed": [], "unresolved": [],
                         "pause_until": job.time.time() + 1000})
    monkeypatch.setattr(job, "current_ids", AsyncMock(return_value={"a"}))
    score = AsyncMock()
    monkeypatch.setattr(job, "score_missing_candidates", score)
    sleep = AsyncMock()
    monkeypatch.setattr(job.asyncio, "sleep", sleep)
    assert await job.run_resumable(SimpleNamespace(pool=None), ("new",),
                                  path=path, timeout=30, quota_wait=18000) == 0
    sleep.assert_awaited_once()
    score.assert_not_awaited()
    assert json.loads(path.read_text())["targets"] == ["a"]


@pytest.mark.asyncio
async def test_resume_rejects_old_rescore_checkpoint(monkeypatch, tmp_path):
    monkeypatch.setattr(job, "require_minimax_only", lambda: None)
    path = tmp_path / "state.json"
    job.save_state(path, {"version": job.DISTILLED_VERSION, "targets": ["a"],
                          "completed": [], "unresolved": [], "pause_until": 0})
    snapshot = path.read_text()
    with pytest.raises(RuntimeError, match="scope mismatch"):
        await job.run_resumable(SimpleNamespace(pool=None), ("a",),
                                path=path, timeout=30, quota_wait=18000)
    assert path.read_text() == snapshot


@pytest.mark.asyncio
async def test_transient_scope_rejects_existing_unscored_checkpoint(monkeypatch, tmp_path):
    monkeypatch.setattr(job, "require_minimax_only", lambda: None)
    path = tmp_path / "state.json"
    job.save_state(path, {
        "version": job.DISTILLED_VERSION, "scope": job.SCOPE, "targets": ["a"],
        "completed": [], "unresolved": [], "pause_until": 0,
    })
    snapshot = path.read_text()
    with pytest.raises(RuntimeError, match="scope mismatch"):
        await job.run_resumable(
            SimpleNamespace(pool=None), ("a",), path=path,
            timeout=30, quota_wait=18000, transient_external=True,
        )
    assert path.read_text() == snapshot


@pytest.mark.asyncio
async def test_transient_scope_uses_source_resolver_without_enrichment(monkeypatch, tmp_path):
    monkeypatch.setattr(job, "require_minimax_only", lambda: None)
    done = set()

    async def current(pool, ids):
        return done.intersection(ids)

    async def score(pool, **kwargs):
        assert kwargs["transient_input"] is job.transient_scoring_input
        assert kwargs["only_unscored"] is True
        assert kwargs["suppress_enrichment"] is True
        done.update(kwargs["summary_ids"])
        return 1

    monkeypatch.setattr(job, "current_ids", current)
    monkeypatch.setattr(job, "score_missing_candidates", score)
    path = tmp_path / "state.json"
    assert await job.run_resumable(
        SimpleNamespace(pool=None), ("a",), path=path, timeout=30,
        quota_wait=18000, transient_external=True,
    ) == 0
    assert json.loads(path.read_text())["scope"] == job.TRANSIENT_SCOPE


@pytest.mark.asyncio
async def test_unresolved_is_not_success_or_quota_pause(monkeypatch, tmp_path):
    monkeypatch.setattr(job, "require_minimax_only", lambda: None)
    monkeypatch.setattr(job, "current_ids", AsyncMock(return_value=set()))
    monkeypatch.setattr(job, "score_missing_candidates", AsyncMock(return_value=0))
    sleep = AsyncMock()
    monkeypatch.setattr(job.asyncio, "sleep", sleep)
    path = tmp_path / "state.json"
    assert await job.run_resumable(SimpleNamespace(pool=None), ("a",),
                                  path=path, timeout=30, quota_wait=18000) == 2
    sleep.assert_not_awaited()
    assert json.loads(path.read_text())["status"] == "completed_with_unresolved"


@pytest.mark.asyncio
async def test_resumable_runner_processes_a_bounded_three_item_batch(
    monkeypatch, tmp_path,
):
    monkeypatch.setattr(job, "require_minimax_only", lambda: None)
    done = set()

    async def current(pool, ids):
        return done.intersection(ids)

    monkeypatch.setattr(job, "current_ids", current)
    monkeypatch.setattr(job, "score_with_llm", AsyncMock(return_value=object()))
    started = asyncio.Event()
    release = asyncio.Event()
    active = 0
    max_active = 0
    calls = []

    async def score(pool, **kwargs):
        nonlocal active, max_active
        assert kwargs["suppress_enrichment"] is True
        assert kwargs["only_unscored"] is True
        assert kwargs["rescore"] is False
        calls.append(kwargs["summary_ids"][0])
        active += 1
        max_active = max(max_active, active)
        if active == 3:
            started.set()
        await started.wait()
        await release.wait()
        await kwargs["scorer"]("title", "content")
        done.update(kwargs["summary_ids"])
        active -= 1
        if len(done) >= 3:
            release.set()
        return 1

    async def open_gate():
        await started.wait()
        release.set()

    monkeypatch.setattr(job, "score_missing_candidates", score)
    monkeypatch.setattr(job.asyncio, "sleep", AsyncMock())
    path = tmp_path / "state.json"
    opener = asyncio.create_task(open_gate())
    result = await job.run_resumable(
        SimpleNamespace(pool=None), ("a", "b", "c", "d"),
        path=path, timeout=30, quota_wait=18000, concurrency=3,
    )
    await opener

    assert result == 0
    assert max_active == 3
    assert set(calls) == {"a", "b", "c", "d"}
    assert set(json.loads(path.read_text())["completed"]) == {"a", "b", "c", "d"}


@pytest.mark.asyncio
async def test_parallel_quota_error_cancels_inflight_items_and_pauses(
    monkeypatch, tmp_path,
):
    monkeypatch.setattr(job, "require_minimax_only", lambda: None)
    done = set()

    async def current(pool, ids):
        return done.intersection(ids)

    monkeypatch.setattr(job, "current_ids", current)
    all_started = asyncio.Event()
    starts = []
    quota_raised = False
    pause_waited = asyncio.Event()

    async def score_with_llm(title, content, **kwargs):
        nonlocal quota_raised
        if title == "a" and not quota_raised:
            quota_raised = True
            raise QuotaError("limit")
        return object()

    monkeypatch.setattr(job, "score_with_llm", score_with_llm)

    async def score(pool, **kwargs):
        target = kwargs["summary_ids"][0]
        starts.append(target)
        if len(starts) == 3:
            all_started.set()
        await all_started.wait()
        if target != "a" and not pause_waited.is_set():
            await asyncio.Event().wait()
        try:
            await kwargs["scorer"](target, "content")
        except QuotaError:
            return 0
        done.add(target)
        return 1

    monkeypatch.setattr(job, "score_missing_candidates", score)

    async def sleep(_delay):
        pause_waited.set()

    monkeypatch.setattr(job.asyncio, "sleep", sleep)
    path = tmp_path / "state.json"
    result = await job.run_resumable(
        SimpleNamespace(pool=None), ("a", "b", "c", "d"),
        path=path, timeout=30, quota_wait=18000, concurrency=3,
    )

    assert result == 0
    assert starts[:3] == ["a", "b", "c"]
    assert pause_waited.is_set()
    assert set(starts) == {"a", "b", "c", "d"}
    state = json.loads(path.read_text())
    assert state["status"] == "completed"
    assert set(state["completed"]) == {"a", "b", "c", "d"}
