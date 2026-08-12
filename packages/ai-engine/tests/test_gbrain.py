import httpx
import pytest

from ai_engine.knowledge.gbrain import GBrainClient, GBrainError, build_gbrain_client


@pytest.mark.asyncio
async def test_gbrain_client_initializes_and_calls_read_tools() -> None:
    calls: list[dict[str, object]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append({"method": request.content.decode()})
        return httpx.Response(200, json={
            "jsonrpc": "2.0",
            "id": "x",
            "result": {"content": [{"type": "text", "text": "answer"}]},
        })

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as http_client:
        client = GBrainClient("http://gbrain.test/mcp", "token", client=http_client)
        result = await client.search_context("RAG evaluation", limit=3)

    assert result["content"][0]["text"] == "answer"
    assert len(calls) == 3
    assert '"method":"initialize"' in str(calls[0])
    assert '"method":"notifications/initialized"' in str(calls[1])
    assert '"name":"query"' in str(calls[2])


@pytest.mark.asyncio
async def test_gbrain_client_fails_closed_on_rpc_error() -> None:
    async def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": "x", "error": {"code": -1}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http_client:
        client = GBrainClient("http://gbrain.test/mcp", "token", client=http_client)
        with pytest.raises(GBrainError):
            await client.search_context("test")


def test_build_gbrain_client_is_disabled_without_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GBRAIN_MCP_URL", raising=False)
    monkeypatch.delenv("GBRAIN_MCP_TOKEN", raising=False)
    assert build_gbrain_client() is None


def test_gbrain_client_parses_sse_jsonrpc_messages() -> None:
    parsed = GBrainClient._parse_sse(
        'event: message\n'
        'data: {"jsonrpc":"2.0","id":"1","result":{"ok":true}}\n'
    )
    assert parsed["result"] == {"ok": True}
