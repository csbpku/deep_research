from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest

from ai_engine.personal_knowledge_index import (
    AnythingLLMClient,
    IndexLease,
    _build_document_text,
    _claim,
    _fail,
    _safe_citation_url,
    extract_personal_knowledge_ids,
    personal_knowledge_index_enabled,
    run_one_personal_knowledge_index,
    workspace_name,
)
import ai_engine.personal_knowledge_index as personal_index


USER_ID = "11111111-1111-4111-8111-111111111111"
RESEARCH_ID = "22222222-2222-4222-8222-222222222222"


def test_personal_knowledge_index_is_disabled_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANYTHINGLLM_PERSONAL_KNOWLEDGE_ENABLED", raising=False)
    monkeypatch.setenv("ANYTHINGLLM_URL", "http://anything.test")
    monkeypatch.setenv("ANYTHINGLLM_API_KEY", "test-key")

    assert personal_knowledge_index_enabled() is False


def test_personal_knowledge_index_requires_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANYTHINGLLM_PERSONAL_KNOWLEDGE_ENABLED", "1")
    monkeypatch.delenv("ANYTHINGLLM_URL", raising=False)
    monkeypatch.delenv("ANYTHINGLLM_API_KEY", raising=False)
    assert personal_knowledge_index_enabled() is False

    monkeypatch.setenv("ANYTHINGLLM_URL", "http://anything.test")
    monkeypatch.setenv("ANYTHINGLLM_API_KEY", "test-key")
    assert personal_knowledge_index_enabled() is True


def test_workspace_name_is_isolated_per_user() -> None:
    assert workspace_name(USER_ID) == "dr-private-11111111111141118111111111111111"
    assert workspace_name("33333333-3333-4333-8333-333333333333") != workspace_name(USER_ID)


def test_vector_results_return_only_deep_research_record_ids() -> None:
    assert extract_personal_knowledge_ids({
        "results": [
            {"metadata": {"title": f"dr-private-knowledge:{RESEARCH_ID}"}, "text": "private text"},
            {"title": f"dr-private-knowledge:{RESEARCH_ID}"},
            {"metadata": {"source": "https://example.com/not-a-record"}},
            {"metadata": {"docSource": f"dr-private-knowledge:{USER_ID}"}},
        ],
    }) == [RESEARCH_ID, USER_ID]


def test_vector_search_can_resolve_record_from_its_custom_source_url() -> None:
    assert extract_personal_knowledge_ids({
        "results": [{"metadata": {"url": f"deep-research://knowledge/{RESEARCH_ID}"}}],
    }) == [RESEARCH_ID]


def test_vector_search_resolves_id_from_anythingllm_normalized_raw_text_metadata() -> None:
    assert extract_personal_knowledge_ids({
        "results": [{
            "metadata": {
                "title": f"dr-private-knowledge-{RESEARCH_ID}.txt",
                "url": f"file://dr-private-knowledge-{RESEARCH_ID}.txt",
                "docSource": f"deep-research://knowledge/{RESEARCH_ID}",
            },
        }],
    }) == [RESEARCH_ID]


def test_normalized_document_title_resolves_record_id() -> None:
    assert extract_personal_knowledge_ids({
        "results": [{"metadata": {"title": f"dr-private-knowledge-{RESEARCH_ID}.txt"}}],
    }) == [RESEARCH_ID]


def test_citation_urls_drop_credentials_query_and_fragment() -> None:
    assert _safe_citation_url("https://user:secret@example.com/docs?token=private#section") == "https://example.com/docs"
    assert _safe_citation_url("http://[2001:db8::1]:8080/path?q=secret") == "http://[2001:db8::1]:8080/path"
    assert _safe_citation_url("file:///etc/passwd") is None
    assert _safe_citation_url("https://example.com:invalid/path") is None


def test_long_index_body_keeps_full_text_and_source_citations() -> None:
    text = _build_document_text(
        "Confirmed conclusion",
        "x" * 20_000,
        ["- Official docs (https://example.com/evidence)"],
    )

    assert len(text) > 12_000
    assert text.endswith("x" * 20_000 + "\n\n来源参考：\n- Official docs (https://example.com/evidence)")
    assert text.startswith("Confirmed conclusion\n\n")
    assert text.endswith("来源参考：\n- Official docs (https://example.com/evidence)")
    assert len(text.split("来源参考：", 1)[0]) > 1_000


async def test_get_workspace_creates_and_uses_returned_slug(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANYTHINGLLM_URL", "http://anything.test")
    monkeypatch.setenv("ANYTHINGLLM_API_KEY", "test-key")
    client = AnythingLLMClient()
    calls: list[tuple[str, str, dict[str, object] | None]] = []

    async def fake_request(
        method: str,
        path: str,
        *,
        payload: dict[str, object] | None = None,
    ) -> dict[str, Any]:
        calls.append((method, path, payload))
        if method == "GET":
            return {"workspaces": []}
        return {"workspace": {"slug": "dr-private-user-slug"}}

    monkeypatch.setattr(client, "_json_request", fake_request)
    slug = await client.get_workspace(USER_ID, create=True)

    assert slug == "dr-private-user-slug"
    assert calls == [
        ("GET", "/workspaces", None),
        ("POST", "/workspace/new", {"name": workspace_name(USER_ID)}),
    ]


async def test_document_upload_and_cleanup_use_record_metadata_and_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANYTHINGLLM_URL", "http://anything.test")
    monkeypatch.setenv("ANYTHINGLLM_API_KEY", "test-key")
    client = AnythingLLMClient()
    calls: list[tuple[str, str, dict[str, object] | None]] = []

    async def fake_request(
        method: str,
        path: str,
        *,
        payload: dict[str, object] | None = None,
    ) -> dict[str, Any]:
        calls.append((method, path, payload))
        if path == "/document/raw-text":
            return {"documents": [{"location": "custom/deep-research.txt"}]}
        return {"success": True}

    monkeypatch.setattr(client, "_json_request", fake_request)
    path = await client.upload_text(RESEARCH_ID, "Useful judgement", "short confirmed note")
    await client.embed_document("personal-workspace", path)
    await client.remove_document("personal-workspace", path)

    assert path == "custom/deep-research.txt"
    assert calls[0][1] == "/document/raw-text"
    assert calls[0][2] == {
        "textContent": "short confirmed note",
        "metadata": {
            "title": f"dr-private-knowledge:{RESEARCH_ID}",
            "description": "Useful judgement",
            "docAuthor": "Deep Research",
            "docSource": f"deep-research://knowledge/{RESEARCH_ID}",
        },
    }
    assert calls[1] == (
        "POST",
        "/workspace/personal-workspace/update-embeddings",
        {"adds": [path], "deletes": []},
    )
    assert calls[2] == (
        "POST",
        "/workspace/personal-workspace/update-embeddings",
        {"adds": [], "deletes": [path]},
    )
    assert calls[3] == ("DELETE", "/system/remove-documents", {"names": [path]})


async def test_vector_search_uses_anythingllm_query_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANYTHINGLLM_URL", "http://anything.test")
    monkeypatch.setenv("ANYTHINGLLM_API_KEY", "test-key")
    client = AnythingLLMClient()
    calls: list[tuple[str, str, dict[str, object] | None]] = []

    async def fake_request(
        method: str,
        path: str,
        *,
        payload: dict[str, object] | None = None,
    ) -> dict[str, Any]:
        calls.append((method, path, payload))
        if method == "GET":
            return {"workspaces": [{"name": workspace_name(USER_ID), "slug": "private-user-workspace"}]}
        return {"results": [{"metadata": {"url": f"deep-research://knowledge/{RESEARCH_ID}"}}]}

    monkeypatch.setattr(client, "_json_request", fake_request)

    assert await client.vector_search(USER_ID, "secure vector retrieval", limit=3) == [RESEARCH_ID]
    assert calls == [
        ("GET", "/workspaces", None),
        (
            "POST",
            "/workspace/private-user-workspace/vector-search",
            {"query": "secure vector retrieval", "topN": 3},
        ),
    ]


async def test_document_listing_finds_only_the_matching_private_record(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANYTHINGLLM_URL", "http://anything.test")
    monkeypatch.setenv("ANYTHINGLLM_API_KEY", "test-key")
    client = AnythingLLMClient()
    calls: list[str] = []

    async def fake_request(
        method: str,
        path: str,
        *,
        payload: dict[str, object] | None = None,
    ) -> dict[str, Any]:
        assert method == "GET"
        assert payload is None
        calls.append(path)
        return {
            "folder": "custom-documents",
            "documents": [
                {
                    "name": "orphan.json",
                    "title": f"dr-private-knowledge-{RESEARCH_ID}.txt",
                },
                {
                    "name": "other-user.json",
                    "title": "dr-private-knowledge-33333333-3333-4333-8333-333333333333.txt",
                },
                {"name": "regular.json", "title": "ordinary document.txt"},
            ],
        }

    monkeypatch.setattr(client, "_json_request", fake_request)

    assert await client.list_personal_document_paths(RESEARCH_ID) == [
        "custom-documents/orphan.json",
    ]
    assert calls == ["/documents/folder/custom-documents?offset=0&limit=500"]


class _Cursor:
    def __init__(self, row: dict[str, Any]) -> None:
        self.row = row

    async def fetchone(self) -> dict[str, Any]:
        return self.row


class _Connection:
    def __init__(self) -> None:
        self.sql = ""
        self.params: tuple[Any, ...] = ()

    @asynccontextmanager
    async def transaction(self):  # type: ignore[no-untyped-def]
        yield

    async def execute(self, sql: str, params: tuple[Any, ...] = ()) -> _Cursor:
        self.sql = sql
        self.params = params
        return _Cursor({
            "id": "task-1",
            "ownerId": USER_ID,
            "researchId": RESEARCH_ID,
            "operation": "upsert",
            "generation": 2,
            "attempts": 3,
            "workspaceSlug": None,
            "documentPath": None,
            "contentHash": None,
        })

    async def commit(self) -> None:
        return None


class _Pool:
    def __init__(self) -> None:
        self.connection_value = _Connection()

    @asynccontextmanager
    async def connection(self):  # type: ignore[no-untyped-def]
        yield self.connection_value


async def test_claim_reclaims_expired_processing_lease() -> None:
    pool = _Pool()

    lease = await _claim(pool, "worker-2")

    assert lease is not None
    assert lease.research_id == RESEARCH_ID
    assert lease.generation == 2
    assert '"status" = \'processing\' AND "leaseExpiresAt" < now()' in pool.connection_value.sql
    assert "FOR UPDATE SKIP LOCKED" in pool.connection_value.sql
    assert pool.connection_value.params == ("worker-2", 300)


async def test_delete_cleanup_retries_beyond_upsert_retry_limit() -> None:
    pool = _Pool()
    lease = IndexLease(
        task_id="task-3",
        owner_id=USER_ID,
        research_id=RESEARCH_ID,
        operation="delete",
        generation=5,
        attempts=12,
        workspace_slug="private-user-workspace",
        document_path="documents/research-note.txt",
        content_hash=None,
        worker_id="worker-1",
    )

    await _fail(pool, lease, RuntimeError("synthetic failure"))

    sql = pool.connection_value.sql
    status_case = sql.split('"status" = CASE ', 1)[1].split(', "nextRetryAt"', 1)[0]
    assert status_case == (
        "WHEN \"generation\" <> %s THEN 'queued' "
        "WHEN \"operation\" = 'delete' THEN 'queued' "
        "WHEN \"attempts\" >= 12 THEN 'failed' ELSE 'queued' END"
    )
    assert '("operation" <> \'delete\' AND "attempts" >= 12) THEN NULL' in sql
    assert pool.connection_value.params[:3] == (5, 5, 3_600)


async def test_upsert_failure_is_requeued_with_exponential_backoff() -> None:
    pool = _Pool()
    lease = IndexLease(
        task_id="task-retry",
        owner_id=USER_ID,
        research_id=RESEARCH_ID,
        operation="upsert",
        generation=7,
        attempts=4,
        workspace_slug="private-user-workspace",
        document_path="documents/research-note.txt",
        content_hash=None,
        worker_id="worker-1",
    )

    await _fail(pool, lease, RuntimeError("synthetic provider failure"))

    sql = pool.connection_value.sql
    assert "WHEN \"attempts\" >= 12 THEN 'failed' ELSE 'queued' END" in sql
    assert pool.connection_value.params[:3] == (7, 7, 120)
    assert pool.connection_value.params[3] == "RuntimeError: synthetic provider failure"


async def test_upsert_embeds_only_confirmed_text_with_source_citations(monkeypatch: pytest.MonkeyPatch) -> None:
    lease = IndexLease(
        task_id="task-1",
        owner_id=USER_ID,
        research_id=RESEARCH_ID,
        operation="upsert",
        generation=3,
        attempts=1,
        workspace_slug=None,
        document_path=None,
        content_hash=None,
        worker_id="worker-1",
    )
    events: list[tuple[str, Any]] = []

    class FakeClient:
        def __init__(self) -> None:
            pass

        async def get_workspace(self, user_id: str, *, create: bool) -> str:
            events.append(("workspace", (user_id, create)))
            return "private-user-workspace"

        async def remove_document(self, workspace_slug: str | None, document_path: str | None) -> None:
            if document_path:
                events.append(("remove", (workspace_slug, document_path)))

        async def list_personal_document_paths(self, research_id: str) -> list[str]:
            events.append(("list", research_id))
            return []

        async def upload_text(self, research_id: str, title: str, text: str) -> str:
            events.append(("upload", (research_id, title, text)))
            return "documents/research-note.txt"

        async def embed_document(self, workspace_slug: str, document_path: str) -> None:
            events.append(("embed", (workspace_slug, document_path)))

    monkeypatch.setattr(personal_index, "AnythingLLMClient", FakeClient)
    monkeypatch.setattr(personal_index, "_claim", lambda *_args: _resolved(lease))
    monkeypatch.setattr(
        personal_index,
        "_load_current_document",
        lambda *_args: _resolved(("RAG decision", "Only index my confirmed judgement.", ["- Official docs (https://example.com/docs)"])),
    )
    monkeypatch.setattr(personal_index, "_persist_document_path", lambda *_args: _resolved(None))
    monkeypatch.setattr(personal_index, "_finish", lambda *_args, **_kwargs: _resolved(None))

    assert await run_one_personal_knowledge_index(object(), worker_id="worker-1") is True
    assert events == [
        ("workspace", (USER_ID, True)),
        ("list", RESEARCH_ID),
        ("upload", (
            RESEARCH_ID,
            "RAG decision",
            "RAG decision\n\nOnly index my confirmed judgement.\n\n来源参考：\n- Official docs (https://example.com/docs)",
        )),
        ("embed", ("private-user-workspace", "documents/research-note.txt")),
    ]


async def test_delete_task_removes_only_its_recorded_document(monkeypatch: pytest.MonkeyPatch) -> None:
    lease = IndexLease(
        task_id="task-2",
        owner_id=USER_ID,
        research_id=RESEARCH_ID,
        operation="delete",
        generation=4,
        attempts=1,
        workspace_slug="private-user-workspace",
        document_path="documents/research-note.txt",
        content_hash="a" * 64,
        worker_id="worker-1",
    )
    removed: list[tuple[str | None, str | None]] = []
    finished: list[dict[str, Any]] = []

    class FakeClient:
        def __init__(self) -> None:
            pass

        async def remove_document(self, workspace_slug: str | None, document_path: str | None) -> None:
            removed.append((workspace_slug, document_path))

        async def list_personal_document_paths(self, research_id: str) -> list[str]:
            assert research_id == RESEARCH_ID
            return ["custom-documents/orphan.json"]

    async def finish(*_args: Any, **kwargs: Any) -> None:
        finished.append(kwargs)

    monkeypatch.setattr(personal_index, "AnythingLLMClient", FakeClient)
    monkeypatch.setattr(personal_index, "_claim", lambda *_args: _resolved(lease))
    monkeypatch.setattr(personal_index, "_finish", finish)

    assert await run_one_personal_knowledge_index(object(), worker_id="worker-1") is True
    assert removed == [
        ("private-user-workspace", "custom-documents/orphan.json"),
        ("private-user-workspace", "documents/research-note.txt"),
    ]
    assert finished == [{"content_hash": None, "deleted": True}]


async def _resolved(value: Any) -> Any:
    return value
