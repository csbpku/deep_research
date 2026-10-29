"""Exercise the backfill against PostgreSQL without touching persistent data."""

import os
import uuid

import psycopg
import pytest

from scripts.backfill_original_kind import apply_updates


@pytest.mark.requires_db
@pytest.mark.asyncio
async def test_backfill_updates_multiple_rows_and_preserves_concurrent_values() -> None:
    dsn = os.environ.get(
        "TEST_DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/deep_research_test"
    )
    first, second, already_set = (uuid.uuid4() for _ in range(3))
    async with await psycopg.AsyncConnection.connect(dsn) as conn:
        await conn.execute(
            'CREATE TEMP TABLE "summaries" ("id" uuid PRIMARY KEY, '
            '"originalKind" varchar(24), "updatedAt" timestamptz)'
        )
        await conn.execute(
            'INSERT INTO "summaries" ("id", "originalKind") VALUES (%s, NULL), '
            '(%s, NULL), (%s, %s)',
            (first, second, already_set, "web_share"),
        )
        count = await apply_updates(
            conn, [("github_repo", first), ("arxiv", second), ("rss", already_set)]
        )
        rows = await (await conn.execute('SELECT "id", "originalKind" FROM "summaries"')).fetchall()

    assert count == 2
    assert dict(rows) == {first: "github_repo", second: "arxiv", already_set: "web_share"}
