"""One-time import of GitHub repositories from a daily-report Markdown table.

The importer deliberately reuses the production radar pipeline:

* existing canonical URLs are filtered before the source run, so this import
  never refreshes or mutates an existing summary;
* new rows are scored with the normal GitHub engineering profile;
* enrichment is drained in bounded passes for this import's sync run only.

Usage:
  uv run python scripts/import_github_trending_summary.py
"""

from __future__ import annotations

import argparse
import asyncio
import re
import sys
from datetime import date, datetime, time, timezone
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

sys.path.insert(0, __file__.rsplit("/scripts/", 1)[0])

from ai_engine.adapters.base import build_adapter
from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar.distilled_scorer import ScoringMonitor, score_with_llm
from ai_engine.radar.enrichment_worker import run_enrichment_for_pending
from ai_engine.radar.models import RadarCandidate
from ai_engine.radar.sync_runner import normalize_candidate, run_radar_pipeline


DEFAULT_REPORT_URL = (
    "https://raw.githubusercontent.com/kaiye/daily-report/main/"
    "output/github-trending-summary.md"
)
DEFAULT_SOURCE_NAME = "GitHub Trending AI/ML"
SOURCE_URL = (
    "https://github.com/kaiye/daily-report/blob/main/"
    "output/github-trending-summary.md"
)

_ROW_RE = re.compile(
    r"^\|\s*(?P<rank>\d+)\s*\|\s*"
    r"\[(?P<repo>[^\]]+)\]\((?P<url>https?://github\.com/[^)]+)\)\s*\|\s*"
    r"(?P<appearances>\d+)\s*\|\s*(?P<dates>[^|]+?)\s*\|\s*"
    r"(?P<description>.*?)\s*\|$",
    re.IGNORECASE,
)


def _repo_url(raw_url: str) -> str | None:
    parsed = urlsplit(raw_url.strip())
    if parsed.netloc.lower() not in {"github.com", "www.github.com"}:
        return None
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) != 2:
        return None
    owner, repo = parts
    if repo.endswith(".git"):
        repo = repo[:-4]
    if not owner or not repo:
        return None
    return urlunsplit(("https", "github.com", f"/{owner}/{repo}", "", ""))


def _last_seen(value: str) -> datetime | None:
    parts = [part.strip() for part in value.split("/", 1)]
    raw = parts[-1] if parts else ""
    try:
        return datetime.combine(
            date.fromisoformat(raw),
            time.min,
            tzinfo=timezone.utc,
        )
    except ValueError:
        return None


def parse_report(markdown: str, *, report_url: str = SOURCE_URL) -> list[RadarCandidate]:
    """Parse the report's repository table and preserve its trend evidence."""
    candidates: list[RadarCandidate] = []
    seen: set[str] = set()
    for line in markdown.splitlines():
        match = _ROW_RE.match(line.strip())
        if match is None:
            continue
        url = _repo_url(match.group("url"))
        if url is None or url in seen:
            continue
        seen.add(url)
        repo = match.group("repo").strip()
        description = re.sub(r"\s+", " ", match.group("description")).strip()
        rank = int(match.group("rank"))
        appearances = int(match.group("appearances"))
        candidates.append(
            RadarCandidate(
                title=repo[:300],
                url=url,
                snippet=description[:8000],
                published_at=_last_seen(match.group("dates")),
                content_origin="api",
                tags=("github", "trending", "daily_report_import"),
                source_quality_hint=0.92,
                timeliness_hint=min(1.0, appearances / 30.0),
                repo_signals={
                    "trendRank": rank,
                    "trendAppearances": appearances,
                    "trendFirstLastSeen": match.group("dates").strip(),
                    "trendReportUrl": report_url,
                },
            )
        )
    if not candidates:
        raise ValueError("report did not contain any GitHub repository rows")
    return candidates


async def _download(url: str) -> str:
    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=httpx.Timeout(60.0, connect=15.0),
        headers={"User-Agent": "deep-research-radar-one-time-import/1.0"},
    ) as client:
        response = await client.get(url)
        response.raise_for_status()
        return response.text


async def _load_source(pool: Any, source_name: str) -> dict[str, Any]:
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT "id", "name", "sourceType", "enabled", "autoPausedAt" '
                'FROM "radar_sources" WHERE "name" = %s LIMIT 1',
                (source_name,),
            )
        ).fetchone()
    if row is None:
        raise RuntimeError(f"radar source not found: {source_name}")
    result = dict(row)
    if result["sourceType"] != "github":
        raise RuntimeError(
            f"unexpected source type for {source_name}: {result['sourceType']}"
        )
    if not result["enabled"] or result["autoPausedAt"] is not None:
        raise RuntimeError(f"radar source is not active: {source_name}")
    return result


async def _existing_urls(pool: Any, candidates: list[RadarCandidate]) -> set[str]:
    canonical_urls = [
        normalize_candidate(candidate).canonical_url for candidate in candidates
    ]
    placeholders = ",".join(["%s"] * len(canonical_urls))
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                f'SELECT "canonicalUrl" FROM "summaries" '
                f'WHERE "canonicalUrl" IN ({placeholders})',
                tuple(canonical_urls),
            )
        ).fetchall()
    return {str(row["canonicalUrl"]) for row in rows}


async def _import_candidates(
    pool: Any,
    *,
    source_id: str,
    candidates: list[RadarCandidate],
    candidate_concurrency: int,
    enrichment_concurrency: int,
    enrichment_passes: int,
) -> tuple[Any, list[str]]:
    import_candidates = candidates
    sync_run_ids: list[str] = []

    async def fetch_once(_config: dict[str, Any]) -> list[RadarCandidate]:
        return import_candidates

    adapter = build_adapter()
    monitor = ScoringMonitor()
    pipeline = await run_radar_pipeline(
        pool,
        triggered_by="admin",
        adapter=adapter,
        distilled_scorer=score_with_llm,
        monitor=monitor,
        source_ids={source_id},
        fetchers={"github": fetch_once},
        candidate_concurrency=max(1, candidate_concurrency),
    )
    sync_run_ids.extend(run.run_id for run in pipeline.sync.runs)

    # Admin-triggered pipelines intentionally make one enrichment pass. Drain
    # this import explicitly so a 500-row one-time batch is not left behind
    # after only the first worker-sized claim.
    for _ in range(max(1, enrichment_passes)):
        await run_enrichment_for_pending(
            pool,
            limit=max(1, enrichment_concurrency),
            sync_run_ids=tuple(sync_run_ids),
            concurrency=max(1, enrichment_concurrency),
        )
        async with pool.connection() as conn:
            row = await (
                await conn.execute(
                    'SELECT count(*) AS n FROM "summaries" '
                    'WHERE "syncRunId" = ANY(%s::uuid[]) '
                    'AND "originalKind" = \'github_repo\' '
                    'AND ("distilledTier" IN (\'collection\', \'deep_read\') '
                    'OR "distilledTargetTier" IN (\'collection\', \'deep_read\')) '
                    'AND ("enrichmentStatus" IN (\'pending\', \'retryable\') '
                    'OR "enrichmentStatus" IS NULL)',
                    (sync_run_ids,),
                )
            ).fetchone()
        if not row or int(row["n"]) == 0:
            break
    return pipeline, sync_run_ids


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-url", default=DEFAULT_REPORT_URL)
    parser.add_argument("--source-name", default=DEFAULT_SOURCE_NAME)
    parser.add_argument("--candidate-concurrency", type=int, default=4)
    parser.add_argument("--enrichment-concurrency", type=int, default=2)
    parser.add_argument("--enrichment-passes", type=int, default=250)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    markdown = await _download(args.report_url)
    candidates = parse_report(markdown, report_url=SOURCE_URL)
    print(f"report_rows={len(candidates)}", flush=True)

    store = DbJobStore(dsn=__import__("os").environ["DATABASE_URL"])
    await store.open()
    try:
        source = await _load_source(store.pool, args.source_name)
        existing = await _existing_urls(store.pool, candidates)
        new_candidates = [
            candidate
            for candidate in candidates
            if normalize_candidate(candidate).canonical_url not in existing
        ]
        print(f"existing_untouched={len(candidates) - len(new_candidates)}", flush=True)
        print(f"new_candidates={len(new_candidates)}", flush=True)
        if args.dry_run or not new_candidates:
            return 0

        pipeline, sync_run_ids = await _import_candidates(
            store.pool,
            source_id=str(source["id"]),
            candidates=new_candidates,
            candidate_concurrency=args.candidate_concurrency,
            enrichment_concurrency=args.enrichment_concurrency,
            enrichment_passes=args.enrichment_passes,
        )
        result = pipeline.sync
        print(
            "sync="
            f"fetched:{sum(run.total_fetched for run in result.runs)} "
            f"new:{sum(run.total_new for run in result.runs)} "
            f"skipped:{sum(run.total_skipped for run in result.runs)} "
            f"failed:{sum(run.total_failed for run in result.runs)} "
            f"scored:{monitor_count_placeholder()}",
            flush=True,
        )
        print(f"sync_run_ids={','.join(sync_run_ids)}", flush=True)
        print(
            f"enriched_initial={pipeline.enriched_count} "
            f"elapsed_seconds={pipeline.enrichment_elapsed_ms / 1000:.1f}",
            flush=True,
        )
    finally:
        await store.close()
    return 0


def monitor_count_placeholder() -> str:
    # Kept as a stable field in the operator output; per-row score counts are
    # read from the database in the post-import audit query.
    return "see_post_import_audit"


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
