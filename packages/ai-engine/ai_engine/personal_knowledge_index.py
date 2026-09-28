"""Optional, per-user AnythingLLM index for explicitly saved research knowledge."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import uuid
from dataclasses import dataclass
from typing import Any, cast
from urllib.parse import urlsplit, urlunsplit

import httpx

logger = logging.getLogger("ai_engine.personal_knowledge_index")
_DOCUMENT_TITLE_PREFIX = "dr-private-knowledge:"
_DOCUMENT_ID_RE = re.compile(r"^dr-private-knowledge:([0-9a-f-]{36})$", re.IGNORECASE)
_DOCUMENT_NORMALIZED_TITLE_RE = re.compile(
    r"^dr-private-knowledge-([0-9a-f-]{36})\.txt$", re.IGNORECASE
)
_DOCUMENT_URL_RE = re.compile(r"^deep-research://knowledge/([0-9a-f-]{36})/?$", re.IGNORECASE)


def personal_knowledge_index_enabled() -> bool:
    return (
        os.environ.get("ANYTHINGLLM_PERSONAL_KNOWLEDGE_ENABLED", "0").strip().lower()
        in {"1", "true", "yes"}
        and bool(os.environ.get("ANYTHINGLLM_URL", "").strip())
        and bool(os.environ.get("ANYTHINGLLM_API_KEY", "").strip())
    )


def workspace_name(user_id: str) -> str:
    return f"dr-private-{uuid.UUID(user_id).hex}"


def _object(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _workspace_rows(payload: object) -> list[dict[str, Any]]:
    data = _object(payload)
    value = data.get("workspaces", data.get("workspace", []))
    if isinstance(value, dict):
        value = [value]
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _workspace_slug(payload: object) -> str | None:
    data = _object(payload)
    nested = _object(data.get("workspace"))
    for value in (nested.get("slug"), data.get("slug")):
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _record_id(candidate: object) -> str | None:
    if not isinstance(candidate, str):
        return None
    value = candidate.strip()
    match = (
        _DOCUMENT_ID_RE.fullmatch(value)
        or _DOCUMENT_NORMALIZED_TITLE_RE.fullmatch(value)
        or _DOCUMENT_URL_RE.fullmatch(value)
    )
    if not match:
        return None
    try:
        return str(uuid.UUID(match.group(1)))
    except ValueError:
        return None


def _document_rows(payload: object) -> list[dict[str, Any]]:
    data = _object(payload)
    rows = data.get("documents")
    if not isinstance(rows, list):
        raise ValueError("AnythingLLM document listing returned an invalid response")
    return [item for item in rows if isinstance(item, dict)]


def _personal_document_path(row: dict[str, Any], research_id: str) -> str | None:
    candidates = (
        row.get("docSource"),
        row.get("title"),
        row.get("url"),
        row.get("name"),
        row.get("location"),
    )
    if not any(_record_id(value) == research_id for value in candidates):
        return None

    raw_path = row.get("location") or row.get("path") or row.get("name")
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None
    path = raw_path.strip().lstrip("/")
    if path.startswith("custom-documents/"):
        relative = path.removeprefix("custom-documents/")
    elif "/" not in path and path not in {".", ".."}:
        relative = path
    else:
        return None
    if not relative or any(part in {".", ".."} for part in relative.split("/")):
        return None
    return f"custom-documents/{relative}"


def _safe_citation_url(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parts = urlsplit(value.strip())
        scheme = parts.scheme.lower()
        hostname = parts.hostname
        port = parts.port
    except ValueError:
        return None
    if scheme not in {"http", "https"} or not hostname:
        return None
    host = f"[{hostname}]" if ":" in hostname and not hostname.startswith("[") else hostname
    if port and not (scheme == "http" and port == 80) and not (scheme == "https" and port == 443):
        host = f"{host}:{port}"
    return urlunsplit((scheme, host, parts.path, "", ""))


def _build_document_text(title: str, body: str, citations: list[str]) -> str:
    title_text = title.strip()[:300]
    citation_rows = [item.strip()[:700] for item in citations[:5] if item.strip()]
    citation_text = "来源参考：\n" + "\n".join(citation_rows) if citation_rows else ""
    parts = [part for part in (title_text, body.strip(), citation_text) if part]
    return "\n\n".join(parts)


def extract_personal_knowledge_ids(payload: object, *, limit: int = 4) -> list[str]:
    """Extract only record IDs from vector results; never forward vector text."""
    data = _object(payload)
    results = data.get("results", data.get("data", []))
    if isinstance(results, dict):
        results = results.get("results", [])
    if not isinstance(results, list):
        return []
    ids: list[str] = []
    for raw in results:
        row = _object(raw)
        metadata = _object(row.get("metadata"))
        candidates = (
            metadata.get("title"),
            row.get("title"),
            metadata.get("docSource"),
            metadata.get("source"),
            metadata.get("url"),
            row.get("url"),
        )
        for candidate in candidates:
            record_id = _record_id(candidate)
            if record_id:
                if record_id not in ids:
                    ids.append(record_id)
                break
        if len(ids) >= max(1, min(limit, 8)):
            break
    return ids


class AnythingLLMClient:
    def __init__(self, *, timeout_seconds: float = 30.0) -> None:
        self.base_url = os.environ.get("ANYTHINGLLM_URL", "").strip().rstrip("/")
        self.api_key = os.environ.get("ANYTHINGLLM_API_KEY", "").strip()
        if not self.base_url or not self.api_key:
            raise RuntimeError("personal AnythingLLM index is not configured")
        self.timeout_seconds = timeout_seconds

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    async def _json_request(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, object] | None = None,
    ) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
            response = await client.request(
                method,
                f"{self.base_url}/api/v1{path}",
                headers=self._headers(),
                json=payload,
            )
        response.raise_for_status()
        payload_result = _object(response.json())
        if payload_result.get("success") is False or payload_result.get("error"):
            raise RuntimeError("AnythingLLM rejected the request")
        return payload_result

    async def get_workspace(self, user_id: str, *, create: bool) -> str | None:
        expected_name = workspace_name(user_id)
        payload = await self._json_request("GET", "/workspaces")
        for row in _workspace_rows(payload):
            if row.get("name") == expected_name or row.get("slug") == expected_name:
                slug = row.get("slug")
                return str(slug) if isinstance(slug, str) and slug else expected_name
        if not create:
            return None

        created = await self._json_request(
            "POST",
            "/workspace/new",
            payload={"name": expected_name},
        )
        slug = _workspace_slug(created)
        if slug:
            return slug
        for row in _workspace_rows(created):
            value = row.get("slug")
            if isinstance(value, str) and value:
                return value
        # AnythingLLM derives the slug from this lowercase ASCII name.
        if any(row.get("name") == expected_name for row in _workspace_rows(created)):
            return expected_name
        raise ValueError("AnythingLLM did not return the personal workspace slug")

    async def vector_search(self, user_id: str, query: str, *, limit: int = 4) -> list[str]:
        slug = await self.get_workspace(user_id, create=False)
        if not slug:
            return []
        payload = await self._json_request(
            "POST",
            f"/workspace/{slug}/vector-search",
            payload={"query": query[:2_000], "topN": max(1, min(limit, 8))},
        )
        return extract_personal_knowledge_ids(payload, limit=limit)

    async def remove_document(self, workspace_slug: str | None, document_path: str | None) -> None:
        if not document_path:
            return
        if workspace_slug:
            await self._json_request(
                "POST",
                f"/workspace/{workspace_slug}/update-embeddings",
                payload={"adds": [], "deletes": [document_path]},
            )
        await self._json_request(
            "DELETE",
            "/system/remove-documents",
            payload={"names": [document_path]},
        )

    async def list_personal_document_paths(self, research_id: str) -> list[str]:
        paths: list[str] = []
        offset = 0
        page_size = 500
        while True:
            payload = await self._json_request(
                "GET",
                f"/documents/folder/custom-documents?offset={offset}&limit={page_size}",
            )
            rows = _document_rows(payload)
            for row in rows:
                path = _personal_document_path(row, research_id)
                if path and path not in paths:
                    paths.append(path)
            offset += len(rows)
            if len(rows) < page_size:
                return paths
            if not rows:
                return paths

    async def upload_text(self, research_id: str, title: str, text: str) -> str:
        payload = await self._json_request(
            "POST",
            "/document/raw-text",
            payload={
                "textContent": text,
                "metadata": {
                    "title": f"{_DOCUMENT_TITLE_PREFIX}{research_id}",
                    "description": title[:300],
                    "docAuthor": "Deep Research",
                    # AnythingLLM normalizes raw-text titles and only preserves HTTP(S) URLs.
                    "docSource": f"deep-research://knowledge/{research_id}",
                },
            },
        )
        documents = payload.get("documents")
        if not isinstance(documents, list) or not documents:
            raise ValueError("AnythingLLM raw-text upload returned no document")
        document = _object(documents[0])
        for key in ("location", "id", "path", "filePath"):
            value = document.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        raise ValueError("AnythingLLM raw-text upload returned no document path")

    async def embed_document(self, workspace_slug: str, document_path: str) -> None:
        await self._json_request(
            "POST",
            f"/workspace/{workspace_slug}/update-embeddings",
            payload={"adds": [document_path], "deletes": []},
        )


@dataclass(frozen=True, slots=True)
class IndexLease:
    task_id: str
    owner_id: str
    research_id: str
    operation: str
    generation: int
    attempts: int
    workspace_slug: str | None
    document_path: str | None
    content_hash: str | None
    worker_id: str


async def _claim(pool: Any, worker_id: str, *, task_id: str | None = None) -> IndexLease | None:
    lease_seconds = max(60, int(os.environ.get("KNOWLEDGE_INDEX_LEASE_SECONDS", "300")))
    task_filter = ' AND "id" = %s' if task_id else ""
    params: tuple[object, ...] = (
        (task_id, worker_id, lease_seconds) if task_id else (worker_id, lease_seconds)
    )
    async with pool.connection() as conn:
        async with conn.transaction():
            row = await (
                await conn.execute(
                    'WITH picked AS ('
                    ' SELECT "id" FROM "personal_knowledge_index_tasks"'
                    ' WHERE ("status" = \'queued\' OR ("status" = \'processing\' AND "leaseExpiresAt" < now()))'
                    ' AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= now())'
                    ' AND ("lockedBy" IS NULL OR "leaseExpiresAt" < now())'
                    f'{task_filter}'
                    ' ORDER BY "updatedAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1'
                    ') UPDATE "personal_knowledge_index_tasks" t SET'
                    ' "status" = \'processing\', "lockedBy" = %s,'
                    ' "leaseExpiresAt" = now() + (%s * interval \'1 second\'),'
                    ' "attempts" = t."attempts" + 1, "updatedAt" = now()'
                    ' FROM picked WHERE t."id" = picked."id"'
                    ' RETURNING t."id", t."ownerId", t."researchId", t."operation",'
                    ' t."generation", t."attempts", t."workspaceSlug", t."documentPath", t."contentHash"',
                    params,
                )
            ).fetchone()
    if row is None:
        return None
    values = cast(dict[str, Any], row)
    return IndexLease(
        task_id=str(values["id"]),
        owner_id=str(values["ownerId"]),
        research_id=str(values["researchId"]),
        operation=str(values["operation"]),
        generation=int(values["generation"]),
        attempts=int(values["attempts"]),
        workspace_slug=values.get("workspaceSlug"),
        document_path=values.get("documentPath"),
        content_hash=values.get("contentHash"),
        worker_id=worker_id,
    )


async def _load_current_document(pool: Any, lease: IndexLease) -> tuple[str, str, list[str]] | None:
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT "title", "knowledgeIndexText" FROM "researches"'
                ' WHERE "id" = %s AND "authorId" = %s AND "type" = \'knowledge\' AND "status" = \'draft\' '
                ' AND "knowledgeIndexText" IS NOT NULL AND btrim("knowledgeIndexText") <> \'\'',
                (lease.research_id, lease.owner_id),
            )
        ).fetchone()
        if row is None:
            return None
        value = cast(dict[str, Any], row)
        sources = await (
            await conn.execute(
                'SELECT "canonicalKey", "title" FROM "research_sources"'
                ' WHERE "researchId" = %s ORDER BY "createdAt" ASC LIMIT 5',
                (lease.research_id,),
            )
        ).fetchall()
    citations: list[str] = []
    for raw in sources:
        source = cast(dict[str, Any], raw)
        canonical = _safe_citation_url(source.get("canonicalKey"))
        title = str(source.get("title") or "").strip()
        if canonical:
            citations.append(f"- {title[:180] or canonical[:180]} ({canonical[:500]})")
    return str(value["title"]), str(value["knowledgeIndexText"]), citations


async def _persist_document_path(pool: Any, lease: IndexLease, workspace_slug: str, path: str) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            'UPDATE "personal_knowledge_index_tasks" SET "workspaceSlug" = %s, "documentPath" = %s,'
            ' "contentHash" = NULL, "updatedAt" = now() WHERE "id" = %s AND "lockedBy" = %s',
            (workspace_slug, path, lease.task_id, lease.worker_id),
        )
        await conn.commit()


async def _finish(pool: Any, lease: IndexLease, *, content_hash: str | None, deleted: bool) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            'UPDATE "personal_knowledge_index_tasks" SET'
            ' "status" = CASE WHEN "generation" = %s THEN \'completed\' ELSE \'queued\' END,'
            ' "documentPath" = CASE WHEN "generation" = %s AND %s THEN NULL ELSE "documentPath" END,'
            ' "contentHash" = CASE WHEN "generation" = %s THEN %s ELSE "contentHash" END,'
            ' "nextRetryAt" = NULL, "lockedBy" = NULL, "leaseExpiresAt" = NULL, "lastError" = NULL,'
            ' "updatedAt" = now() WHERE "id" = %s AND "lockedBy" = %s',
            (
                lease.generation,
                lease.generation,
                deleted,
                lease.generation,
                content_hash,
                lease.task_id,
                lease.worker_id,
            ),
        )
        await conn.commit()


async def _fail(pool: Any, lease: IndexLease, error: Exception) -> None:
    delay = min(3_600, 15 * (2 ** min(max(lease.attempts - 1, 0), 8)))
    message = f"{type(error).__name__}: {str(error)[:420]}"[:500]
    async with pool.connection() as conn:
        await conn.execute(
            'UPDATE "personal_knowledge_index_tasks" SET'
            ' "status" = CASE WHEN "generation" <> %s THEN \'queued\' '
            'WHEN "operation" = \'delete\' THEN \'queued\' '
            'WHEN "attempts" >= 12 THEN \'failed\' ELSE \'queued\' END,'
            ' "nextRetryAt" = CASE WHEN "generation" <> %s '
            'OR ("operation" <> \'delete\' AND "attempts" >= 12) THEN NULL'
            ' ELSE now() + (%s * interval \'1 second\') END,'
            ' "lockedBy" = NULL, "leaseExpiresAt" = NULL, "lastError" = %s, "updatedAt" = now()'
            ' WHERE "id" = %s AND "lockedBy" = %s',
            (lease.generation, lease.generation, delay, message, lease.task_id, lease.worker_id),
        )
        await conn.commit()


async def run_one_personal_knowledge_index(
    pool: Any,
    *,
    worker_id: str,
    task_id: str | None = None,
) -> bool:
    lease = (
        await _claim(pool, worker_id)
        if task_id is None
        else await _claim(pool, worker_id, task_id=task_id)
    )
    if lease is None:
        return False
    try:
        client = AnythingLLMClient()
        if lease.operation == "delete":
            workspace = lease.workspace_slug or await client.get_workspace(
                lease.owner_id, create=False
            )
            paths = await client.list_personal_document_paths(lease.research_id)
            if lease.document_path and lease.document_path not in paths:
                paths.append(lease.document_path)
            for path in paths:
                await client.remove_document(workspace, path)
            await _finish(pool, lease, content_hash=None, deleted=True)
            return True

        current = await _load_current_document(pool, lease)
        if current is None:
            workspace = lease.workspace_slug or await client.get_workspace(
                lease.owner_id, create=False
            )
            paths = await client.list_personal_document_paths(lease.research_id)
            if lease.document_path and lease.document_path not in paths:
                paths.append(lease.document_path)
            for path in paths:
                await client.remove_document(workspace, path)
            await _finish(pool, lease, content_hash=None, deleted=True)
            return True

        title, body, citations = current
        text = _build_document_text(title, body, citations)
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        workspace = lease.workspace_slug or await client.get_workspace(lease.owner_id, create=True)
        if not workspace:
            raise RuntimeError("AnythingLLM personal workspace could not be resolved")
        if lease.document_path and lease.content_hash == digest:
            await _finish(pool, lease, content_hash=digest, deleted=False)
            return True

        paths = await client.list_personal_document_paths(lease.research_id)
        if lease.document_path and lease.document_path not in paths:
            paths.append(lease.document_path)
        for path in paths:
            await client.remove_document(workspace, path)
        path = await client.upload_text(lease.research_id, title, text)
        await _persist_document_path(pool, lease, workspace, path)
        await client.embed_document(workspace, path)
        await _finish(pool, lease, content_hash=digest, deleted=False)
        return True
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        await _fail(pool, lease, exc)
        logger.warning(
            "ai-engine.personal_knowledge_index.task_failed",
            extra={"research_id": lease.research_id, "error_type": type(exc).__name__},
        )
        return True


async def personal_knowledge_index_worker_loop(pool: Any) -> None:
    worker_id = f"knowledge-index-{os.getpid()}"
    try:
        poll_seconds = max(0.5, float(os.environ.get("KNOWLEDGE_INDEX_WORKER_POLL_SECONDS", "2")))
    except ValueError:
        poll_seconds = 2.0
    while True:
        try:
            worked = await run_one_personal_knowledge_index(pool, worker_id=worker_id)
            if not worked:
                await asyncio.sleep(poll_seconds)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "ai-engine.personal_knowledge_index.loop_failed",
                extra={"error_type": type(exc).__name__},
                exc_info=True,
            )
            await asyncio.sleep(poll_seconds)
