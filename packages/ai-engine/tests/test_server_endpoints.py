"""HTTP server tests — FastAPI async test client.

These tests exercise the full request/response shape that the Web BFF
will integrate against. We override the singletons via
`app.dependency_overrides` so each test can pick a different adapter
mode (success / partial / failed) without touching env vars.

Week 1 review 修正:submit 改 fire-and-forget 后台 task,HTTP 立即返回 202
+ status="queued"。同步 TestClient 不会排空 asyncio.create_task(同一线程,
time.sleep 阻塞 event loop 排不到后台任务),所以测试改用 httpx.AsyncClient
+ ASGITransport,后台 task 能在 await 点被排到。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import httpx
import pytest
from httpx import ASGITransport

from ai_engine.adapters.fake import FakeAdapter
from ai_engine.server.app import app, _store_singleton
from ai_engine.job_runner.store import InMemoryJobStore


# 轮询窗口:5s;fake adapter 正常 51ms 跑完,留余量
_POLL_TIMEOUT_SECONDS = 5.0
_POLL_INTERVAL_SECONDS = 0.05


async def _wait_final_status(client: httpx.AsyncClient, job_id: str, timeout: float = _POLL_TIMEOUT_SECONDS) -> dict:
    """轮询 GET 直到 final_status 出现;超时抛 AssertionError。"""
    deadline = asyncio.get_event_loop().time() + timeout
    last_body: dict = {}
    while asyncio.get_event_loop().time() < deadline:
        resp = await client.get(f"/api/ai/jobs/{job_id}")
        assert resp.status_code == 200, f"GET returned {resp.status_code}: {resp.text}"
        last_body = resp.json()
        if last_body.get("final_status") in ("succeeded", "partial", "failed", "cancelled"):
            return last_body
        await asyncio.sleep(_POLL_INTERVAL_SECONDS)
    raise AssertionError(
        f"job {job_id} did not reach a final status within {timeout}s; last_body={last_body}"
    )


async def _make_client(
    *, default_mode: str, sources_per_job: int
) -> AsyncIterator[tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter]]:
    """Build a fresh in-memory store + fake adapter; yield an async HTTPX client.

    async context 是关键 — sync TestClient 模式下 asyncio.create_task 在
    time.sleep 阻塞期间无法被排到;async + await sleep 才能驱动后台 task。
    """
    store = InMemoryJobStore()
    adapter = FakeAdapter(default_mode=default_mode, sources_per_job=sources_per_job)

    app.dependency_overrides[_store_singleton] = lambda: store

    from ai_engine.server import app as app_module  # noqa: PLC0415

    original = app_module._adapter_singleton
    app_module._adapter_singleton = lambda: adapter  # type: ignore[assignment]

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        try:
            yield client, store, adapter
        finally:
            app_module._adapter_singleton = original  # type: ignore[assignment]
            app.dependency_overrides.clear()


@pytest.fixture
async def client_with_store() -> AsyncIterator[tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter]]:
    async for c in _make_client(default_mode="success", sources_per_job=5):
        yield c


@pytest.fixture
async def client_with_partial() -> AsyncIterator[tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter]]:
    async for c in _make_client(default_mode="partial", sources_per_job=5):
        yield c


@pytest.fixture
async def client_with_failed_low_sources() -> (
    AsyncIterator[tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter]]
):
    async for c in _make_client(default_mode="failed", sources_per_job=1):
        yield c


@pytest.fixture
async def client_with_no_sources() -> (
    AsyncIterator[tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter]]
):
    """W7 (工程师 B): fake adapter that succeeds but captures zero
    sources — used to verify the inferred flag is set in the
    HTTP response.
    """
    async for c in _make_client(default_mode="success", sources_per_job=0):
        yield c


async def test_submit_inferred_flag_when_no_sources(
    client_with_no_sources: tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter],
) -> None:
    """W7 (工程师 B): when the engine succeeds without capturing any
    source, the GET response carries ``is_inferred: True`` so the
    BFF can render it as an inferred (no-source) conclusion.
    """
    client, _store, _adapter = client_with_no_sources
    resp = await client.post(
        "/api/ai/jobs",
        json={"topic": "没有任何来源的主题", "source_policy": "prefer_user_sources"},
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]
    final = await _wait_final_status(client, job_id)
    assert final["final_status"] == "succeeded"
    assert final["is_inferred"] is True
    assert final["sources_count"] == 0


async def test_submit_inferred_false_when_sources_captured(
    client_with_store: tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter],
) -> None:
    """W7 (工程师 B): when sources ARE captured, the inferred flag
    is False (not just absent).
    """
    client, _store, _adapter = client_with_store
    resp = await client.post(
        "/api/ai/jobs",
        json={"topic": "有来源的主题", "source_policy": "prefer_user_sources"},
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]
    final = await _wait_final_status(client, job_id)
    assert final["final_status"] == "succeeded"
    assert final["is_inferred"] is False
    assert final["sources_count"] >= 3


async def test_healthz_returns_adapter_metadata(
    client_with_store: tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter],
) -> None:
    client, _store, _adapter = client_with_store
    resp = await client.get("/healthz")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["adapter"] == "fake"
    assert "request_id" in body
    assert resp.headers.get("x-request-id")


async def test_health_alias_works(
    client_with_store: tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter],
) -> None:
    client, _store, _adapter = client_with_store
    resp = await client.get("/health")
    assert resp.status_code == 200


async def test_submit_returns_202_immediately_with_queued(
    client_with_store: tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter],
) -> None:
    """新合约:POST 在 2s 内返回 202 + status='queued',不阻塞等终态。"""
    client, _store, _adapter = client_with_store
    loop = asyncio.get_event_loop()
    started = loop.time()
    resp = await client.post(
        "/api/ai/jobs",
        json={
            "topic": "RAG 在企业知识库的落地挑战",
            "context": "测试上下文",
            "source_policy": "prefer_user_sources",
        },
    )
    elapsed = loop.time() - started
    assert resp.status_code == 202
    assert elapsed < 2.0, f"submit took {elapsed:.3f}s, must be <2s"
    body = resp.json()
    assert body["status"] == "queued"
    assert body["final_status"] is None
    assert body["current_step"] is None
    assert body["sources_count"] == 0
    assert body["request_id"] == resp.headers.get("x-request-id")


async def test_submit_success_reaches_succeeded_via_polling(
    client_with_store: tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter],
) -> None:
    """POST 后立刻 202+queued;轮询 GET 直到 succeeded。"""
    client, _store, _adapter = client_with_store
    resp = await client.post(
        "/api/ai/jobs",
        json={
            "topic": "RAG 在企业知识库的落地挑战",
            "context": "测试上下文",
            "source_policy": "prefer_user_sources",
        },
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]

    final = await _wait_final_status(client, job_id)
    assert final["final_status"] == "succeeded"
    assert final["sources_count"] >= 3
    assert final["token_input_total"] > 0
    assert final["cost_cents"] >= 0


async def test_submit_partial_records_workflow_state(
    client_with_partial: tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter],
) -> None:
    client, _store, _adapter = client_with_partial
    resp = await client.post(
        "/api/ai/jobs",
        json={"topic": "国产开源向量数据库横评", "source_policy": "prefer_user_sources"},
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]

    final = await _wait_final_status(client, job_id)
    assert final["final_status"] == "partial"
    assert final["error_code"] == "WORKER_TIMEOUT"
    assert final["error_stage"] == "search"


async def test_submit_failed_when_below_threshold(
    client_with_failed_low_sources: tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter],
) -> None:
    client, _store, _adapter = client_with_failed_low_sources
    resp = await client.post(
        "/api/ai/jobs",
        json={"topic": "2025 年大模型 Agent 框架对比"},
    )
    assert resp.status_code == 202
    job_id = resp.json()["job_id"]

    final = await _wait_final_status(client, job_id)
    assert final["final_status"] == "failed"
    assert final["error_code"] == "AI_ENGINE_UNAVAILABLE"


async def test_submit_rejects_only_user_sources_with_no_refs(
    client_with_store: tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter],
) -> None:
    client, _store, _adapter = client_with_store
    resp = await client.post(
        "/api/ai/jobs",
        json={"topic": "测试", "source_policy": "only_user_sources"},
    )
    assert resp.status_code == 400
    body = resp.json()
    assert body["detail"]["code"] == "AI_INVALID_SOURCE_POLICY"


async def test_submit_rejects_topic_too_short(
    client_with_store: tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter],
) -> None:
    client, _store, _adapter = client_with_store
    resp = await client.post("/api/ai/jobs", json={"topic": "a"})
    assert resp.status_code == 422  # pydantic validation


# ───────────── W7 (engineer B): quota hard-limit / soft-reminder ─────────────


class _QuotaStoreProxy:
    """Test helper — wraps an InMemoryJobStore and overrides
    ``count_submissions_today`` so we can pin the quota at 0/1/2/...
    without seeding real rows.
    """

    def __init__(self, inner: InMemoryJobStore, *, user_count: int, team_count: int) -> None:
        self._inner = inner
        self._user_count = user_count
        self._team_count = team_count

    def __getattr__(self, name: str) -> object:
        return getattr(self._inner, name)

    async def count_submissions_today(
        self,
        *,
        requester_id: str | None = None,
        team_scope: bool = False,
    ) -> int:
        if team_scope:
            return self._team_count
        return self._user_count


async def _make_quota_client(
    *, user_count: int, team_count: int
) -> AsyncIterator[tuple[httpx.AsyncClient, FakeAdapter]]:
    """Build a client backed by a proxy store that returns canned quota counts.

    Tests pass ``user_count`` and ``team_count`` to force a specific
    branch in the quota check (acceptance vs. 429).
    """
    store = InMemoryJobStore()
    adapter = FakeAdapter(default_mode="success", sources_per_job=5)
    proxy = _QuotaStoreProxy(store, user_count=user_count, team_count=team_count)

    app.dependency_overrides[_store_singleton] = lambda: proxy
    from ai_engine.server import app as app_module  # noqa: PLC0415
    original = app_module._adapter_singleton
    app_module._adapter_singleton = lambda: adapter  # type: ignore[assignment]

    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        try:
            yield client, adapter
        finally:
            app_module._adapter_singleton = original  # type: ignore[assignment]
            app.dependency_overrides.clear()


async def test_submit_rejects_user_quota_exceeded() -> None:
    """When the user has already used 5 of 5 (default BUDGET_USER_DAILY),
    a new submission returns 429 AI_QUOTA_EXCEEDED with ``scope='user'``.
    """
    async for client, _adapter in _make_quota_client(user_count=5, team_count=0):
        resp = await client.post(
            "/api/ai/jobs",
            json={"topic": "配额已满测试", "requester_id": "00000000-0000-0000-0000-000000000001"},
        )
    assert resp.status_code == 429
    body = resp.json()
    assert body["detail"]["code"] == "AI_QUOTA_EXCEEDED"
    assert body["detail"]["details"]["scope"] == "user"
    assert body["detail"]["details"]["used"] == 5
    assert body["detail"]["details"]["limit"] == 5


async def test_submit_rejects_team_quota_exceeded() -> None:
    """Team hard-cap of 20/day is independent of per-user cap. If the
    user still has budget but the team has used 20/20, reject with
    ``scope='team'``.
    """
    async for client, _adapter in _make_quota_client(user_count=0, team_count=20):
        resp = await client.post(
            "/api/ai/jobs",
            json={"topic": "团队配额已满", "requester_id": "00000000-0000-0000-0000-000000000001"},
        )
    assert resp.status_code == 429
    body = resp.json()
    assert body["detail"]["code"] == "AI_QUOTA_EXCEEDED"
    assert body["detail"]["details"]["scope"] == "team"
    assert body["detail"]["details"]["used"] == 20
    assert body["detail"]["details"]["limit"] == 20


async def test_submit_accepts_when_under_user_quota() -> None:
    """Under the 5/day limit the submission must succeed (202 queued)."""
    async for client, _adapter in _make_quota_client(user_count=2, team_count=5):
        resp = await client.post(
            "/api/ai/jobs",
            json={"topic": "低于配额", "requester_id": "00000000-0000-0000-0000-000000000001"},
        )
    assert resp.status_code == 202


async def test_get_job_returns_stored_snapshot(
    client_with_store: tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter],
) -> None:
    client, _store, _adapter = client_with_store
    submit = await client.post("/api/ai/jobs", json={"topic": "用于回查"})
    assert submit.status_code == 202
    job_id = submit.json()["job_id"]
    # 等后台 task 跑完,再断言 final_status 落定
    final = await _wait_final_status(client, job_id)
    assert final["job_id"] == job_id
    assert final["status"] == "stored"
    assert final["final_status"] in ("succeeded", "partial", "failed")
    assert final["topic"] == "用于回查"
    assert final["partial_sources_count"] >= 3
    assert final["failed_sources_count"] == 0
    assert final["error_stage"] is None
    assert "draft_research_id" in final
    assert final["draft_research_id"] is not None
    for field in ("started_at", "created_at", "completed_at"):
        assert field in final


async def test_get_job_returns_404_when_unknown(
    client_with_store: tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter],
) -> None:
    client, _store, _adapter = client_with_store
    resp = await client.get("/api/ai/jobs/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404
    body = resp.json()
    assert body["detail"]["code"] == "AI_JOB_NOT_FOUND"


async def test_cancel_unknown_job_returns_not_cancellable(
    client_with_store: tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter],
) -> None:
    client, _store, _adapter = client_with_store
    resp = await client.post("/api/ai/jobs/00000000-0000-0000-0000-000000000000/cancel")
    # fake adapter has no record of this job, so it returns NOT_FOUND
    # which we surface as 404 via HTTP_STATUS map.
    assert resp.status_code in (404, 409)


async def test_logs_do_not_contain_secrets(
    client_with_store: tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter],
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Ensure the structured logs never include the request body or keys."""
    client, _store, _adapter = client_with_store
    sensitive = "sk-THIS-IS-A-SECRET-DO-NOT-LOG"
    await client.post(
        "/api/ai/jobs",
        json={"topic": "log test", "context": sensitive},
    )
    # 让 event loop 把 stdout flush 完
    await asyncio.sleep(0.05)
    captured = capsys.readouterr()
    text = captured.out + captured.err
    assert sensitive not in text, f"secret leaked into logs: {text}"
    assert "ai-engine.request" in text, f"missing request log line: {text}"


async def test_logging_failure_does_not_replace_json_response(
    client_with_store: tuple[httpx.AsyncClient, InMemoryJobStore, FakeAdapter],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A broken/reconfigured structlog must not turn a valid response into text 500."""

    class BrokenLogger:
        def info(self, *_args: object, **_kwargs: object) -> None:
            raise RuntimeError("logging backend unavailable")

    client, _store, _adapter = client_with_store
    monkeypatch.setattr(
        "ai_engine.server.app.structlog.get_logger",
        lambda *_args, **_kwargs: BrokenLogger(),
    )

    response = await client.get("/health")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["status"] == "ok"
