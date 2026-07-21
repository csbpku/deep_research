"""HTTP server tests — FastAPI TestClient + structlog capture.

These tests exercise the full request/response shape that the Web BFF
will integrate against. We override the singletons via
`app.dependency_overrides` so each test can pick a different adapter
mode (success / partial / failed) without touching env vars.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from ai_engine.adapters.fake import FakeAdapter
from ai_engine.server.app import app, _store_singleton
from ai_engine.job_runner.store import InMemoryJobStore


@pytest.fixture
def client_with_store() -> Iterator[tuple[TestClient, InMemoryJobStore, FakeAdapter]]:
    """Return a TestClient with a fresh in-memory store + fake adapter.

    Defaults to success mode; tests that need partial/failed build their
    own fixture via `_make_client`.
    """
    yield from _make_client(default_mode="success", sources_per_job=5)


def _make_client(
    *, default_mode: str, sources_per_job: int
) -> Iterator[tuple[TestClient, InMemoryJobStore, FakeAdapter]]:
    store = InMemoryJobStore()
    adapter = FakeAdapter(default_mode=default_mode, sources_per_job=sources_per_job)

    app.dependency_overrides[_store_singleton] = lambda: store

    from ai_engine.server import app as app_module  # noqa: PLC0415

    original = app_module._adapter_singleton
    app_module._adapter_singleton = lambda: adapter  # type: ignore[assignment]

    client = TestClient(app)
    try:
        yield client, store, adapter
    finally:
        app_module._adapter_singleton = original  # type: ignore[assignment]
        app.dependency_overrides.clear()


@pytest.fixture
def client_with_partial() -> Iterator[tuple[TestClient, InMemoryJobStore, FakeAdapter]]:
    yield from _make_client(default_mode="partial", sources_per_job=5)


@pytest.fixture
def client_with_failed_low_sources() -> (
    Iterator[tuple[TestClient, InMemoryJobStore, FakeAdapter]]
):
    yield from _make_client(default_mode="failed", sources_per_job=1)


def test_healthz_returns_adapter_metadata(
    client_with_store: tuple[TestClient, InMemoryJobStore, FakeAdapter],
) -> None:
    client, _store, _adapter = client_with_store
    resp = client.get("/healthz")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["adapter"] == "fake"
    assert "request_id" in body
    assert resp.headers.get("x-request-id")


def test_health_alias_works(
    client_with_store: tuple[TestClient, InMemoryJobStore, FakeAdapter],
) -> None:
    client, _store, _adapter = client_with_store
    resp = client.get("/health")
    assert resp.status_code == 200


def test_submit_ai_job_success_returns_succeeded(
    client_with_store: tuple[TestClient, InMemoryJobStore, FakeAdapter],
) -> None:
    client, _store, _adapter = client_with_store
    resp = client.post(
        "/api/ai/jobs",
        json={
            "topic": "RAG 在企业知识库的落地挑战",
            "context": "测试上下文",
            "source_policy": "prefer_user_sources",
        },
    )
    assert resp.status_code == 202
    body = resp.json()
    assert body["final_status"] == "succeeded"
    assert body["sources_count"] >= 3
    assert body["token_input_total"] > 0
    assert body["cost_cents"] >= 0
    assert body["request_id"] == resp.headers.get("x-request-id")


def test_submit_ai_job_partial_records_workflow_state(
    client_with_partial: tuple[TestClient, InMemoryJobStore, FakeAdapter],
) -> None:
    client, _store, _adapter = client_with_partial
    resp = client.post(
        "/api/ai/jobs",
        json={"topic": "国产开源向量数据库横评", "source_policy": "prefer_user_sources"},
    )
    assert resp.status_code == 202
    body = resp.json()
    assert body["final_status"] == "partial"
    assert body["error_code"] == "WORKER_TIMEOUT"


def test_submit_ai_job_failed_when_below_threshold(
    client_with_failed_low_sources: tuple[TestClient, InMemoryJobStore, FakeAdapter],
) -> None:
    client, _store, _adapter = client_with_failed_low_sources
    resp = client.post(
        "/api/ai/jobs",
        json={"topic": "2025 年大模型 Agent 框架对比"},
    )
    assert resp.status_code == 202
    body = resp.json()
    assert body["final_status"] == "failed"
    assert body["error_code"] == "AI_ENGINE_UNAVAILABLE"


def test_submit_rejects_only_user_sources_with_no_refs(
    client_with_store: tuple[TestClient, InMemoryJobStore, FakeAdapter],
) -> None:
    client, _store, _adapter = client_with_store
    resp = client.post(
        "/api/ai/jobs",
        json={"topic": "测试", "source_policy": "only_user_sources"},
    )
    assert resp.status_code == 400
    body = resp.json()
    assert body["detail"]["code"] == "AI_INVALID_SOURCE_POLICY"


def test_submit_rejects_topic_too_short(
    client_with_store: tuple[TestClient, InMemoryJobStore, FakeAdapter],
) -> None:
    client, _store, _adapter = client_with_store
    resp = client.post("/api/ai/jobs", json={"topic": "a"})
    assert resp.status_code == 422  # pydantic validation


def test_get_job_returns_stored_snapshot(
    client_with_store: tuple[TestClient, InMemoryJobStore, FakeAdapter],
) -> None:
    client, _store, _adapter = client_with_store
    submit = client.post("/api/ai/jobs", json={"topic": "用于回查"})
    job_id = submit.json()["job_id"]
    resp = client.get(f"/api/ai/jobs/{job_id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["job_id"] == job_id
    assert body["final_status"] in ("succeeded", "partial", "failed")


def test_get_job_returns_404_when_unknown(
    client_with_store: tuple[TestClient, InMemoryJobStore, FakeAdapter],
) -> None:
    client, _store, _adapter = client_with_store
    resp = client.get("/api/ai/jobs/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404
    body = resp.json()
    assert body["detail"]["code"] == "AI_JOB_NOT_FOUND"


def test_cancel_unknown_job_returns_not_cancellable(
    client_with_store: tuple[TestClient, InMemoryJobStore, FakeAdapter],
) -> None:
    client, _store, _adapter = client_with_store
    resp = client.post("/api/ai/jobs/00000000-0000-0000-0000-000000000000/cancel")
    # fake adapter has no record of this job, so it returns NOT_FOUND
    # which we surface as 404 via HTTP_STATUS map.
    assert resp.status_code in (404, 409)


def test_logs_do_not_contain_secrets(
    client_with_store: tuple[TestClient, InMemoryJobStore, FakeAdapter],
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Ensure the structured logs never include the request body or keys.

    structlog is configured with `JSONRenderer` which writes to stdout
    (not the logging framework). `caplog` would not see those lines, so
    we use `capsys` to capture stdout and assert on the rendered JSON.
    """
    client, _store, _adapter = client_with_store
    sensitive = "sk-THIS-IS-A-SECRET-DO-NOT-LOG"
    client.post(
        "/api/ai/jobs",
        json={"topic": "log test", "context": sensitive},
    )
    captured = capsys.readouterr()
    text = captured.out + captured.err
    # The sensitive token is in the request body but MUST NOT appear in logs.
    assert sensitive not in text, f"secret leaked into logs: {text}"
    # Sanity check that the middleware actually logged a request line.
    assert "ai-engine.request" in text, f"missing request log line: {text}"