"""Backfill publish-gate summary fields on existing AI research drafts.

New drafts are pre-filled when they are created (see
``server.app._factory``).  Drafts created before that change still have an
empty 背景 / 结论 / 风险, so their publish button stays disabled even though
the report body already contains those sections.

This script reads each draft body, derives the three fields with the same
helper the creation path uses, and writes only the fields that are still
empty.  Author-written text is never overwritten.

Safety:
- dry-run by default; pass ``--apply`` to write;
- only ``status='draft' AND creationMethod='ai_research'`` rows;
- the UPDATE re-checks emptiness, so a concurrent edit wins;
- one row can be targeted with ``--id``.

Usage::

    python scripts/backfill_research_summary.py            # dry run
    python scripts/backfill_research_summary.py --apply    # write
    python scripts/backfill_research_summary.py --id <uuid> --apply
"""

# ruff: noqa: E402
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

from psycopg import AsyncConnection

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.research_summary import missing_summary_updates

_UPDATE_SQL = """
UPDATE "researches" SET
  "background" = COALESCE(NULLIF(btrim("background"), ''), %s),
  "conclusion" = COALESCE(NULLIF(btrim("conclusion"), ''), %s),
  "risks" = COALESCE(NULLIF(btrim("risks"), ''), %s),
  "updatedAt" = now()
WHERE "id" = %s
  AND "status" = 'draft'
  AND "creationMethod" = 'ai_research'
"""


async def _load_rows(
    conn: AsyncConnection,
    *,
    limit: int,
    research_id: uuid.UUID | None,
) -> list[dict[str, object]]:
    params: list[object] = []
    where = [
        "\"status\" = 'draft'",
        "\"creationMethod\" = 'ai_research'",
        """("background" IS NULL OR btrim("background") = ''
            OR "conclusion" IS NULL OR btrim("conclusion") = ''
            OR "risks" IS NULL OR btrim("risks") = '')""",
    ]
    if research_id is not None:
        where.append('"id" = %s')
        params.append(research_id)
    params.append(max(1, limit))
    query = (
        'SELECT "id", "title", "background", "conclusion", "risks", "body" '
        'FROM "researches" WHERE ' + " AND ".join(where) + ' '
        'ORDER BY "createdAt" DESC LIMIT %s'
    )
    result = await conn.execute(query, tuple(params))
    return [dict(row) for row in await result.fetchall()]


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Backfill AI draft summary fields from the report body",
    )
    parser.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--id", type=str, default=None, help="only this research id")
    args = parser.parse_args()

    research_id = uuid.UUID(args.id) if args.id else None
    store = DbJobStore(dsn=os.environ["DATABASE_URL"])
    await store.open()
    try:
        async with store.pool.connection() as conn:
            rows = await _load_rows(conn, limit=args.limit, research_id=research_id)

            planned: list[tuple[dict[str, object], dict[str, str]]] = []
            for row in rows:
                body = str(row.get("body") or "")
                updates = missing_summary_updates(
                    {
                        "background": str(row.get("background") or ""),
                        "conclusion": str(row.get("conclusion") or ""),
                        "risks": str(row.get("risks") or ""),
                    },
                    body,
                )
                if updates:
                    planned.append((row, updates))

            filled = {"background": 0, "conclusion": 0, "risks": 0}
            complete = 0
            for row, updates in planned:
                for field in updates:
                    filled[field] += 1
                merged = {
                    field: updates.get(field) or str(row.get(field) or "").strip()
                    for field in ("background", "conclusion", "risks")
                }
                if all(merged.values()):
                    complete += 1

            print(
                f"scanned={len(rows)} fillable={len(planned)} complete_after={complete} "
                f"background={filled['background']} "
                f"conclusion={filled['conclusion']} risks={filled['risks']}"
            )
            for row, updates in planned[:5]:
                print(
                    f"  {row['id']}  {str(row['title'])[:60]}  "
                    f"fields={','.join(sorted(updates))}"
                )

            if not args.apply or not planned:
                if planned and not args.apply:
                    print("dry run: pass --apply to write")
                return 0

            written = 0
            async with conn.transaction():
                for row, updates in planned:
                    await conn.execute(
                        _UPDATE_SQL,
                        (
                            updates.get("background"),
                            updates.get("conclusion"),
                            updates.get("risks"),
                            uuid.UUID(str(row["id"])),
                        ),
                    )
                    written += 1
            print(f"updated={written}")
            return 0
    finally:
        await store.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
