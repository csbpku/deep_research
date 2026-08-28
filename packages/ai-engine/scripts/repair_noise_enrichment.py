"""Repair known noise rows with incomplete or mismatched enrichment.

GitHub repository enrichment follows the normal runtime policy:

    public Zread -> enabled Zread CLI -> GitHub README fallback

Tracked-repo daily digests are explicitly excluded because they represent
24-hour activity, not repository documentation.
"""

from __future__ import annotations

import argparse
import asyncio
from collections import Counter
from collections.abc import Awaitable, Callable
import hashlib
import os
import sys
from typing import Any

from dotenv import load_dotenv

PACKAGE_ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, PACKAGE_ROOT)
load_dotenv(os.path.join(PACKAGE_ROOT, ".env"))

from ai_engine.job_runner.db_store import DbJobStore  # noqa: E402
from ai_engine.radar.candidate_postprocessor import score_missing_candidates  # noqa: E402
from ai_engine.radar.enrichment_worker import (  # noqa: E402
    enrich_arxiv_candidate,
    enrich_github_candidate,
    enrich_web_candidate,
)


DIGEST_IDS = (
    "7de5e3ce-f9f1-4a12-b75c-d9aa0112c396",
    "bc2572c2-cd57-49d4-83c3-842ad9f8929b",
)
RSS_IDS = (
    "951827df-dc79-4a6d-a526-6f50bd383aed",
    "04990ae1-30cf-4767-be7b-0f7e0adb33dd",
)
HARVEY_ID = "fbef19fc-6735-475a-a79c-c9610bc23040"

EnrichFn = Callable[..., Awaitable[dict[str, Any] | None]]


async def _fetch_rows(
    pool: Any,
    where: str,
    params: tuple[Any, ...],
) -> list[dict[str, Any]]:
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'SELECT "id", "title", "url", "canonicalUrl", "body", '
                '"originalMarkdown", "originalKind", "originalMeta", "tags", '
                '"distilledTotal", "distilledTier" FROM "summaries" WHERE '
                + where
                + ' ORDER BY "createdAt" ASC',
                params,
            )
        ).fetchall()
    return [dict(row) for row in rows]


async def _clear_scores(pool: Any, rows: list[dict[str, Any]]) -> None:
    ids = tuple(str(row["id"]) for row in rows)
    if not ids:
        return
    placeholders = ",".join(["%s"] * len(ids))
    async with pool.connection() as conn:
        await conn.execute(
            'UPDATE "summaries" SET '
            '"distilledScore" = NULL, "distilledTotal" = NULL, '
            '"distilledTier" = NULL, "distilledMustRead" = false, '
            '"distilledProfile" = NULL, "scoreReason" = NULL, '
            '"tags" = CASE WHEN \'content_pending\' = ANY('
            'COALESCE("tags", ARRAY[]::text[])) THEN "tags" '
            'ELSE array_append(COALESCE("tags", ARRAY[]::text[]), '
            '\'content_pending\') END, '
            '"updatedAt" = now() WHERE "id" IN ('
            + placeholders
            + ')',
            ids,
        )
        await conn.commit()


async def _repair_digests(pool: Any, rows: list[dict[str, Any]]) -> int:
    repaired = 0
    async with pool.connection() as conn:
        for row in rows:
            markdown = str(row.get("body") or "").strip()
            if not markdown:
                continue
            markdown_bytes = markdown.encode("utf-8")
            await conn.execute(
                'UPDATE "summaries" SET '
                '"originalMarkdown" = %s, '
                '"originalSha256" = %s, '
                '"originalBytes" = %s, '
                '"originalFetchedAt" = now(), '
                '"originalMeta" = CASE WHEN "originalMeta" IS NULL THEN NULL '
                'ELSE "originalMeta" - \'zread\' END, '
                '"updatedAt" = now() WHERE "id" = %s',
                (
                    markdown,
                    hashlib.sha256(markdown_bytes).hexdigest(),
                    len(markdown_bytes),
                    str(row["id"]),
                ),
            )
            repaired += 1
        await conn.commit()
    return repaired


async def _run_enrichment(
    pool: Any,
    rows: list[dict[str, Any]],
    *,
    concurrency: int,
    item_timeout: float,
    fn: EnrichFn,
) -> tuple[int, list[str]]:
    gate = asyncio.Semaphore(concurrency)
    failures: list[str] = []

    async def _one(row: dict[str, Any]) -> bool:
        async with gate:
            title = str(row.get("title") or row["id"])
            try:
                result = await asyncio.wait_for(
                    fn(
                        pool,
                        summary_id=str(row["id"]),
                        canonical_url=str(
                            row.get("canonicalUrl") or row.get("url") or ""
                        ),
                    ),
                    timeout=item_timeout,
                )
                if result is None:
                    failures.append(title)
                    return False
                return True
            except Exception as exc:
                failures.append(f"{title} ({type(exc).__name__})")
                return False

    outcomes = await asyncio.gather(*(_one(row) for row in rows))
    return sum(outcomes), failures


async def _score(pool: Any, rows: list[dict[str, Any]], concurrency: int) -> int:
    ids = tuple(str(row["id"]) for row in rows)
    if not ids:
        return 0
    return await score_missing_candidates(
        pool,
        limit=len(ids),
        summary_ids=ids,
        rescore=True,
        concurrency=concurrency,
    )


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Repair incomplete noise enrichment",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--item-timeout", type=float, default=900)
    args = parser.parse_args()
    concurrency = max(1, min(args.concurrency, 4))
    item_timeout = max(30.0, args.item_timeout)

    cli_enabled = os.environ.get("ZREAD_CLI_ENABLED", "0").strip().lower() in {
        "1", "true", "yes", "on",
    }
    if not cli_enabled:
        raise RuntimeError(
            "ZREAD_CLI_ENABLED must be enabled for remote -> CLI -> README repair"
        )

    store = DbJobStore(dsn=os.environ["DATABASE_URL"])
    await store.open()
    try:
        digest_rows = await _fetch_rows(
            store.pool,
            '"id" IN (%s,%s)',
            DIGEST_IDS,
        )
        rss_rows = await _fetch_rows(
            store.pool,
            '"id" IN (%s,%s)',
            RSS_IDS,
        )
        arxiv_rows = await _fetch_rows(
            store.pool,
            '"source" = \'daily\' AND "syncRunId" IS NOT NULL '
            'AND "status" IN (\'candidate\', \'published\') '
            'AND "distilledTier" = \'noise\' '
            'AND "originalKind" = \'arxiv\' '
            'AND length(COALESCE("originalMarkdown", \'\')) < 1000',
            (),
        )
        repo_rows = await _fetch_rows(
            store.pool,
            '"source" = \'daily\' AND "syncRunId" IS NOT NULL '
            'AND "status" IN (\'candidate\', \'published\') '
            'AND "distilledTier" = \'noise\' '
            'AND "originalKind" = \'github_repo\' '
            'AND NOT (COALESCE("tags", ARRAY[]::text[]) '
            '@> ARRAY[\'repo_digest\']::text[]) '
            'AND (COALESCE("originalMeta"->\'zread\'->>\'provider\', \'\') = \'\' '
            'OR "id" = %s)',
            (HARVEY_ID,),
        )
        repo_rows = list({str(row["id"]): row for row in repo_rows}.values())

        print(
            "targets="
            + str({
                "digest_restore": len(digest_rows),
                "rss_refetch": len(rss_rows),
                "short_arxiv": len(arxiv_rows),
                "github_repo": len(repo_rows),
            }),
            flush=True,
        )
        print(
            "repo_score_buckets="
            + str(Counter(
                "boundary>=30"
                if float(row.get("distilledTotal") or 0) >= 30
                else "below30"
                for row in repo_rows
            )),
            flush=True,
        )
        if args.dry_run:
            return 0

        digest_repaired = await _repair_digests(store.pool, digest_rows)
        print(f"digest_repaired={digest_repaired}", flush=True)

        await _clear_scores(store.pool, rss_rows)

        async def _web(
            pool: Any,
            *,
            summary_id: str,
            canonical_url: str,
        ) -> dict[str, Any] | None:
            return await enrich_web_candidate(
                pool,
                summary_id=summary_id,
                canonical_url=canonical_url,
                force=True,
            )

        rss_ok, rss_failures = await _run_enrichment(
            store.pool,
            rss_rows,
            concurrency=concurrency,
            item_timeout=item_timeout,
            fn=_web,
        )
        rss_scored = await _score(store.pool, rss_rows, concurrency)
        print(
            f"rss_enriched={rss_ok} rss_failed={rss_failures} "
            f"rss_scored={rss_scored}",
            flush=True,
        )

        await _clear_scores(store.pool, arxiv_rows)
        arxiv_ok, arxiv_failures = await _run_enrichment(
            store.pool,
            arxiv_rows,
            concurrency=concurrency,
            item_timeout=item_timeout,
            fn=enrich_arxiv_candidate,
        )
        arxiv_scored = await _score(store.pool, arxiv_rows, concurrency)
        print(
            f"arxiv_enriched={arxiv_ok} arxiv_failed={arxiv_failures} "
            f"arxiv_scored={arxiv_scored}",
            flush=True,
        )

        await _clear_scores(store.pool, repo_rows)
        repo_ok, repo_failures = await _run_enrichment(
            store.pool,
            repo_rows,
            concurrency=concurrency,
            item_timeout=item_timeout,
            fn=enrich_github_candidate,
        )
        repo_scored = await _score(store.pool, repo_rows, concurrency)
        print(
            f"repo_enriched={repo_ok} repo_failed={repo_failures} "
            f"repo_scored={repo_scored}",
            flush=True,
        )

        all_rows = [*digest_rows, *rss_rows, *arxiv_rows, *repo_rows]
        all_ids = tuple(str(row["id"]) for row in all_rows)
        placeholders = ",".join(["%s"] * len(all_ids))
        async with store.pool.connection() as conn:
            result_rows = await (
                await conn.execute(
                    'SELECT COALESCE("distilledTier", \'pending\') AS tier, '
                    '"originalKind", COUNT(*) AS count FROM "summaries" '
                    'WHERE "id" IN ('
                    + placeholders
                    + ') GROUP BY 1,2 ORDER BY 2,1',
                    all_ids,
                )
            ).fetchall()
        print(
            "final="
            + str([
                {
                    "tier": str(dict(row)["tier"]),
                    "kind": str(dict(row)["originalKind"]),
                    "count": int(dict(row)["count"]),
                }
                for row in result_rows
            ]),
            flush=True,
        )
        return 0
    finally:
        await store.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
