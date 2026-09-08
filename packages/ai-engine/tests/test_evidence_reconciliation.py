"""Pure contracts for the browser-independent evidence handoff."""

from __future__ import annotations

from ai_engine.evidence_reconciliation import research_revision_hash, source_snapshot_hash


def test_revision_hash_matches_the_web_snapshot_shape() -> None:
    row = {
        "title": "标题",
        "body": "正文",
        "background": None,
        "conclusion": "结论",
        "risks": None,
        "tags": ["a", "b"],
    }

    # This value is also produced by JSON.stringify in
    # apps/web/src/lib/research-revision.ts.
    assert research_revision_hash(row) == (
        "865912a38aca6d83c65070d580acaa2342c7b1e4dc8e4a87bdae8b9a64722c1d"
    )


def test_source_snapshot_hash_is_order_independent() -> None:
    first = [
        {
            "canonicalKey": "https://b.example",
            "sourceRef": {"type": "url", "value": "https://b.example"},
            "title": "B",
            "description": "证据 B",
        },
        {
            "canonicalKey": "https://a.example",
            "sourceRef": {"type": "url", "value": "https://a.example"},
            "title": "A",
            "description": "证据 A",
        },
    ]

    assert source_snapshot_hash(first) == source_snapshot_hash(list(reversed(first)))
