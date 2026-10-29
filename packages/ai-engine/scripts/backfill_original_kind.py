"""Backfill ``summaries.originalKind`` from the source URL.

Rows ingested while the platform ran in external reading mode never received
a content kind, so the platform could not tell a repository from a web page
and hid repository-only entry points.  The kind is derivable from the URL,
so this repair writes it back without touching scores or enrichment state.

Rows whose URL does not identify a shape are left untouched.
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

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar.content_kind import kind_from_url
from psycopg import AsyncConnection


async def apply_updates(conn: AsyncConnection, updates: list[tuple[str, uuid.UUID]]) -> int:
    """Only fill rows that are still missing a kind when the update runs."""
    async with conn.cursor() as cursor:
        await cursor.executemany(
            'UPDATE "summaries" SET "originalKind" = %s, "updatedAt" = now() '
            'WHERE "id" = %s AND "originalKind" IS NULL',
            updates,
        )
        return cursor.rowcount


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Backfill summaries.originalKind from the source URL",
    )
    parser.add_argument("--limit", type=int, default=5000)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    store = DbJobStore(dsn=os.environ["DATABASE_URL"])
    await store.open()
    try:
        async with store.pool.connection() as conn:
            rows = await (
                await conn.execute(
                    'SELECT "id", "url", "title" FROM "summaries" '
                    'WHERE "originalKind" IS NULL AND "url" IS NOT NULL '
                    'ORDER BY "createdAt" DESC LIMIT %s',
                    (max(1, args.limit),),
                )
            ).fetchall()

            updates: list[tuple[str, uuid.UUID]] = []
            for raw in rows:
                row = dict(raw)
                kind = kind_from_url(str(row["url"] or ""))
                if kind:
                    updates.append((kind, uuid.UUID(str(row["id"]))))

            by_kind: dict[str, int] = {}
            for kind, _summary_id in updates:
                by_kind[kind] = by_kind.get(kind, 0) + 1

            print(f"scanned={len(rows)} derivable={len(updates)}")
            for kind, count in sorted(by_kind.items(), key=lambda item: -item[1]):
                print(f"  {kind}: {count}")

            if args.dry_run or not updates:
                return 0

            async with conn.transaction():
                updated = await apply_updates(conn, updates)
            print(f"updated={updated}")
            return 0
    finally:
        await store.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
