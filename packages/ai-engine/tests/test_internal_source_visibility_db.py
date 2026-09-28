from __future__ import annotations

import os
import uuid
from typing import Any, cast

import pytest

from ai_engine.contracts.errors import AdapterError
from ai_engine.job_runner.db_store import AI_TABLE, DbJobStore

pytestmark = pytest.mark.requires_db


def _test_dsn() -> str:
    return os.environ.get(
        "TEST_DATABASE_URL",
        "postgresql://postgres:postgres@localhost:5432/deep_research_test",
    )


async def test_internal_summary_refs_enforce_member_and_admin_visibility() -> None:
    store = DbJobStore(dsn=_test_dsn(), table_name=AI_TABLE)
    await store.open()
    member_id = str(uuid.uuid4())
    admin_id = str(uuid.uuid4())
    visible_id = str(uuid.uuid4())
    hidden_id = str(uuid.uuid4())
    admin_only_id = str(uuid.uuid4())
    visible_share_id = str(uuid.uuid4())
    admin_share_id = str(uuid.uuid4())

    try:
        async with store.pool.connection() as conn:
            await conn.execute(
                'INSERT INTO "users" ("id", "email", "name", "role", "createdAt", "updatedAt") '
                "VALUES (%s, %s, 'Source visibility member', 'member', now(), now())",
                (member_id, f"source-visibility-{member_id}@test.local"),
            )
            await conn.execute(
                'INSERT INTO "users" ("id", "email", "name", "role", "createdAt", "updatedAt") '
                "VALUES (%s, %s, 'Source visibility admin', 'admin', now(), now())",
                (admin_id, f"source-visibility-{admin_id}@test.local"),
            )

            await conn.execute(
                'INSERT INTO "summaries" '
                '("id", "title", "body", "url", "canonicalUrl", "source", "summaryDate", '
                '"status", "tags", "distilledTier", "createdAt", "updatedAt") '
                "VALUES "
                "(%s, 'Approved shared source', 'Current approved text', %s, %s, 'user', CURRENT_DATE, "
                "'published', ARRAY[]::text[], 'skim', now(), now()), "
                "(%s, 'Hidden daily source', 'Must not be resolved', %s, %s, 'daily', CURRENT_DATE, "
                "'candidate', ARRAY[]::text[], 'skim', now(), now()), "
                "(%s, 'Admin governance source', 'Admin-only text', %s, %s, 'user', CURRENT_DATE, "
                "'archived', ARRAY[]::text[], 'noise', now(), now())",
                (
                    visible_id,
                    f"https://example.invalid/{visible_id}",
                    f"https://example.invalid/{visible_id}",
                    hidden_id,
                    f"https://example.invalid/{hidden_id}",
                    f"https://example.invalid/{hidden_id}",
                    admin_only_id,
                    f"https://example.invalid/{admin_only_id}",
                    f"https://example.invalid/{admin_only_id}",
                ),
            )
            await conn.execute(
                'INSERT INTO "share_submissions" '
                '("id", "submitterId", "url", "canonicalUrl", "status", "reviewerId", "reviewedAt", '
                '"publishedSummaryId", "updatedAt") '
                "VALUES (%s, %s, %s, %s, 'approved', %s, now(), %s, now()), "
                "(%s, %s, %s, %s, 'approved', %s, now(), %s, now())",
                (
                    visible_share_id,
                    member_id,
                    f"https://example.invalid/{visible_id}",
                    f"https://example.invalid/{visible_id}",
                    admin_id,
                    visible_id,
                    admin_share_id,
                    member_id,
                    f"https://example.invalid/{admin_only_id}",
                    f"https://example.invalid/{admin_only_id}",
                    admin_id,
                    admin_only_id,
                ),
            )
            await conn.commit()

        visible = await store.resolve_internal_source_refs(
            [{"type": "summary", "value": visible_id, "required": True}],
            requester_id=member_id,
        )
        assert visible[0]["resolvedSnippet"] == "Current approved text"

        for summary_id in (hidden_id, admin_only_id):
            with pytest.raises(AdapterError) as caught:
                await store.resolve_internal_source_refs(
                    [{"type": "summary", "value": summary_id, "required": True}],
                    requester_id=member_id,
                )
            assert caught.value.code == "AI_SOURCE_NOT_VISIBLE"

        admin_result = await store.resolve_internal_source_refs(
            [{"type": "summary", "value": admin_only_id, "required": True}],
            requester_id=admin_id,
        )
        assert cast(dict[str, Any], admin_result[0])["resolvedSnippet"] == "Admin-only text"
    finally:
        async with store.pool.connection() as conn:
            await conn.execute(
                'DELETE FROM "share_submissions" WHERE "id" IN (%s, %s)',
                (visible_share_id, admin_share_id),
            )
            await conn.execute(
                'DELETE FROM "summaries" WHERE "id" IN (%s, %s, %s)',
                (visible_id, hidden_id, admin_only_id),
            )
            await conn.execute(
                'DELETE FROM "users" WHERE "id" IN (%s, %s)',
                (member_id, admin_id),
            )
            await conn.commit()
        await store.close()
