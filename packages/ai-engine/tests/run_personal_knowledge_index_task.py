"""Run one explicitly selected personal-index task against local test services."""

from __future__ import annotations

import argparse
import asyncio
import os
import uuid
from typing import cast
from urllib.parse import urlsplit

from ai_engine.job_runner.db_store import AI_TABLE, DbJobStore
from ai_engine.personal_knowledge_index import AnythingLLMClient, run_one_personal_knowledge_index


def _test_database_url() -> str:
    value = os.environ.get("TEST_DATABASE_URL", "").strip()
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise SystemExit("TEST_DATABASE_URL must point to the approved loopback test database") from exc
    if (
        parsed.scheme != "postgresql"
        or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
        or port != 55432
        or parsed.path.rstrip("/") != "/deep_research_test"
    ):
        raise SystemExit("task runner is restricted to 127.0.0.1:55432/deep_research_test")
    return value


def _test_anythingllm_config() -> tuple[str, str]:
    value = os.environ.get("TEST_ANYTHINGLLM_URL", "").strip()
    api_key = os.environ.get("TEST_ANYTHINGLLM_API_KEY", "").strip()
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise SystemExit("TEST_ANYTHINGLLM_URL must point to a loopback HTTP service") from exc
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
        or port is None
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise SystemExit("task runner only accepts a loopback HTTP AnythingLLM endpoint")
    if not api_key:
        raise SystemExit("TEST_ANYTHINGLLM_API_KEY is required")
    return value, api_key


async def _run(task_id: str, cleanup_owner_id: str | None) -> None:
    dsn = _test_database_url()
    anythingllm_url, api_key = _test_anythingllm_config()
    os.environ["ANYTHINGLLM_URL"] = anythingllm_url
    os.environ["ANYTHINGLLM_API_KEY"] = api_key
    os.environ["ANYTHINGLLM_PERSONAL_KNOWLEDGE_ENABLED"] = "1"

    store = DbJobStore(dsn=dsn, table_name=AI_TABLE)
    await store.open()
    try:
        async with store.pool.connection() as conn:
            row = await (
                await conn.execute(
                    'SELECT t."status", t."operation", t."ownerId", u."email" AS "ownerEmail" '
                    'FROM "personal_knowledge_index_tasks" t '
                    'JOIN "users" u ON u."id" = t."ownerId" WHERE t."id" = %s',
                    (task_id,),
                )
            ).fetchone()
        state = cast(dict[str, object] | None, row)
        if state is None:
            raise RuntimeError("the requested personal-index task does not exist")
        if not str(state["ownerEmail"]).lower().endswith("@e2e.local"):
            raise RuntimeError("the task runner only accepts synthetic E2E member records")
        if state["status"] != "completed":
            if not await run_one_personal_knowledge_index(
                store.pool,
                worker_id=f"live-browser-test-{uuid.uuid4().hex[:12]}",
                task_id=task_id,
            ):
                raise RuntimeError("the requested personal-index task was not claimed")
            async with store.pool.connection() as conn:
                row = await (
                    await conn.execute(
                        'SELECT t."status", t."operation", t."ownerId", u."email" AS "ownerEmail" '
                        'FROM "personal_knowledge_index_tasks" t '
                        'JOIN "users" u ON u."id" = t."ownerId" WHERE t."id" = %s',
                        (task_id,),
                    )
                ).fetchone()
            state = cast(dict[str, object] | None, row)
        if state is None or state["status"] != "completed":
            raise RuntimeError("the requested personal-index task did not complete")
        if not str(state["ownerEmail"]).lower().endswith("@e2e.local"):
            raise RuntimeError("the task runner only accepts synthetic E2E member records")

        if cleanup_owner_id is not None:
            if state["operation"] != "delete" or str(state["ownerId"]) != cleanup_owner_id:
                raise RuntimeError("workspace cleanup requires this owner's completed delete task")
            client = AnythingLLMClient(timeout_seconds=15)
            workspace = await client.get_workspace(cleanup_owner_id, create=False)
            if workspace:
                try:
                    await client._json_request("DELETE", f"/workspace/{workspace}")
                except Exception:
                    if await client.get_workspace(cleanup_owner_id, create=False) is not None:
                        raise RuntimeError("synthetic AnythingLLM workspace cleanup failed")
                if await client.get_workspace(cleanup_owner_id, create=False) is not None:
                    raise RuntimeError("synthetic AnythingLLM workspace remained after cleanup")
    finally:
        await store.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("task_id", type=uuid.UUID)
    parser.add_argument("--cleanup-owner-id", type=uuid.UUID)
    args = parser.parse_args()
    asyncio.run(_run(str(args.task_id), str(args.cleanup_owner_id) if args.cleanup_owner_id else None))
    print("personal knowledge index task completed")


if __name__ == "__main__":
    main()
