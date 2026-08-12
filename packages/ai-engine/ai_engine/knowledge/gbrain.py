"""Read-only HTTP MCP adapter for an optional GBrain sidecar.

The application remains the system of record. This client only calls GBrain's
read-scoped ``query`` and ``think`` tools and never imports its database schema.
"""

from __future__ import annotations

import os
import uuid
from typing import Any

import httpx


class GBrainError(RuntimeError):
    """Raised when the optional GBrain sidecar cannot answer safely."""


class GBrainClient:
    def __init__(
        self,
        mcp_url: str,
        token: str,
        *,
        timeout: float = 15.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not mcp_url.startswith(("http://", "https://")):
            raise ValueError("GBrain MCP URL must use http or https")
        if not token.strip():
            raise ValueError("GBrain MCP token is required")
        self.mcp_url = mcp_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        self._client = client
        self._initialized = False

    async def _request(self, method: str, params: dict[str, Any] | None = None) -> Any:
        request_id = str(uuid.uuid4())
        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if not method.startswith("notifications/"):
            payload["id"] = request_id
        if params is not None:
            payload["params"] = params
        own_client = self._client is None
        client = self._client or httpx.AsyncClient(timeout=self.timeout)
        try:
            response = await client.post(
                self.mcp_url,
                headers={
                    "accept": "application/json, text/event-stream",
                    "authorization": f"Bearer {self.token}",
                    "content-type": "application/json",
                },
                json=payload,
            )
            response.raise_for_status()
            if response.status_code in {202, 204} and not response.content:
                return None
            if response.headers.get("content-type", "").startswith("text/event-stream"):
                data = self._parse_sse(response.text)
            else:
                data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise GBrainError(f"GBrain MCP request failed: {type(exc).__name__}") from exc
        finally:
            if own_client:
                await client.aclose()

        if not isinstance(data, dict):
            raise GBrainError("GBrain MCP returned a non-object response")
        if "error" in data:
            raise GBrainError("GBrain MCP returned an error")
        return data.get("result")

    @staticmethod
    def _parse_sse(body: str) -> dict[str, Any]:
        for line in body.splitlines():
            if line.startswith("data:"):
                value = line[5:].strip()
                if value:
                    import json

                    parsed = json.loads(value)
                    if isinstance(parsed, dict):
                        return parsed
        raise GBrainError("GBrain MCP returned an empty SSE response")

    async def _ensure_initialized(self) -> None:
        if self._initialized:
            return
        await self._request(
            "initialize",
            {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "deep-research", "version": "0.1"},
            },
        )
        await self._request("notifications/initialized")
        self._initialized = True

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        await self._ensure_initialized()
        return await self._request("tools/call", {"name": name, "arguments": arguments})

    async def search_context(self, question: str, *, limit: int = 8) -> Any:
        return await self.call_tool("query", {
            "query": question,
            "limit": max(1, min(limit, 20)),
            "detail": "medium",
            "expand": True,
            "relational": True,
        })

    async def synthesize_topic(self, question: str) -> Any:
        return await self.call_tool("think", {"question": question, "rounds": 1})

    async def find_related_radar(self, question: str, *, limit: int = 8) -> Any:
        return await self.search_context(question, limit=limit)


def build_gbrain_client() -> GBrainClient | None:
    """Build the optional client only when both env values are configured."""
    url = os.environ.get("GBRAIN_MCP_URL", "").strip()
    token = os.environ.get("GBRAIN_MCP_TOKEN", "").strip()
    if not url or not token:
        return None
    return GBrainClient(url, token)


__all__ = ["GBrainClient", "GBrainError", "build_gbrain_client"]
