"""P1-D 主题聚合 + 综述 worker 守门单测。"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest

from ai_engine.radar.topic_aggregation_worker import _topic_slug
from ai_engine.radar.topic_clustering import (
    build_candidate_clusters,
    is_metadata_tag,
    title_concepts,
)
from ai_engine.radar.topic_proposal_worker import _clean_json, _prompt, _source_key
from ai_engine.radar.topic_synthesis_worker import _generate_for_topic, _parse_payload
from ai_engine.radar.topic_refresh_worker import (
    _matches_topic,
    _source_key as _refresh_source_key,
    _tier,
    _topic_anchor_tags,
)


# ── metadata tag 过滤 ─────────────────────────────────────────────


@pytest.mark.parametrize(
    "tag",
    [
        "profile_engineering", "profile_paper", "profile_news",
        "tier_deep_read", "tier_skim", "tier_collection",
        "github", "arxiv", "huggingface", "devto", "hackernews",
        "trending", "must_read", "topic_search",
        "lobsters", "producthunt", "rss", "news",
        "ai", "AI", "llm", "large-language-model", "machinelearning",
        "programming", "opensource", "python", "typescript", "javascript",
        "rust", "golang", "nodejs",
    ],
)
def test_is_metadata_tag_filters_sync_metadata(tag: str) -> None:
    assert is_metadata_tag(tag) is True


@pytest.mark.parametrize(
    "tag",
    [
        "rag", "huggingface-trending", "ai-agent", "mcp",
        "agent-evaluation", "vector-database",
        "深度学习", "扩散模型",
    ],
)
def test_is_metadata_tag_keeps_real_topic_tags(tag: str) -> None:
    assert is_metadata_tag(tag) is False


def test_title_concepts_extracts_concrete_terms() -> None:
    concepts = title_concepts("MCP server goes stateless with vector database")
    assert {"mcp", "vector", "database", "vector database"} <= concepts
    assert "goes" not in concepts


def test_title_concepts_removes_generic_stopwords() -> None:
    assert title_concepts("The AI LLM guide for developers") == set()


def test_build_candidate_clusters_groups_shared_concepts() -> None:
    rows = [
        {"id": "1", "title": "MCP server compliance", "sourceKey": "a.dev", "tags": ["mcp"]},
        {"id": "2", "title": "MCP stateless update", "sourceKey": "b.dev", "tags": ["mcp"]},
        {"id": "3", "title": "MCP validation tool", "sourceKey": "c.dev", "tags": ["mcp"]},
        {"id": "4", "title": "RAG retrieval benchmark", "sourceKey": "d.dev", "tags": ["rag"]},
        {"id": "5", "title": "RAG memory store", "sourceKey": "e.dev", "tags": ["rag"]},
        {"id": "6", "title": "RAG evaluation setup", "sourceKey": "f.dev", "tags": ["rag"]},
    ]
    clusters = build_candidate_clusters(rows)
    assert {cluster["concept"] for cluster in clusters} == {"mcp", "rag"}
    assert all(len(cluster["summary_ids"]) >= 3 for cluster in clusters)
    assert all(len(set(cluster["source_keys"])) >= 2 for cluster in clusters)


def test_build_candidate_clusters_skips_single_source_groups() -> None:
    rows = [
        {"id": str(i), "title": f"MCP note {i}", "sourceKey": "a.dev", "tags": ["mcp"]}
        for i in range(4)
    ]
    assert build_candidate_clusters(rows) == []


def test_build_candidate_clusters_prefers_specific_tag() -> None:
    rows = [
        {"id": str(i), "title": f"ops note {i}", "sourceKey": f"d{i}.dev", "tags": ["devops"]}
        for i in range(5)
    ]
    rows.extend(
        {
            "id": f"m{i}",
            "title": f"MCP server {i}",
            "sourceKey": f"s{i}.dev",
            "tags": ["mcp"],
        }
        for i in range(3)
    )
    clusters = build_candidate_clusters(rows, max_clusters=1)
    assert clusters[0]["concept"] == "mcp"


def test_topic_slug_canonicalizes_case_and_separators() -> None:
    assert _topic_slug(" Agent Evaluation ") == "agent-evaluation"
    assert _topic_slug("MCP / Security") == "mcp-security"


def test_existing_topic_refresh_uses_non_metadata_anchor_tags() -> None:
    anchors = _topic_anchor_tags(
        [{"tags": ["mcp", "tier_deep_read", "github"]}],
        "MCP security",
    )
    assert anchors == {"mcp"}
    assert _matches_topic({"tags": ["mcp", "tier_skim"]}, anchors)
    assert not _matches_topic({"tags": ["rag"]}, anchors)


def test_existing_topic_refresh_falls_back_to_topic_name() -> None:
    anchors = _topic_anchor_tags([], "MCP Security")
    assert anchors == {"mcp", "security"}
    assert _matches_topic({"tags": ["mcp"]}, anchors)


@pytest.mark.parametrize(
    ("count", "expected"),
    [(0, "emerging"), (3, "warming"), (5, "warming"), (6, "hot")],
)
def test_existing_topic_refresh_tier(count: int, expected: str) -> None:
    assert _tier(count) == expected


def test_existing_topic_refresh_source_key_uses_publisher() -> None:
    assert _refresh_source_key("https://github.com/acme/tool", "github_repo") == "github:acme"
    assert _refresh_source_key("https://example.com/article", "rss") == "example.com"


def test_topic_proposal_source_key_uses_publisher_not_content_kind() -> None:
    assert _source_key("https://github.com/acme/tool", "github_repo") == "github:acme"
    assert _source_key("https://example.com/a", "rss") == "example.com"


def test_topic_proposal_payload_accepts_json_fence() -> None:
    assert _clean_json('```json\n{"proposals": []}\n```') == {"proposals": []}


def test_topic_proposal_prompt_prefers_followable_scope() -> None:
    rows = [
        {"id": "1", "title": "MCP server", "sourceKey": "a.dev", "tags": ["mcp"]},
    ]
    prompt = _prompt(rows, cluster_hint="mcp")
    assert "可持续跟踪的研究脉络" in prompt
    assert "不要用某个项目名" in prompt
    assert "通常只生成 1 个主题提议" in prompt
    assert "最多生成 2 个" in prompt


# ── topic_synthesis payload 解析 ─────────────────────────────────


def test_parse_payload_strips_code_fence() -> None:
    raw = '```json\n{"tldr": "x", "sections": [], "references": []}\n```'
    out = _parse_payload(raw)
    assert out["tldr"] == "x"
    assert out["sections"] == []


def test_parse_payload_handles_plain_json() -> None:
    raw = '{"tldr": "直接 JSON", "sections": [{"title": "S1", "content": "..."}], "references": []}'
    out = _parse_payload(raw)
    assert out["tldr"] == "直接 JSON"
    assert len(out["sections"]) == 1


def test_parse_payload_raises_on_invalid() -> None:
    with pytest.raises(Exception):
        _parse_payload("not json at all { broken")


@pytest.mark.asyncio
async def test_topic_synthesis_failure_keeps_previous_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    class Cursor:
        def __init__(self, rows: list[dict[str, Any]]) -> None:
            self.rows = rows

        async def fetchone(self) -> dict[str, Any] | None:
            return self.rows[0] if self.rows else None

        async def fetchall(self) -> list[dict[str, Any]]:
            return self.rows

    class Connection:
        def __init__(self) -> None:
            self.sql: list[str] = []

        async def execute(self, sql: str, _params: tuple[Any, ...] = ()) -> Cursor:
            self.sql.append(sql)
            if 'FROM "topics"' in sql:
                return Cursor([{"id": "topic-1", "name": "MCP", "synthesisErrorCode": None}])
            if 'FROM "topic_candidates"' in sql:
                return Cursor([{"id": "summary-1", "title": "MCP update", "interpretation": "signal", "tags": ["mcp"]}])
            return Cursor([])

    class Pool:
        def __init__(self) -> None:
            self.conn = Connection()

        @asynccontextmanager
        async def connection(self):  # type: ignore[no-untyped-def]
            yield self.conn

    async def fail_generate(**_: Any) -> Any:
        raise RuntimeError("provider unavailable")

    pool = Pool()
    monkeypatch.setattr("ai_engine.radar.topic_synthesis_worker.generate_text", fail_generate)
    assert await _generate_for_topic(pool, "topic-1") is False
    failure_updates = [sql for sql in pool.conn.sql if 'UPDATE "topics"' in sql]
    assert failure_updates
    assert '"synthesisErrorCode"' in failure_updates[-1]
    assert '"synthesisPayload"' not in failure_updates[-1]


@pytest.mark.asyncio
async def test_topic_synthesis_failure_preserves_last_success_timestamp(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """失败路径不得覆盖 lastSynthesisSuccessAt；该列只在成功分支更新。"""

    class Cursor:
        async def fetchone(self) -> dict[str, Any] | None:
            return {"id": "topic-1", "name": "MCP", "synthesisErrorCode": None}

        async def fetchall(self) -> list[dict[str, Any]]:
            return []

    class Connection:
        def __init__(self) -> None:
            self.sql: list[str] = []

        async def execute(self, sql: str, _params: tuple[Any, ...] = ()) -> Cursor:
            self.sql.append(sql)
            return Cursor()

    class Pool:
        def __init__(self) -> None:
            self.conn = Connection()

        @asynccontextmanager
        async def connection(self):  # type: ignore[no-untyped-def]
            yield self.conn

    async def fail_generate(**_: Any) -> Any:
        raise RuntimeError("provider unavailable")

    pool = Pool()
    monkeypatch.setattr("ai_engine.radar.topic_synthesis_worker.generate_text", fail_generate)
    assert await _generate_for_topic(pool, "topic-1") is False
    failure_updates = [sql for sql in pool.conn.sql if 'UPDATE "topics"' in sql]
    assert failure_updates
    assert '"lastSynthesisSuccessAt"' not in failure_updates[-1]
