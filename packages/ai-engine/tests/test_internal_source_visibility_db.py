from __future__ import annotations

import os
import json
import uuid
from pathlib import Path
from typing import Any, cast

import pytest

from ai_engine.contracts.errors import AdapterError
from ai_engine.job_runner.db_store import AI_TABLE, DbJobStore
from psycopg.types.json import Jsonb

pytestmark = pytest.mark.requires_db


def _test_dsn() -> str:
    return os.environ.get(
        "TEST_DATABASE_URL",
        "postgresql://postgres:postgres@localhost:5432/deep_research_test",
    )


@pytest.mark.parametrize("content_review_status", [None, "needs_manual_review"])
async def test_bookmarking_summary_only_radar_does_not_authorize_cached_source(
    content_review_status: str | None,
) -> None:
    store = DbJobStore(dsn=_test_dsn(), table_name=AI_TABLE)
    await store.open()
    member_id, source_id, run_id, summary_id, bookmark_id = (str(uuid.uuid4()) for _ in range(5))
    fixtures = json.loads((Path(__file__).parents[2] / "shared/fixtures/radar-public-scores.json").read_text())
    score = fixtures[0]["row"]["distilledScore"]
    source_url = f"https://example.invalid/{summary_id}"
    try:
        async with store.pool.connection() as conn:
            await conn.execute(
                'INSERT INTO users (id,email,name,role,"updatedAt") VALUES (%s,%s,\'Bookmark source test\',\'member\',now())',
                (member_id, f"bookmark-source-{member_id}@test.local"),
            )
            await conn.execute(
                'INSERT INTO radar_sources (id,name,"sourceType",config,"updatedAt") VALUES (%s,%s,\'rss\',\'{}\'::jsonb,now())',
                (source_id, f"bookmark-source-{source_id}"),
            )
            await conn.execute(
                'INSERT INTO radar_sync_runs (id,"sourceId","triggeredBy") VALUES (%s,%s,\'admin\')',
                (run_id, source_id),
            )
            await conn.execute(
                'INSERT INTO summaries (id,title,body,url,"canonicalUrl",source,"summaryDate",status,tags,'
                '"syncRunId","distilledTier","distilledScore","enrichmentStatus","readerQualityStatus",'
                '"contentReviewStatus","renderReviewStatus","originalKind","originalMeta","updatedAt") '
                'VALUES (%s,\'Summary-only bookmark\',\'PRIVATE-CACHED-TEXT\',%s,%s,\'daily\',CURRENT_DATE,'
                '\'candidate\',ARRAY[]::text[],%s,\'deep_read\',%s,\'ready\',\'ready\',%s,\'approved\','
                '\'rss\',\'{"enrichmentVersion":"2.0"}\'::jsonb,now())',
                (summary_id, source_url, source_url, run_id, Jsonb(score), content_review_status),
            )
            await conn.execute(
                'INSERT INTO user_bookmarks (id,"userId","targetType","targetId") VALUES (%s,%s,\'radar_candidate\',%s)',
                (bookmark_id, member_id, summary_id),
            )
            await conn.commit()

        async with store.pool.connection() as conn:
            actual = await (await conn.execute('SELECT "contentReviewStatus",tags,"distilledTier" FROM summaries WHERE id=%s', (summary_id,))).fetchone()
        assert actual == {"contentReviewStatus": content_review_status, "tags": ["tier_deep_read"], "distilledTier": "deep_read"}
        with pytest.raises(AdapterError) as caught:
            await store.resolve_internal_source_refs(
                [{"type": "summary", "value": summary_id, "required": True}], requester_id=member_id,
            )
        assert caught.value.code == "AI_SOURCE_NOT_VISIBLE"
        optional = {"type": "summary", "value": summary_id, "required": False}
        assert await store.resolve_internal_source_refs([optional], requester_id=member_id) == (optional,)
        async with store.pool.connection() as conn:
            row = await (await conn.execute(
                'SELECT count(*) AS count FROM personal_knowledge_index_tasks WHERE "ownerId"=%s', (member_id,),
            )).fetchone()
        assert row is not None and row["count"] == 0
    finally:
        async with store.pool.connection() as conn:
            await conn.execute('DELETE FROM user_bookmarks WHERE id=%s', (bookmark_id,))
            await conn.execute('DELETE FROM summaries WHERE id=%s', (summary_id,))
            await conn.execute('DELETE FROM radar_sync_runs WHERE id=%s', (run_id,))
            await conn.execute('DELETE FROM radar_sources WHERE id=%s', (source_id,))
            await conn.execute('DELETE FROM users WHERE id=%s', (member_id,))
            await conn.commit()
        await store.close()


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
