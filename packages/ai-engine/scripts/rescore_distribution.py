"""Re-score existing summaries with the M7 thresholds to validate the new
distribution before/after comparison. Pure deterministic — no LLM needed.

Usage:
    cd packages/ai-engine && uv run python scripts/rescore_distribution.py
"""

from __future__ import annotations

import os
import sys
from collections import Counter

import psycopg

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:testpass123@localhost:5432/postgres",
)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "..", "..", "apps", "web"))
sys.path.insert(0, os.path.dirname(__file__))

from ai_engine.radar.distilled_scorer import compute_score  # noqa: E402
from ai_engine.radar.sync_runner import _is_low_quality_content  # noqa: E402
from ai_engine.scoring.scoring_profiles import profile_for_source_url  # noqa: E402


def _parsed_from_persisted(score_json: dict) -> dict:
    """Map a persisted distilledScore JSON to a parsed dict that
    ``compute_score`` accepts.

    The DB stores v2 camelCase keys; ``compute_score`` reads both shapes
    internally, but we also need to keep validation/scope/implementation
    fields that aren't part of the JSON we returned in M7.
    """
    return {
        # v2 dimension keys — same shape the LLM emits.
        "信息增量": score_json.get("dimensions", {}).get("info_increment", 0),
        "分析深度": score_json.get("dimensions", {}).get("analysis_depth", 0),
        "可行动性": score_json.get("dimensions", {}).get("actionability", 0),
        "事实可信度": score_json.get("dimensions", {}).get("fact_credibility", 0),
        "时效性": score_json.get("dimensions", {}).get("timeliness", 0),
        "表达质量": score_json.get("dimensions", {}).get("expression_quality", 0),
        "综合信号": score_json.get("dimensions", {}).get("audience_fit", 0),
        # direct_relevance / scope / validation — v2 emits these explicitly.
        "direct_relevance": score_json.get("directRelevance"),
        "scope_breadth": score_json.get("scopeBreadth"),
        "validation_breadth": score_json.get("validationBreadth"),
        "implementation_stage": score_json.get("implementationStage", 2),
        # Optional evidence strings; we don't have them post-hoc.
        "relevance_evidence": score_json.get("relevanceEvidence") or "",
        "scope_evidence": score_json.get("scopeEvidence") or "",
        # No-ops for rescore.
        "weak_point": score_json.get("weakPoint") or "",
        "veto": None,
        "risk_flag": None,
        "suspected_repost": False,
    }


def main() -> int:
    conn = psycopg.connect(DATABASE_URL)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT s.id, s.title, s."distilledScore", s.tags, s."originalMarkdown", s.body,
                   rsr."sourceId", rsrc."sourceType"
            FROM summaries s
            JOIN "radar_sync_runs" rsr ON rsr.id = s."syncRunId"
            JOIN "radar_sources" rsrc ON rsrc.id = rsr."sourceId"
            WHERE s.source='daily' AND s."syncRunId" IS NOT NULL
              AND s."summaryDate" >= current_date - interval '7 days'
              AND s."distilledScore" IS NOT NULL
        """)
        rows = cur.fetchall()

    old_counter: Counter = Counter()
    new_counter: Counter = Counter()
    flips: list[tuple[str, str, str, float, float]] = []
    for summary_id, title, score_json, tags, original_markdown, body, _source_id, source_type in rows:
        if not score_json:
            continue
        content = str(original_markdown or body or "")
        if "content_pending" in (tags or []) or _is_low_quality_content(content):
            print(f"SKIP {summary_id[:8]} ({title[:40]}): incomplete content")
            continue
        old_tier = score_json.get("tier", "noise")
        old_counter[old_tier] += 1

        parsed = _parsed_from_persisted(dict(score_json))
        profile, _profile_id = profile_for_source_url(source_type)
        try:
            result = compute_score(parsed, source_type=source_type, profile=profile)
        except Exception as exc:
            print(f"WARN {summary_id[:8]} ({title[:40]}): {exc}")
            continue
        new_counter[result.tier] += 1
        if result.tier != old_tier:
            old_score = score_json.get("total") or score_json.get("rankingScore") or 0
            flips.append((title[:60], old_tier, result.tier, old_score, result.ranking_score))

    total = sum(old_counter.values())
    print(f"Total re-scored: {total}")
    print()
    print(f"{'tier':<14} {'before':>10} {'after':>10} {'Δpp':>10}")
    print("-" * 50)
    for tier in ("noise", "skim", "deep_read", "collection"):
        old_n = old_counter.get(tier, 0)
        new_n = new_counter.get(tier, 0)
        old_pp = old_n / total * 100
        new_pp = new_n / total * 100
        print(f"{tier:<14} {old_pp:>9.1f}% {new_pp:>9.1f}% {new_pp - old_pp:>+9.1f}")

    print()
    print(f"Flips ({len(flips)} items moved):")
    for title, old_tier, new_tier, old_score, new_score in flips[:25]:
        print(f"  [{old_tier} -> {new_tier}] score {old_score:.1f} -> {new_score:.1f}  {title}")
    if len(flips) > 25:
        print(f"  ... and {len(flips) - 25} more")
    return 0


if __name__ == "__main__":
    sys.exit(main())
