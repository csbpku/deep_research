from __future__ import annotations

import os
import uuid
from typing import cast

import pytest

from ai_engine.job_runner.db_store import AI_TABLE, DbJobStore
from ai_engine.personal_knowledge_index import (
    AnythingLLMClient,
    run_one_personal_knowledge_index,
    workspace_name,
)
import ai_engine.personal_knowledge_index as personal_index


pytestmark = pytest.mark.requires_db


def _test_dsn() -> str:
    return os.environ.get(
        "TEST_DATABASE_URL",
        "postgresql://postgres:postgres@localhost:5432/deep_research_test",
    )


class FakeAnythingLLMProtocol(AnythingLLMClient):
    def __init__(self) -> None:
        self.workspaces: dict[str, str] = {}
        self.documents: dict[str, dict[str, object]] = {}
        self.workspace_documents: dict[str, set[str]] = {}
        self.calls: list[tuple[str, str, dict[str, object] | None]] = []

    async def _json_request(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, object] | None = None,
    ) -> dict[str, object]:
        self.calls.append((method, path, payload))
        if method == "GET" and path == "/workspaces":
            return {
                "workspaces": [
                    {"name": name, "slug": slug}
                    for name, slug in self.workspaces.items()
                ],
            }
        if method == "GET" and path.startswith("/documents/folder/custom-documents?"):
            return {
                "folder": "custom-documents",
                "documents": [
                    {
                        "name": document_path.rsplit("/", 1)[-1],
                        "location": document_path,
                        "title": str(cast(dict[str, object], document["metadata"])["title"]),
                        "docSource": str(cast(dict[str, object], document["metadata"])["docSource"]),
                    }
                    for document_path, document in self.documents.items()
                ],
            }
        if method == "POST" and path == "/workspace/new":
            assert payload is not None
            name = str(payload["name"])
            slug = f"workspace-{name.removeprefix('dr-private-')}"
            self.workspaces[name] = slug
            self.workspace_documents.setdefault(slug, set())
            return {"workspace": {"slug": slug}}
        if method == "POST" and path == "/document/raw-text":
            assert payload is not None
            metadata = payload["metadata"]
            assert isinstance(metadata, dict)
            title = str(metadata["title"])
            research_id = title.removeprefix("dr-private-knowledge:")
            document_path = f"personal/{research_id}.txt"
            self.documents[document_path] = {
                "text": str(payload["textContent"]),
                "metadata": metadata,
            }
            return {"documents": [{"location": document_path}]}
        if method == "POST" and path.endswith("/update-embeddings"):
            workspace_slug = path.removeprefix("/workspace/").removesuffix("/update-embeddings")
            assert workspace_slug in self.workspace_documents
            assert payload is not None
            delete_paths = payload["deletes"]
            add_paths = payload["adds"]
            assert isinstance(delete_paths, list)
            assert isinstance(add_paths, list)
            for document_path in delete_paths:
                self.workspace_documents[workspace_slug].discard(str(document_path))
            for document_path in add_paths:
                assert str(document_path) in self.documents
                self.workspace_documents[workspace_slug].add(str(document_path))
            return {"success": True}
        if method == "DELETE" and path == "/system/remove-documents":
            assert payload is not None
            names = payload["names"]
            assert isinstance(names, list)
            for document_path in names:
                self.documents.pop(str(document_path), None)
            return {"success": True}
        if method == "POST" and path.endswith("/vector-search"):
            workspace_slug = path.removeprefix("/workspace/").removesuffix("/vector-search")
            assert workspace_slug in self.workspace_documents
            assert payload is not None
            query = str(payload["query"]).casefold()
            top_n = payload["topN"]
            assert isinstance(top_n, int)
            results = []
            for document_path in self.workspace_documents[workspace_slug]:
                document = self.documents[document_path]
                if query in str(document["text"]).casefold():
                    metadata = document["metadata"]
                    assert isinstance(metadata, dict)
                    results.append({"metadata": {"docSource": metadata["docSource"]}})
            return {"results": results[:top_n]}
        raise AssertionError(f"unexpected AnythingLLM request: {method} {path}")


async def test_personal_index_replaces_content_and_cleans_hard_deleted_draft(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = DbJobStore(dsn=_test_dsn(), table_name=AI_TABLE)
    await store.open()
    owner_id = str(uuid.uuid4())
    research_id = str(uuid.uuid4())
    monkeypatch.setenv("ANYTHINGLLM_URL", "http://anything.test")
    monkeypatch.setenv("ANYTHINGLLM_API_KEY", "synthetic-test-key")
    client = FakeAnythingLLMProtocol()
    monkeypatch.setattr(personal_index, "AnythingLLMClient", lambda: client)
    task_id: str | None = None

    try:
        async with store.pool.connection() as conn:
            await conn.execute(
                'INSERT INTO "users" ("id", "email", "name", "role", "createdAt", "updatedAt") '
                "VALUES (%s, %s, %s, 'member', now(), now())",
                (owner_id, f"knowledge-index-{owner_id}@test.local", "Index test"),
            )
            await conn.execute(
                'INSERT INTO "researches" '
                '("id", "type", "status", "title", "body", "authorId", "knowledgeIndexText", "createdAt", "updatedAt") '
                "VALUES (%s, 'knowledge', 'draft', %s, %s, %s, %s, now(), now())",
                (
                    research_id,
                    "Synthetic conclusion",
                    "Reader excerpt that must not be vectorized.",
                    owner_id,
                    "Confirmed note version one.",
                ),
            )
            await conn.execute(
                'INSERT INTO "personal_knowledge_index_tasks" '
                '("ownerId", "researchId", "operation", "status", "generation", "createdAt", "updatedAt") '
                "VALUES (%s, %s, 'upsert', 'queued', 1, now(), now())",
                (owner_id, research_id),
            )
            task_row = await (
                await conn.execute(
                    'SELECT "id" FROM "personal_knowledge_index_tasks" WHERE "researchId" = %s',
                    (research_id,),
                )
            ).fetchone()
            assert task_row is not None
            task_id = str(cast(dict[str, object], task_row)["id"])
            await conn.commit()

        assert await run_one_personal_knowledge_index(
            store.pool, worker_id="index-test", task_id=task_id
        )
        workspace_slug = workspace_name(owner_id).replace("dr-private-", "workspace-")
        document_path = f"personal/{research_id}.txt"
        assert workspace_slug in client.workspace_documents
        assert len(client.documents) == 1
        assert "Confirmed note version one." in str(client.documents[document_path]["text"])
        assert "Reader excerpt that must not be vectorized." not in str(client.documents[document_path]["text"])
        assert await client.vector_search(owner_id, "Confirmed note version one") == [research_id]
        assert client.workspace_documents[workspace_slug] == {document_path}

        async with store.pool.connection() as conn:
            await conn.execute(
                'UPDATE "researches" SET "knowledgeIndexText" = %s, "updatedAt" = now() WHERE "id" = %s',
                ("Confirmed note version two.", research_id),
            )
            await conn.execute(
                'UPDATE "personal_knowledge_index_tasks" SET "operation" = \'upsert\', "status" = \'queued\', '
                '"generation" = "generation" + 1, "attempts" = 0, "nextRetryAt" = NULL, "updatedAt" = now() '
                'WHERE "researchId" = %s',
                (research_id,),
            )
            await conn.commit()

        assert await run_one_personal_knowledge_index(
            store.pool, worker_id="index-test", task_id=task_id
        )
        assert len(client.documents) == 1
        assert "Confirmed note version two." in str(client.documents[document_path]["text"])
        assert "Confirmed note version one." not in str(client.documents[document_path]["text"])
        assert await client.vector_search(owner_id, "Confirmed note version one") == []
        assert await client.vector_search(owner_id, "Confirmed note version two") == [research_id]
        assert client.workspace_documents[workspace_slug] == {document_path}

        async with store.pool.connection() as conn:
            async with conn.transaction():
                await conn.execute(
                    'UPDATE "personal_knowledge_index_tasks" SET "operation" = \'delete\', "status" = \'queued\', '
                    '"generation" = "generation" + 1, "attempts" = 0, "nextRetryAt" = NULL, "updatedAt" = now() '
                    'WHERE "researchId" = %s',
                    (research_id,),
                )
                await conn.execute('DELETE FROM "researches" WHERE "id" = %s', (research_id,))

        assert await run_one_personal_knowledge_index(
            store.pool, worker_id="index-test", task_id=task_id
        )
        assert await client.vector_search(owner_id, "Confirmed note version two") == []
        assert client.workspace_documents[workspace_slug] == set()
        assert client.documents == {}
        assert any(
            method == "DELETE" and path == "/system/remove-documents"
            for method, path, _payload in client.calls
        )
        async with store.pool.connection() as conn:
            task_row = await (
                await conn.execute(
                    'SELECT "status", "operation", "documentPath" FROM "personal_knowledge_index_tasks" '
                    'WHERE "researchId" = %s',
                    (research_id,),
                )
            ).fetchone()
        assert task_row is not None
        task = cast(dict[str, object], task_row)
        assert task["status"] == "completed"
        assert task["operation"] == "delete"
        assert task["documentPath"] is None
    finally:
        async with store.pool.connection() as conn:
            await conn.execute('DELETE FROM "researches" WHERE "id" = %s', (research_id,))
            await conn.execute('DELETE FROM "users" WHERE "id" = %s', (owner_id,))
            await conn.commit()
        await store.close()
