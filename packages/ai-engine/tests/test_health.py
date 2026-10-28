import httpx
import pytest

from ai_engine.server.app import app


@pytest.mark.asyncio
async def test_health() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health")

    assert response.status_code == 200
    body = response.json()
    # /health is the legacy alias of /healthz; it returns adapter metadata.
    assert body["status"] == "ok"
    assert body["adapter"] == "fake"


@pytest.mark.asyncio
async def test_healthz_reports_degraded_when_internal_token_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """令牌缺失时业务接口会 503；健康检查必须先暴露这个配置缺口。"""
    monkeypatch.delenv("INTERNAL_SERVICE_TOKEN", raising=False)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/healthz")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "degraded"
    assert body["internal_token_configured"] == "false"
