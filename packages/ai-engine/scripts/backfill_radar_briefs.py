"""Regenerate missing UI-facing radar briefs from already captured content.

This is intentionally bounded and idempotent:

* it only targets ``daily`` summaries whose interpretation is empty;
* it uses the persisted article body instead of fetching the URL again;
* it updates a row only while the interpretation is still empty;
* provider failures remain visible in the command output and do not mutate
  the summary into a false success.
"""

# ruff: noqa: E402
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from dataclasses import dataclass
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

from ai_engine.adapters.base import build_adapter
from ai_engine.contracts.states import AI_JOB_STATUS
from ai_engine.ingestion.pipeline import _generate_brief
from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar.sync_runner import MIN_BRIEF_OUTPUT_CHARS, _strip_reasoning_markup


@dataclass(frozen=True, slots=True)
class BackfillResult:
    summary_id: str
    state: str
    detail: str = ""


async def _load_rows(
    pool: Any,
    *,
    limit: int,
    summary_ids: tuple[str, ...],
) -> list[dict[str, Any]]:
    predicates = [
        '"source" = \'daily\'',
        '"status" <> \'archived\'',
        '(btrim(COALESCE("interpretation", \'\')) = \'\')',
        '(COALESCE("originalMarkdown", \'\') <> \'\' OR COALESCE("body", \'\') <> \'\')',
    ]
    params: list[Any] = []
    if summary_ids:
        predicates.append('"id" = ANY(%s)')
        params.append(list(summary_ids))
    params.append(max(1, limit))
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'SELECT "id", "title", "url", "canonicalUrl", "body", '
                '"originalMarkdown" FROM "summaries" WHERE '
                + " AND ".join(predicates)
                + ' ORDER BY "createdAt" DESC LIMIT %s',
                tuple(params),
            )
        ).fetchall()
    return [dict(row) for row in rows]


async def _backfill_one(
    pool: Any,
    adapter: Any,
    row: dict[str, Any],
    *,
    timeout_seconds: float,
) -> BackfillResult:
    summary_id = str(row["id"])
    context = str(row.get("originalMarkdown") or row.get("body") or "").strip()
    if len(context) < 80:
        return BackfillResult(summary_id, "skipped", "source context too short")

    url = str(row.get("canonicalUrl") or row.get("url") or "").strip()
    if not url:
        return BackfillResult(summary_id, "skipped", "missing source URL")

    try:
        status = await _generate_brief(
            adapter,
            {
                "title": str(row.get("title") or "Untitled")[:200],
                "snippet": context[:2000],
            },
            url,
            timeout_seconds=timeout_seconds,
            context_max_chars=2000,
        )
    except Exception as exc:  # noqa: BLE001 - one row must not stop the batch
        return BackfillResult(summary_id, "failed", type(exc).__name__)

    if status.status != AI_JOB_STATUS["SUCCEEDED"] or not status.output_text:
        code = str(getattr(status, "error_code", None) or status.status)
        return BackfillResult(summary_id, "failed", code)

    interpretation = _strip_reasoning_markup(status.output_text)[:2000]
    if len(interpretation) < MIN_BRIEF_OUTPUT_CHARS:
        return BackfillResult(summary_id, "skipped", "brief output too short")

    async with pool.connection() as conn:
        cursor = await conn.execute(
            'UPDATE "summaries" SET "interpretation" = %s, "updatedAt" = now() '
            'WHERE "id" = %s AND btrim(COALESCE("interpretation", \'\')) = \'\' '
            'RETURNING "id"',
            (interpretation, summary_id),
        )
        await conn.commit()
    return BackfillResult(
        summary_id,
        "updated" if await cursor.fetchone() else "skipped",
        "interpretation persisted",
    )


async def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill missing radar interpretations")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--timeout", type=float, default=90.0)
    parser.add_argument("--summary-id", action="append", default=[])
    args = parser.parse_args()

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL is required")

    store = DbJobStore(dsn=dsn)
    await store.open()
    try:
        rows = await _load_rows(
            store.pool,
            limit=args.limit,
            summary_ids=tuple(args.summary_id),
        )
        adapter = build_adapter()
        gate = asyncio.Semaphore(max(1, args.concurrency))

        async def run(row: dict[str, Any]) -> BackfillResult:
            async with gate:
                return await _backfill_one(
                    store.pool,
                    adapter,
                    row,
                    timeout_seconds=max(1.0, args.timeout),
                )

        results = await asyncio.gather(*(run(row) for row in rows))
        counts = {state: sum(result.state == state for result in results) for state in (
            "updated",
            "skipped",
            "failed",
        )}
        print(
            f"inspected={len(rows)} updated={counts['updated']} "
            f"skipped={counts['skipped']} failed={counts['failed']}",
            flush=True,
        )
        for result in results:
            if result.state != "updated":
                print(
                    f"{result.state} id={result.summary_id} detail={result.detail}",
                    flush=True,
                )
    finally:
        await store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
