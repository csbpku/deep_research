"""P1-D V2 综述 worker 守门单测（ADR 0010）。"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from ai_engine.radar.topic_issue_worker import (
    AUTHORITATIVE_KINDS,
    _authoritative_count,
    _build_issue_prompt,
    _distinct_sources,
    _meets_authoritative_threshold,
    _meets_normal_threshold,
    _normalize_issues,
    _parse_payload,
)
from ai_engine.radar.topic_synthesis_v2 import (
    SYNTHESIS_VERSION,
    _build_prompt,
    _hash_input,
    _normalize,
    _parse_payload as _parse_v2_payload,
)


def test_hash_input_changes_when_candidate_count_grows() -> None:
    base = _hash_input(["a", "b"], ["title-a", "title-b"], "hot", None)
    nxt = _hash_input(["a", "b", "c"], ["title-a", "title-b", "title-c"], "hot", None)
    assert base != nxt


def test_hash_input_stable_when_input_unchanged() -> None:
    first = _hash_input(["a", "b"], ["title-a", "title-b"], "hot", None)
    second = _hash_input(["a", "b"], ["title-a", "title-b"], "hot", None)
    assert first == second


def test_hash_input_changes_when_first_seen_changes() -> None:
    first = _hash_input(["a"], ["title"], "hot", datetime(2026, 8, 1, tzinfo=timezone.utc))
    second = _hash_input(["a"], ["title"], "hot", datetime(2026, 8, 2, tzinfo=timezone.utc))
    assert first != second


def test_v2_prompt_requires_summaryIds_not_numbers() -> None:
    prompt = _build_prompt(
        "AI Agents",
        [
            {"id": "uuid-1", "title": "News", "snippet": "context", "interpretation": ""},
        ],
    )
    assert "summaryIds" in prompt
    assert "uuid-1" in prompt
    assert "[1]" not in prompt


def test_parse_v2_payload_handles_fenced_json() -> None:
    raw = "```json\n{\"tldr\":\"ok\",\"sections\":[],\"references\":[]}\n```"
    out = _parse_v2_payload(raw)
    assert out["tldr"] == "ok"


def test_normalize_drops_invalid_summary_ids() -> None:
    valid = {"abc", "def"}
    raw = {
        "tldr": "tldr",
        "keyChanges": [
            {"title": "k", "whyItMatters": "w", "summaryIds": ["abc", "ghost"]},
        ],
        "subtopics": [{"title": "s", "summary": "x"}],
        "openQuestions": ["?"],
        "sections": [
            {"title": "sec1", "content": "x", "summaryIds": ["def"]},
        ],
        "references": [
            {"summaryId": "abc", "title": "T"},
            {"summaryId": "ghost", "title": "T"},
        ],
    }
    out = _normalize(raw, valid)
    assert out["keyChanges"][0]["summaryIds"] == ["abc"]
    assert out["sections"][0]["summaryIds"] == ["def"]
    assert [r["summaryId"] for r in out["references"]] == ["abc"]


def test_normalize_drops_empty_key_changes() -> None:
    valid = {"a"}
    out = _normalize(
        {
            "tldr": "x",
            "keyChanges": [
                {"title": "k", "whyItMatters": "w", "summaryIds": []},
                {"title": "k2", "whyItMatters": "w2", "summaryIds": ["ghost"]},
            ],
            "subtopics": [],
            "openQuestions": [],
            "sections": [],
            "references": [],
        },
        valid,
    )
    assert out["keyChanges"] == []


def test_synthesis_version_is_v2() -> None:
    assert SYNTHESIS_VERSION == "v2"


# ── TopicIssue worker helpers ─────────────────────────────────────────


def _make_row(
    *,
    sid: str,
    kind: str = "rss",
    must_read: bool = False,
    host: str = "blog.dev",
    tier: str = "skim",
) -> dict[str, object]:
    return {
        "id": sid,
        "title": f"Title {sid}",
        "interpretation": "context",
        "tags": ["ai"],
        "originalKind": kind,
        "url": f"https://{host}/p/{sid}",
        "sourceHost": host,
        "distilledMustRead": must_read,
        "distilledTier": tier,
        "addedAt": datetime(2026, 8, 19, tzinfo=timezone.utc),
    }


def test_normal_threshold_requires_three_and_two_sources_and_one_deep() -> None:
    rows = [
        _make_row(sid="1", host="a.dev", tier="skim", must_read=True),
        _make_row(sid="2", host="b.dev", tier="skim"),
        _make_row(sid="3", host="c.dev", tier="skim"),
    ]
    assert _meets_normal_threshold(rows)

    too_few = rows[:2]
    assert not _meets_normal_threshold(too_few)

    same_source = [
        _make_row(sid="1", host="a.dev", tier="skim", must_read=True),
        _make_row(sid="2", host="a.dev", tier="skim"),
        _make_row(sid="3", host="a.dev", tier="skim"),
    ]
    assert not _meets_normal_threshold(same_source)

    no_deep = [
        _make_row(sid="1", host="a.dev", tier="skim", must_read=False),
        _make_row(sid="2", host="b.dev", tier="skim", must_read=False),
        _make_row(sid="3", host="c.dev", tier="skim", must_read=False),
    ]
    assert not _meets_normal_threshold(no_deep)


def test_authoritative_threshold_requires_authoritative_kind_and_must_read() -> None:
    rows = [
        _make_row(sid="1", kind="arxiv", must_read=True),
    ]
    assert _meets_authoritative_threshold(rows)

    no_kind = [_make_row(sid="1", kind="rss", must_read=True)]
    assert not _meets_authoritative_threshold(no_kind)

    no_must = [_make_row(sid="1", kind="arxiv", must_read=False)]
    assert not _meets_authoritative_threshold(no_must)


def test_distinct_sources_uses_host_then_kind() -> None:
    rows = [
        _make_row(sid="1", host="a.dev"),
        _make_row(sid="2", host="b.dev"),
        _make_row(sid="3", host="", kind="rss"),
    ]
    out = _distinct_sources(rows)
    assert len(out) == 3


def test_normalize_issues_filters_invalid_summary_ids() -> None:
    raw = {
        "issues": [
            {
                "kind": "event",
                "title": "Some release",
                "proposition": "X shipped Y",
                "summaryIds": ["good", "ghost"],
            },
            {
                "kind": "wrong",
                "title": "Bogus",
                "proposition": "p",
                "summaryIds": ["good"],
            },
            {
                "kind": "problem",
                "title": "Open problem",
                "proposition": "Fails under load",
                "summaryIds": [],
            },
        ],
    }
    out = _normalize_issues(raw, {"good"})
    assert len(out) == 1
    assert out[0]["kind"] == "event"
    assert out[0]["summaryIds"] == ["good"]


def test_build_issue_prompt_includes_kind_and_must_read() -> None:
    rows = [
        _make_row(sid="uuid-x", kind="arxiv", must_read=True),
    ]
    prompt = _build_issue_prompt("Topic", rows)
    assert "uuid-x" in prompt
    assert "kind=arxiv" in prompt
    assert "must_read=True" in prompt


def test_parse_payload_handles_fenced() -> None:
    raw = "```\n{\"issues\": []}\n```"
    out = _parse_payload(raw)
    assert out == {"issues": []}


def test_authoritative_kinds_set_includes_release_and_arxiv() -> None:
    assert "arxiv" in AUTHORITATIVE_KINDS
    assert "github_release" in AUTHORITATIVE_KINDS
    assert "rss" not in AUTHORITATIVE_KINDS


def test_authoritative_count_zero_without_kinds() -> None:
    rows = [_make_row(sid="1", kind="rss"), _make_row(sid="2", kind="web")]
    assert _authoritative_count(rows) == 0


def test_authoritative_count_one_with_arxiv() -> None:
    rows = [_make_row(sid="1", kind="arxiv"), _make_row(sid="2", kind="rss")]
    assert _authoritative_count(rows) == 1
