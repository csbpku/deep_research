from __future__ import annotations

import asyncio
import os
import uuid
from typing import Any, cast
from urllib.parse import urlsplit

import pytest
import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from ai_engine.job_runner.db_store import AI_TABLE, DbJobStore
from ai_engine.personal_knowledge_index import (
    AnythingLLMClient,
    run_one_personal_knowledge_index,
    workspace_name,
)

def _test_dsn() -> str:
    dsn = os.environ.get("TEST_DATABASE_URL", "")
    parsed = urlsplit(dsn)
    if parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        pytest.fail("live index test requires an explicitly configured loopback TEST_DATABASE_URL")
    if parsed.path.rstrip("/").split("/")[-1] != "deep_research_test":
        pytest.fail("live index test is restricted to the deep_research_test database")
    return dsn


def _test_anythingllm_config() -> tuple[str, str]:
    value = os.environ.get("TEST_ANYTHINGLLM_URL", "").strip()
    api_key = os.environ.get("TEST_ANYTHINGLLM_API_KEY", "").strip()
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        pytest.fail("live index test may only call an HTTP AnythingLLM service on loopback")
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        pytest.fail("live index test may only call an HTTP AnythingLLM service on loopback")
    if port is None or not 1 <= port <= 65_535:
        pytest.fail("live index test requires a concrete AnythingLLM test port")
    if not api_key:
        pytest.fail("live index test requires TEST_ANYTHINGLLM_API_KEY")
    return value, api_key


def test_live_anythingllm_requires_separate_test_endpoint_and_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANYTHINGLLM_URL", "http://127.0.0.1:3002")
    monkeypatch.setenv("ANYTHINGLLM_API_KEY", "application-key-not-for-this-test")
    monkeypatch.delenv("TEST_ANYTHINGLLM_URL", raising=False)
    monkeypatch.delenv("TEST_ANYTHINGLLM_API_KEY", raising=False)

    with pytest.raises(pytest.fail.Exception, match="loopback"):
        _test_anythingllm_config()


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1:3002",
        "http://example.test:3002",
        "http://127.0.0.1:3002/api/v1",
        "http://user@127.0.0.1:3002",
        "http://127.0.0.1",
    ],
)
def test_live_anythingllm_rejects_ambiguous_endpoint(url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TEST_ANYTHINGLLM_URL", url)
    monkeypatch.setenv("TEST_ANYTHINGLLM_API_KEY", "synthetic-test-key")

    with pytest.raises(pytest.fail.Exception):
        _test_anythingllm_config()


async def _task_state(store: DbJobStore, task_id: str) -> dict[str, Any] | None:
    async with store.pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT "status", "operation", "workspaceSlug", "documentPath", "lastError" '
                'FROM "personal_knowledge_index_tasks" WHERE "id" = %s',
                (task_id,),
            )
        ).fetchone()
    return cast(dict[str, Any], row) if row is not None else None


async def _run_task(store: DbJobStore, task_id: str, client_id: str) -> dict[str, Any]:
    assert await run_one_personal_knowledge_index(
        store.pool,
        worker_id=client_id,
        task_id=task_id,
    )
    state = await _task_state(store, task_id)
    assert state is not None
    assert state["status"] == "completed", state.get("lastError")
    return state


async def _expect_vector_hit(
    client: AnythingLLMClient,
    owner_id: str,
    query: str,
    research_id: str,
    *,
    present: bool,
) -> None:
    for _ in range(20):
        ids = await client.vector_search(owner_id, query, limit=4)
        if (research_id in ids) is present:
            return
        await asyncio.sleep(1)
    pytest.fail(f"live AnythingLLM vector result presence did not become {present}")


@pytest.mark.requires_db
@pytest.mark.skipif(
    os.environ.get("RUN_ANYTHINGLLM_PERSONAL_INDEX_LIVE_TEST") != "1",
    reason="explicit opt-in required for the live AnythingLLM integration test",
)
async def test_worker_indexes_replaces_and_deletes_in_live_anythingllm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    test_url, test_api_key = _test_anythingllm_config()
    # Do not inherit the application's AnythingLLM endpoint or key: localhost
    # may be an SSH tunnel to a remote service, not an isolated local instance.
    monkeypatch.setenv("ANYTHINGLLM_URL", test_url)
    monkeypatch.setenv("ANYTHINGLLM_API_KEY", test_api_key)
    monkeypatch.setenv("ANYTHINGLLM_PERSONAL_KNOWLEDGE_ENABLED", "1")
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "live-index-internal-test-token")
    monkeypatch.delenv("RADAR_DISABLE_INTERNAL_TOKEN", raising=False)
    client = AnythingLLMClient(timeout_seconds=15)
    owner_id = str(uuid.uuid4())
    # Verify credentials before creating any database fixtures. A bad local
    # API key should fail as a read-only preflight, not leave a tombstone.
    await client.get_workspace(owner_id, create=False)

    store = DbJobStore(dsn=_test_dsn(), table_name=AI_TABLE)
    await store.open()

    research_id = str(uuid.uuid4())
    task_id: str | None = None
    worker_id = f"live-index-test-{uuid.uuid4().hex[:12]}"
    workspace_slug: str | None = None
    document_path: str | None = None
    first_text = "Engineers should check the idempotency key before retrying database writes with bounded backoff."
    first_query = "idempotency key bounded backoff database writes"
    second_text = "Compare model latency p95 before increasing batch size for production inference."
    second_query = "model latency p95 increasing batch size production inference"

    try:
        async with store.pool.connection() as conn:
            await conn.execute(
                'INSERT INTO "users" ("id", "email", "name", "role", "createdAt", "updatedAt") '
                "VALUES (%s, %s, 'Live index synthetic user', 'member', now(), now())",
                (owner_id, f"live-index-{owner_id}@test.local"),
            )
            await conn.execute(
                'INSERT INTO "researches" '
                '("id", "type", "status", "title", "body", "authorId", "knowledgeIndexText", "createdAt", "updatedAt") '
                "VALUES (%s, 'knowledge', 'draft', %s, %s, %s, %s, now(), now())",
                (
                    research_id,
                    f"Synthetic personal judgement {uuid.uuid4().hex[:8]}",
                    "Reader quote must not be indexed by this worker.",
                    owner_id,
                    first_text,
                ),
            )
            await conn.execute(
                'INSERT INTO "personal_knowledge_index_tasks" '
                '("ownerId", "researchId", "operation", "status", "generation", "createdAt", "updatedAt") '
                "VALUES (%s, %s, 'upsert', 'queued', 1, now(), now())",
                (owner_id, research_id),
            )
            row = await (
                await conn.execute(
                    'SELECT "id" FROM "personal_knowledge_index_tasks" WHERE "researchId" = %s',
                    (research_id,),
                )
            ).fetchone()
            assert row is not None
            task_id = str(cast(dict[str, object], row)["id"])
            await conn.commit()

        state = await _run_task(store, task_id, worker_id)
        workspace_slug = str(state["workspaceSlug"])
        document_path = str(state["documentPath"])
        assert workspace_slug == workspace_name(owner_id)
        assert document_path
        assert await client.list_personal_document_paths(research_id) == [document_path]
        await _expect_vector_hit(client, owner_id, first_query, research_id, present=True)

        from ai_engine.server.personal_knowledge import router

        api_app = FastAPI()
        api_app.include_router(router)
        with TestClient(api_app) as api:
            response = api.post(
                "/api/knowledge-index/search",
                headers={"x-internal-token": "live-index-internal-test-token"},
                json={"userId": owner_id, "query": first_query, "limit": 4},
            )
            assert response.status_code == 200, response.text
            assert response.json() == {"ids": [research_id], "enabled": True}
            assert "text" not in response.json()

            other_user = str(uuid.uuid4())
            other_response = api.post(
                "/api/knowledge-index/search",
                headers={"x-internal-token": "live-index-internal-test-token"},
                json={"userId": other_user, "query": first_query, "limit": 4},
            )
            assert other_response.status_code == 200, other_response.text
            assert other_response.json() == {"ids": [], "enabled": True}

        # Simulate a worker crash after AnythingLLM accepted the document but
        # before its random remote path was committed to the outbox row.
        async with store.pool.connection() as conn:
            await conn.execute(
                'UPDATE "personal_knowledge_index_tasks" SET "status" = \'queued\', '
                '"generation" = "generation" + 1, "workspaceSlug" = NULL, "documentPath" = NULL, '
                '"contentHash" = NULL, "attempts" = 0, "nextRetryAt" = NULL, '
                '"lastError" = NULL, "updatedAt" = now() WHERE "id" = %s',
                (task_id,),
            )
            await conn.commit()

        state = await _run_task(store, task_id, worker_id)
        workspace_slug = str(state["workspaceSlug"])
        document_path = str(state["documentPath"])
        assert await client.list_personal_document_paths(research_id) == [document_path]
        await _expect_vector_hit(client, owner_id, first_query, research_id, present=True)

        async with store.pool.connection() as conn:
            await conn.execute(
                'UPDATE "researches" SET "knowledgeIndexText" = %s, "updatedAt" = now() WHERE "id" = %s',
                (second_text, research_id),
            )
            await conn.execute(
                'UPDATE "personal_knowledge_index_tasks" SET "operation" = \'upsert\', "status" = \'queued\', '
                '"generation" = "generation" + 1, "attempts" = 0, "nextRetryAt" = NULL, '
                '"lastError" = NULL, "updatedAt" = now() WHERE "id" = %s',
                (task_id,),
            )
            await conn.commit()

        state = await _run_task(store, task_id, worker_id)
        workspace_slug = str(state["workspaceSlug"])
        document_path = str(state["documentPath"])
        assert await client.list_personal_document_paths(research_id) == [document_path]
        await _expect_vector_hit(client, owner_id, first_query, research_id, present=False)
        await _expect_vector_hit(client, owner_id, second_query, research_id, present=True)

        async with store.pool.connection() as conn:
            async with conn.transaction():
                await conn.execute(
                    'UPDATE "personal_knowledge_index_tasks" SET "operation" = \'delete\', "status" = \'queued\', '
                    '"generation" = "generation" + 1, "documentPath" = NULL, "attempts" = 0, "nextRetryAt" = NULL, '
                    '"lastError" = NULL, "updatedAt" = now() WHERE "id" = %s',
                    (task_id,),
                )
                await conn.execute('DELETE FROM "researches" WHERE "id" = %s', (research_id,))

        state = await _run_task(store, task_id, worker_id)
        assert state["documentPath"] is None
        assert await client.list_personal_document_paths(research_id) == []
        await _expect_vector_hit(client, owner_id, second_query, research_id, present=False)
    finally:
        cleanup_error: Exception | None = None
        if task_id is not None:
            try:
                cleanup_state = await _task_state(store, task_id)
                completed_delete = bool(
                    cleanup_state
                    and cleanup_state["status"] == "completed"
                    and cleanup_state["operation"] == "delete"
                )
                if not completed_delete:
                    # Keep the normal outbox tombstone as the cleanup record.
                    # Never delete it directly, even after a test failure.
                    async with store.pool.connection() as conn:
                        async with conn.transaction():
                            await conn.execute(
                                'UPDATE "personal_knowledge_index_tasks" SET "operation" = \'delete\', "status" = \'queued\', '
                                '"generation" = "generation" + 1, "attempts" = 0, "nextRetryAt" = NULL, '
                                '"lastError" = NULL, "updatedAt" = now() WHERE "id" = %s',
                                (task_id,),
                            )
                            await conn.execute('DELETE FROM "researches" WHERE "id" = %s', (research_id,))
                    await run_one_personal_knowledge_index(
                        store.pool,
                        worker_id=worker_id,
                        task_id=task_id,
                    )
                    cleanup_state = await _task_state(store, task_id)
                if cleanup_state is not None:
                    workspace_slug = str(cleanup_state["workspaceSlug"]) if cleanup_state["workspaceSlug"] else workspace_slug
                    document_path = (
                        str(cleanup_state["documentPath"])
                        if cleanup_state["documentPath"]
                        else None if cleanup_state["status"] == "completed" and cleanup_state["operation"] == "delete"
                        else document_path
                    )
                if workspace_slug is None:
                    workspace_slug = await client.get_workspace(owner_id, create=False)
                if workspace_slug:
                    if document_path:
                        await client.remove_document(workspace_slug, document_path)
                    deletion_error: Exception | None = None
                    try:
                        await client._json_request("DELETE", f"/workspace/{workspace_slug}")
                    except (httpx.HTTPStatusError, ValueError) as exc:
                        deletion_error = exc
                    # AnythingLLM 1.16 may delete the workspace before returning a bad response.
                    if await client.get_workspace(owner_id, create=False) is not None:
                        if deletion_error is not None:
                            raise deletion_error
                        raise AssertionError("synthetic workspace remained after deletion")
                if cleanup_state is not None:
                    async with store.pool.connection() as conn:
                        await conn.execute(
                            'UPDATE "personal_knowledge_index_tasks" SET "status" = \'completed\', '
                            '"workspaceSlug" = NULL, "documentPath" = NULL, "contentHash" = NULL, '
                            '"nextRetryAt" = NULL, "lockedBy" = NULL, "leaseExpiresAt" = NULL, '
                            '"lastError" = NULL, "updatedAt" = now() WHERE "id" = %s',
                            (task_id,),
                        )
                        await conn.commit()
            except Exception as exc:
                cleanup_error = exc
        try:
            async with store.pool.connection() as conn:
                await conn.execute('DELETE FROM "researches" WHERE "id" = %s', (research_id,))
                await conn.execute('DELETE FROM "users" WHERE "id" = %s', (owner_id,))
                await conn.commit()
        except Exception as exc:
            cleanup_error = cleanup_error or exc
        try:
            await store.close()
        finally:
            if cleanup_error is not None:
                pytest.fail(f"live AnythingLLM cleanup failed: {type(cleanup_error).__name__}")
