"""P1-D 主题聚合 + 综述 worker 守门单测。"""

from __future__ import annotations

import pytest

from ai_engine.radar.topic_aggregation_worker import _is_metadata_tag, _topic_slug
from ai_engine.radar.topic_proposal_worker import _clean_json, _source_key
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
    assert _is_metadata_tag(tag) is True


@pytest.mark.parametrize(
    "tag",
    [
        "rag", "huggingface-trending", "ai-agent", "mcp",
        "agent-evaluation", "vector-database",
        "深度学习", "扩散模型",
    ],
)
def test_is_metadata_tag_keeps_real_topic_tags(tag: str) -> None:
    assert _is_metadata_tag(tag) is False


def test_topic_slug_canonicalizes_case_and_separators() -> None:
    assert _topic_slug(" Agent Evaluation ") == "agent-evaluation"
    assert _topic_slug("MCP / Security") == "mcp-security"


def test_topic_proposal_source_key_uses_publisher_not_content_kind() -> None:
    assert _source_key("https://github.com/acme/tool", "github_repo") == "github:acme"
    assert _source_key("https://example.com/a", "rss") == "example.com"


def test_topic_proposal_payload_accepts_json_fence() -> None:
    assert _clean_json('```json\n{"proposals": []}\n```') == {"proposals": []}


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
