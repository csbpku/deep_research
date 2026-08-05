"""Fill UI-facing enrichment fields that best-effort workers left empty."""

# ruff: noqa: E402
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar.enrichment_worker import (
    _generate_arxiv_analysis,
    _generate_web_highlights,
)


async def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill incomplete radar enrichment fields")
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--concurrency", type=int, default=2)
    args = parser.parse_args()

    store = DbJobStore(dsn=os.environ["DATABASE_URL"])
    await store.open()
    try:
        async with store.pool.connection() as conn:
            rows = await (
                await conn.execute(
                    'SELECT "id", "title", "originalKind", "originalMarkdown", '
                    '"interpretation", "tldr" FROM "summaries" '
                    'WHERE "originalMeta" IS NOT NULL AND ('
                    '("originalKind" = \'github_repo\' AND "repoSummary" IS NULL) OR '
                    '("originalKind" = \'arxiv\' AND "arxivAnalysis" IS NULL) OR '
                    '("originalKind" IN (\'rss\', \'web_share\') AND '
                    '("highlights" IS NULL OR "highlights" = \'{}\'::jsonb))) '
                    'ORDER BY "createdAt" DESC LIMIT %s',
                    (max(1, args.limit),),
                )
            ).fetchall()

        gate = asyncio.Semaphore(max(1, args.concurrency))

        async def process(raw: Any) -> tuple[str, str, dict[str, Any] | str] | None:
            row = dict(raw)
            summary_id = str(row["id"])
            kind = str(row["originalKind"])
            title = str(row.get("title") or "")
            markdown = str(row.get("originalMarkdown") or "").strip()
            interpretation = str(row.get("tldr") or row.get("interpretation") or "").strip()

            if kind == "github_repo":
                summary = interpretation or markdown[:2000].strip()
                return (summary_id, "repoSummary", summary) if summary else None

            if kind == "arxiv":
                if not markdown:
                    return None
                async with gate:
                    analysis = await _generate_arxiv_analysis(markdown, title)
                return (summary_id, "arxivAnalysis", analysis) if analysis else None

            if not markdown and not interpretation:
                return None
            highlights = None
            if markdown:
                async with gate:
                    highlights = await _generate_web_highlights(markdown, title)
            if highlights is None and interpretation:
                highlights = {
                    "summary": interpretation[:500],
                    "highlights": [],
                    "key_quote": None,
                    "degraded": True,
                    "reason": "insufficient_source_content",
                }
            return (summary_id, "highlights", highlights) if highlights else None

        results = await asyncio.gather(*(process(row) for row in rows))
        counts = {"repoSummary": 0, "arxivAnalysis": 0, "highlights": 0}
        async with store.pool.connection() as conn:
            for result in results:
                if result is None:
                    continue
                summary_id, field, value = result
                if field == "repoSummary":
                    await conn.execute(
                        'UPDATE "summaries" SET "repoSummary" = %s, '
                        '"updatedAt" = now() WHERE "id" = %s AND "repoSummary" IS NULL',
                        (str(value)[:4000], summary_id),
                    )
                else:
                    missing_predicate = (
                        f'("{field}" IS NULL OR "{field}" = \'{{}}\'::jsonb)'
                        if field == "highlights"
                        else f'"{field}" IS NULL'
                    )
                    await conn.execute(
                        f'UPDATE "summaries" SET "{field}" = %s::jsonb, '
                        f'"updatedAt" = now() WHERE "id" = %s AND {missing_predicate}',
                        (json.dumps(value, ensure_ascii=False), summary_id),
                    )
                counts[field] += 1

        print(f"Candidates inspected: {len(rows)}")
        for field, count in counts.items():
            print(f"  {field:<16} {count}")
    finally:
        await store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
