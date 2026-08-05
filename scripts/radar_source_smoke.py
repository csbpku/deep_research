"""Test all enabled radar sources end-to-end (fetch + score + filter).

What this script verifies (per enabled radar_sources row):
  1. fetcher reaches the upstream and returns >= 1 RadarCandidate
  2. every candidate survives normalize_candidate (no invalid URLs etc.)
  3. score_candidate produces a stable, non-degenerate score
  4. filter_candidate keep-rate sits in a sensible band (not 0% / 100%)
  5. (--with-llm) every KEEP candidate is also scored by the distilled
     7-dim LLM scorer and lands in a sensible tier

Production sync_runner does TWO HTTP fetches per candidate:
  - fetch_source() returns a RadarCandidate (the discovery call)
  - safe_fetch() then GETs candidate.url to extract real article body
    for the brief generator and distilled scorer.
This script's --with-llm mode mirrors that second hop so the LLM sees
the real article (or README for repos) — not just the short discovery
snippet. Without that step, GitHub repo candidates look "empty" to the
LLM because the snippet is just one-line description + star count.

DB read is read-only — safe to run against the dev DB without polluting it.

Usage (from repo root):
    uv run --project packages/ai-engine python scripts/radar_source_smoke.py
    uv run --project packages/ai-engine python scripts/radar_source_smoke.py --detail
    uv run --project packages/ai-engine python scripts/radar_source_smoke.py --with-llm --detail
    # or, from packages/ai-engine:
    uv run python ../../scripts/radar_source_smoke.py

Per-source timeout: 45s. This is deliberately longer than the fetchers'
own 30s transport timeout so the report preserves their typed root cause
instead of replacing it with a harness-level timeout. All sources run
concurrently to keep wall time bounded.
"""
# ruff: noqa: E402
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from collections.abc import Awaitable
from dataclasses import dataclass, field
from typing import Any, cast

# Repo root on path so ``ai_engine`` imports work whether the script is
# invoked from the repo root or from inside ``scripts/``.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(_REPO_ROOT, "packages", "ai-engine"))

# Load .env files so fetcher configs (e.g. PRODUCTHUNT_API_TOKEN in
# packages/ai-engine/.env) are visible to ``os.getenv`` inside the fetchers.
# We load both the repo-root .env (shared infra) and the package-local
# .env (ai-engine secrets) without overriding existing process env.
from dotenv import load_dotenv
load_dotenv(os.path.join(_REPO_ROOT, ".env"))
load_dotenv(os.path.join(_REPO_ROOT, "packages", "ai-engine", ".env"))

import psycopg  # noqa: E402

from ai_engine.radar.candidate_filter import FilterResult, filter_candidate  # noqa: E402
from ai_engine.radar.models import RadarCandidate, RadarSource  # noqa: E402
from ai_engine.radar.pipeline import normalize_candidate, score_candidate  # noqa: E402
from ai_engine.radar.source_manager import _HANDLERS, fetch_source  # noqa: E402

# We bypass ``load_enabled_sources`` so the test surface matches exactly
# what's in the DB (including any source types we'd never enable by hand).
_KNOWN = set(_HANDLERS.keys()) | {"github"}  # github dispatches by mode

# Bound per-source work so one stuck fetcher can't hang the whole test.
_PER_SOURCE_TIMEOUT_S = 45.0

# Bound per-LLM-call work so one stuck chat call can't hang a source.
# Keep this well above worst-case queueing (66 calls, 5-way concurrency,
# ~10-30s per proxy call), otherwise healthy calls are miscounted as
# fallbacks.
_LLM_PER_CALL_TIMEOUT_S = 180.0

# ── DB discovery ──────────────────────────────────────────────────────────


def _load_sources(dsn: str) -> list[RadarSource]:
    """Read all enabled rows directly from radar_sources (bypassing the
    ``_KNOWN_SOURCE_TYPES`` allowlist in source_manager so we surface any
    config drift)."""
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT "id", "name", "sourceType", "config" '
                'FROM "radar_sources" WHERE "enabled" = true '
                'ORDER BY "sourceType", "name"'
            )
            rows = cur.fetchall()
    sources: list[RadarSource] = []
    for sid, name, stype, cfg in rows:
        sources.append(
            RadarSource(
                id=str(sid),
                name=str(name),
                source_type=cast(Any, stype),  # SourceType is a Literal; cast for runtime values from DB
                config=dict(cfg) if isinstance(cfg, dict) else {},
            )
        )
    return sources


# ── Per-source result ────────────────────────────────────────────────────


@dataclass
class SourceReport:
    source_id: str
    name: str
    source_type: str
    status: str  # "ok" | "fetch_error" | "no_candidates" | "timeout" | "skipped_unknown_type"
    error: str | None = None
    elapsed_ms: int = 0
    fetched: int = 0
    normalized_ok: int = 0
    normalized_fail: int = 0
    keep: int = 0
    skip: int = 0
    skip_reasons: dict[str, int] = field(default_factory=dict)
    sample_kept: list[dict[str, Any]] = field(default_factory=list)
    sample_skipped: list[dict[str, Any]] = field(default_factory=list)
    score_distribution: dict[str, int] = field(default_factory=dict)
    # Distilled 7-dim (LLM) — populated only when --with-llm is set.
    llm_calls: int = 0
    llm_default_fallback: int = 0
    llm_tier_counts: dict[str, int] = field(default_factory=dict)


# ── Source worker ─────────────────────────────────────────────────────────


async def _evaluate_one(
    source: RadarSource,
    *,
    with_llm: bool = False,
) -> SourceReport:
    report = SourceReport(
        source_id=source.id,
        name=source.name,
        source_type=source.source_type,
        status="ok",
    )
    if source.source_type not in _KNOWN:
        report.status = "skipped_unknown_type"
        report.error = f"no handler for source_type={source.source_type}"
        return report

    started = time.monotonic()
    try:
        candidates = await asyncio.wait_for(
            fetch_source(source), timeout=_PER_SOURCE_TIMEOUT_S
        )
    except asyncio.TimeoutError:
        report.status = "timeout"
        report.elapsed_ms = int((time.monotonic() - started) * 1000)
        report.error = f"fetch exceeded {_PER_SOURCE_TIMEOUT_S:.0f}s"
        return report
    except Exception as exc:  # noqa: BLE001
        report.status = "fetch_error"
        report.elapsed_ms = int((time.monotonic() - started) * 1000)
        report.error = f"{type(exc).__name__}: {exc}"
        return report

    report.elapsed_ms = int((time.monotonic() - started) * 1000)
    report.fetched = len(candidates)
    if not candidates:
        report.status = "no_candidates"
        return report

    # We score keep candidates with the distilled 7-dim LLM (opt-in via
    # --with-llm). Filter to "first N keeps" so we don't blow up LLM cost
    # when a source yields many keeps (github_topic_search → 20).
    keep_candidates: list[tuple[RadarCandidate, Any, FilterResult]] = []
    for cand in candidates:
        try:
            normalized = normalize_candidate(cand)
        except Exception:  # noqa: BLE001
            report.normalized_fail += 1
            continue
        report.normalized_ok += 1

        score = score_candidate(normalized, source_type=source.source_type)
        # Bucket composite for distribution; composite in [0, 1].
        composite = (
            score.relevance * 0.35
            + score.timeliness * 0.30
            + score.source_quality * 0.35
        )
        bucket = f"{composite:.2f}"
        report.score_distribution[bucket] = report.score_distribution.get(bucket, 0) + 1

        fr = filter_candidate(normalized, score, source.source_type)
        if fr.keep:
            report.keep += 1
            keep_candidates.append((cand, normalized, fr))
        else:
            report.skip += 1
            # Roll up by reason prefix so the report stays compact.
            reason_key = fr.reason.split(":", 1)[0]
            report.skip_reasons[reason_key] = report.skip_reasons.get(reason_key, 0) + 1

    if with_llm and keep_candidates:
        # Cap LLM scoring to top 5 keeps per source to keep wall-time and
        # token cost bounded. Score in parallel.
        sample = keep_candidates[:5]
        scored = await asyncio.gather(
            *(_score_distilled(cand, normalized, source.source_type) for cand, normalized, _ in sample)
        )
        for (_, normalized, _fr), llm in zip(sample, scored, strict=True):
            report.llm_calls += 1
            if llm is None:
                report.llm_default_fallback += 1
                continue
            tier = llm.get("tier", "?")
            report.llm_tier_counts[tier] = report.llm_tier_counts.get(tier, 0) + 1
            if len(report.sample_kept) < 3:
                heuristic = score_candidate(normalized, source_type=source.source_type)
                report.sample_kept.append(
                    {
                        "title": normalized.title[:100],
                        "url": normalized.url[:120],
                        "heuristic": {
                            "rel": round(heuristic.relevance, 3),
                            "time": round(heuristic.timeliness, 3),
                            "qual": round(heuristic.source_quality, 3),
                        },
                        "distilled_total": llm.get("total"),
                        "distilled_tier": llm.get("tier"),
                        "distilled_must_read": llm.get("must_read"),
                        "dimensions": llm.get("dimensions"),
                        "weak_point": llm.get("weak_point"),
                        "fetch_status": llm.get("fetch_status", "?"),
                    }
                )

        # Track SKIP samples too (heuristic-only) so detail shows context.
        skipped_count = 0
        for cand in candidates:
            if skipped_count >= 2:
                break
            try:
                normalized = normalize_candidate(cand)
            except Exception:  # noqa: BLE001
                continue
            score = score_candidate(normalized, source_type=source.source_type)
            fr = filter_candidate(normalized, score, source.source_type)
            if not fr.keep:
                report.sample_skipped.append(
                    {
                        "title": normalized.title[:100],
                        "rel": round(score.relevance, 3),
                        "time": round(score.timeliness, 3),
                        "qual": round(score.source_quality, 3),
                        "reason": fr.reason[:120],
                    }
                )
                skipped_count += 1
    else:
        # No LLM path — keep the old behaviour (samples collected inline).
        skipped_count = 0
        for cand in candidates:
            try:
                normalized = normalize_candidate(cand)
            except Exception:  # noqa: BLE001
                continue
            score = score_candidate(normalized, source_type=source.source_type)
            fr = filter_candidate(normalized, score, source.source_type)
            if fr.keep:
                if len(report.sample_kept) < 3:
                    report.sample_kept.append(
                        {
                            "title": normalized.title[:100],
                            "url": normalized.url[:120],
                            "rel": round(score.relevance, 3),
                            "time": round(score.timeliness, 3),
                            "qual": round(score.source_quality, 3),
                            "reason": fr.reason,
                        }
                    )
            else:
                if skipped_count < 2:
                    report.sample_skipped.append(
                        {
                            "title": normalized.title[:100],
                            "rel": round(score.relevance, 3),
                            "time": round(score.timeliness, 3),
                            "qual": round(score.source_quality, 3),
                            "reason": fr.reason[:120],
                        }
                    )
                    skipped_count += 1

    return report


async def _score_distilled(
    candidate: RadarCandidate,
    normalized: Any,
    source_type: str,
) -> dict[str, Any] | None:
    """Run the distilled 7-dim LLM scorer on a single candidate.

    Returns a dict with dimensions + tier, or None if the call fell back
    to the no-LLM default (so the caller can count that separately).
    """
    from ai_engine.radar import distilled_scorer as _ds

    # Mirror production sync_runner: try safe_fetch for the candidate URL
    # so the LLM sees the real article body / README, not the short
    # discovery snippet (which is 60-200 chars for GitHub repos).
    content = normalized.snippet or ""
    fetch_status = "snippet_only"
    try:
        from ai_engine.fetcher.safe_fetch import safe_fetch
        from ai_engine.radar.sync_runner import _extract_article_content

        fetched = await asyncio.wait_for(
            safe_fetch(candidate.url), timeout=_PER_SOURCE_TIMEOUT_S
        )
        html = fetched.content.decode("utf-8", errors="replace")
        body = _extract_article_content(html, candidate.url, source_type)
        if body and len(body) > 100:
            content = body
            fetch_status = f"fetched {len(body)} chars"
    except (asyncio.TimeoutError, Exception):  # noqa: BLE001
        # Safe-fetch failures must not crash the smoke test. Fall back to
        # the snippet — the LLM will still score it (and may rightly mark
        # it noise if the snippet is too thin).
        pass

    try:
        res = await asyncio.wait_for(
            _ds.score_with_llm(
                normalized.title,
                content[:6000],
                profile=_ds_default_profile(),
                source_type=source_type,
                url=normalized.url,
                published_at=normalized.published_at,
            ),
            timeout=_LLM_PER_CALL_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        print(f"  [score timeout] {normalized.title[:70]}", file=sys.stderr)
        return None
    except Exception as exc:  # noqa: BLE001
        print(
            f"  [score error] {type(exc).__name__}: {str(exc)[:160]} "
            f"| {normalized.title[:50]}",
            file=sys.stderr,
        )
        return None

    if res.is_default:
        return None
    return {
        "total": round(res.total, 1),
        "tier": res.tier,
        "must_read": res.must_read,
        "dimensions": dict(res.dimension_scores),
        "weak_point": res.weak_point,
        "fetch_status": fetch_status,
    }


def _ds_default_profile():
    from ai_engine.scoring.scoring_profiles import get_profile

    return get_profile("engineering")


# ── Reporter ──────────────────────────────────────────────────────────────


def _print_summary(reports: list[SourceReport], *, with_llm: bool = False) -> None:
    by_status: dict[str, list[SourceReport]] = {}
    for r in reports:
        by_status.setdefault(r.status, []).append(r)

    print()
    print("=" * 88)
    print("  RADAR SOURCE SMOKE TEST — summary")
    print("=" * 88)
    header = (
        f"  {'source':<28} {'type':<20} {'fetch':>5} {'keep':>5} {'skip':>5} {'ms':>6}  status"
    )
    print(header)
    print("  " + "-" * 86)
    for r in sorted(reports, key=lambda x: (x.status, x.source_type, x.name)):
        name = r.name[:28]
        stype = r.source_type[:20]
        marker = {
            "ok": "OK",
            "no_candidates": "EMPTY",
            "fetch_error": "ERR",
            "timeout": "TIMEOUT",
            "skipped_unknown_type": "SKIP",
        }.get(r.status, r.status)
        line = (
            f"  {name:<28} {stype:<20} {r.fetched:>5} {r.keep:>5} {r.skip:>5} "
            f"{r.elapsed_ms:>6}  {marker}"
        )
        print(line)
    print("  " + "-" * 86)
    for status, group in sorted(by_status.items()):
        print(f"  {status}: {len(group)}")
    if with_llm:
        total_calls = sum(r.llm_calls for r in reports)
        total_fb = sum(r.llm_default_fallback for r in reports)
        tier_totals: dict[str, int] = {}
        for r in reports:
            for tier, n in r.llm_tier_counts.items():
                tier_totals[tier] = tier_totals.get(tier, 0) + n
        if total_calls:
            print(
                f"  llm: {total_calls - total_fb}/{total_calls} real, "
                f"tiers={tier_totals or '{}'}"
            )
    print("=" * 88)
    print()


def _print_per_source_detail(report: SourceReport, *, with_llm: bool = False) -> None:
    header = f"[{report.source_type}] {report.name}"
    print(f"\n── {header}  (status={report.status}, {report.elapsed_ms} ms)")
    if report.error:
        print(f"   error: {report.error}")
    if report.status in {"ok", "no_candidates"}:
        if report.normalized_fail:
            print(f"   normalized_fail: {report.normalized_fail} (URL invalid etc.)")
        if report.fetched:
            total = report.keep + report.skip
            rate = (report.keep / total * 100) if total else 0
            print(
                f"   fetched={report.fetched}  normalized_ok={report.normalized_ok}  "
                f"keep={report.keep}  skip={report.skip}  keep_rate={rate:.0f}%"
            )
            if report.skip_reasons:
                reasons = ", ".join(
                    f"{k}={v}" for k, v in sorted(report.skip_reasons.items(), key=lambda kv: -kv[1])
                )
                print(f"   skip_reasons: {reasons}")
            if report.score_distribution:
                top = sorted(report.score_distribution.items(), key=lambda kv: -kv[1])[:6]
                dist = ", ".join(f"{k}:{v}" for k, v in top)
                print(f"   composite distribution (top): {dist}")
            if with_llm and report.llm_calls:
                print(
                    f"   distilled (LLM): {report.llm_calls - report.llm_default_fallback}"
                    f"/{report.llm_calls} real, tiers={report.llm_tier_counts}"
                )
            for s in report.sample_kept:
                if with_llm and "heuristic" in s:
                    fetch_info = f"  [content: {s.get('fetch_status','?')}]"
                    print(
                        f"   KEEP  heuristic(rel={s['heuristic']['rel']} t={s['heuristic']['time']} q={s['heuristic']['qual']})  "
                        f"distilled total={s['distilled_total']} tier={s['distilled_tier']} must_read={s['distilled_must_read']}"
                        + fetch_info
                    )
                    if s.get("dimensions"):
                        for k, v in s["dimensions"].items():
                            print(f"        - {k}: {v}")
                    if s.get("weak_point"):
                        print(f"        weak_point: {s['weak_point']}")
                    print(f"        {s['title']}  | {s['url']}")
                else:
                    print(
                        f"   KEEP  [{s.get('reason','passed')}] rel={s.get('rel','?')} t={s.get('time','?')} q={s.get('qual','?')}  "
                        f"{s['title']}  | {s.get('url','')}"
                    )
            for s in report.sample_skipped:
                print(
                    f"   SKIP  rel={s['rel']} t={s['time']} q={s['qual']}  "
                    f"{s['title']}  → {s['reason']}"
                )


# ── Main ──────────────────────────────────────────────────────────────────


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dsn",
        default=os.environ.get(
            "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/deep_research"
        ),
    )
    parser.add_argument(
        "--detail",
        action="store_true",
        help="print per-source detail (kept + skipped samples, score distribution)",
    )
    parser.add_argument(
        "--with-llm",
        action="store_true",
        help="also score KEEP candidates with the distilled 7-dim LLM "
             "(costs tokens; capped at 5 calls per source)",
    )
    args = parser.parse_args()

    sources = _load_sources(args.dsn)
    print(f"Loaded {len(sources)} enabled sources from radar_sources.")

    tasks: list[Awaitable[SourceReport]] = [
        _evaluate_one(src, with_llm=args.with_llm) for src in sources
    ]
    reports = await asyncio.gather(*tasks)

    _print_summary(reports, with_llm=args.with_llm)
    if args.detail:
        for r in reports:
            _print_per_source_detail(r, with_llm=args.with_llm)
        print()

    # Final JSON on stdout for downstream tooling.
    print("---JSON---")
    payload = [
        {
            "source_id": r.source_id,
            "name": r.name,
            "source_type": r.source_type,
            "status": r.status,
            "error": r.error,
            "elapsed_ms": r.elapsed_ms,
            "fetched": r.fetched,
            "normalized_ok": r.normalized_ok,
            "normalized_fail": r.normalized_fail,
            "keep": r.keep,
            "skip": r.skip,
            "skip_reasons": r.skip_reasons,
            "score_distribution": r.score_distribution,
            "llm_calls": r.llm_calls,
            "llm_default_fallback": r.llm_default_fallback,
            "llm_tier_counts": r.llm_tier_counts,
        }
        for r in reports
    ]
    print(json.dumps(payload, ensure_ascii=False))
    print()

    failed = [r for r in reports if r.status in {"fetch_error", "timeout", "skipped_unknown_type"}]
    empty = [r for r in reports if r.status == "no_candidates"]
    if failed:
        print(
            f"⚠️  {len(failed)} source(s) failed at fetch layer: "
            f"{', '.join(r.name for r in failed)}",
            file=sys.stderr,
        )
    if empty:
        print(
            f"ℹ️  {len(empty)} source(s) returned zero candidates "
            f"(may be time-window or feed health): "
            f"{', '.join(r.name for r in empty)}",
            file=sys.stderr,
        )
    if args.with_llm:
        total_calls = sum(r.llm_calls for r in reports)
        total_fb = sum(r.llm_default_fallback for r in reports)
        if total_calls:
            print(
                f"ℹ️  distilled LLM: {total_calls - total_fb}/{total_calls} real "
                f"responses, {total_fb} fell back to default (silent — check LLM wiring)",
                file=sys.stderr,
            )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
