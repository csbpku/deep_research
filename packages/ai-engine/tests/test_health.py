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
