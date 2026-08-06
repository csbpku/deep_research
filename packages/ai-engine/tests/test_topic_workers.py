"""P1-D 主题聚合 + 综述 worker 守门单测。"""

from __future__ import annotations

import pytest

from ai_engine.radar.topic_aggregation_worker import _topic_slug
from ai_engine.radar.topic_clustering import (
    build_candidate_clusters,
    is_metadata_tag,
    title_concepts,
)
from ai_engine.radar.topic_proposal_worker import _clean_json, _prompt, _source_key
from ai_engine.radar.topic_synthesis_worker import _parse_payload


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
