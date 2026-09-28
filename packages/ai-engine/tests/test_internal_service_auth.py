from __future__ import annotations

from fastapi.testclient import TestClient

from ai_engine.server.app import app


def test_all_non_health_routes_fail_closed_without_internal_token(monkeypatch) -> None:
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "reader-test-service-token")
    monkeypatch.setenv("JOB_RUNNER_BACKEND", "memory")
    client = TestClient(app)

    for path in (
        "/api/ai/jobs?requester_id=synthetic-user",
        "/api/ai/research-assistant",
        "/api/knowledge-index/search",
    ):
        response = client.get(path)
        assert response.status_code == 403
        assert response.json()["code"] == "INTERNAL_TOKEN_MISMATCH"

    response = client.get(
        "/api/ai/jobs?requester_id=synthetic-user",
        headers={"x-internal-token": "wrong-token"},
    )
    assert response.status_code == 403


def test_valid_internal_token_reaches_engine_route(monkeypatch) -> None:
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "reader-test-service-token")
    monkeypatch.setenv("JOB_RUNNER_BACKEND", "memory")
    client = TestClient(app)

    response = client.get(
        "/api/ai/jobs?requester_id=11111111-1111-4111-8111-111111111111",
        headers={"x-internal-token": "reader-test-service-token"},
    )

    assert response.status_code == 200


def test_non_health_routes_fail_closed_if_internal_token_is_unconfigured(monkeypatch) -> None:
    monkeypatch.delenv("INTERNAL_SERVICE_TOKEN", raising=False)
    client = TestClient(app)

    response = client.get("/api/ai/jobs?requester_id=synthetic-user")

    assert response.status_code == 503
    assert response.json()["code"] == "INTERNAL_TOKEN_NOT_CONFIGURED"
