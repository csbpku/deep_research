"""Optional transaction tests against an explicitly selected loopback test DB."""
from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone
from urllib.parse import urlparse
from uuid import uuid4

import pytest
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from ai_engine.radar.diagnostic_policy import lock_excerpt_publication, publication_identity, record_noise_disposition
from ai_engine.radar.models import RadarCandidate, RadarSource
from ai_engine.radar.sync_runner import _record_sync_diagnostic

pytestmark = pytest.mark.requires_db


@pytest.fixture
async def db():  # type: ignore[no-untyped-def]
    dsn = os.environ.get("TEST_RADAR_EVIDENCE_DATABASE_URL", "")
    if not dsn:
        pytest.skip("set TEST_RADAR_EVIDENCE_DATABASE_URL to run isolated PostgreSQL tests")
    parsed = urlparse(dsn)
    if parsed.scheme not in {"postgres", "postgresql"} or parsed.hostname not in {"localhost", "127.0.0.1", "::1"} or not parsed.path.endswith("_test"):
        pytest.fail("TEST_RADAR_EVIDENCE_DATABASE_URL must point to a loopback *_test database")
    pool = AsyncConnectionPool(dsn, min_size=1, max_size=5, open=False, kwargs={"row_factory": dict_row})
    await pool.open(wait=True)
    sid, rid = str(uuid4()), str(uuid4())
    async with pool.connection() as conn:
        await conn.execute('INSERT INTO radar_sources (id,name,"sourceType",config,"updatedAt") VALUES (%s,%s,\'rss\',\'{}\',now())', (sid, 'feed evidence test'))
        await conn.execute('INSERT INTO radar_sync_runs (id,"sourceId","triggeredBy") VALUES (%s,%s,\'test\')', (rid, sid))
        await conn.commit()
    try:
        yield pool, RadarSource(sid, "test", "rss", {"vendor": "anthropic"}), rid
    finally:
        async with pool.connection() as conn:
            await conn.execute('DELETE FROM summaries WHERE "syncRunId" IN (SELECT id FROM radar_sync_runs WHERE "sourceId"=%s)', (sid,))
            await conn.execute('DELETE FROM radar_sync_diagnostics WHERE "sourceId"=%s', (sid,))
            await conn.execute('DELETE FROM radar_sync_runs WHERE "sourceId"=%s', (sid,))
            await conn.execute('DELETE FROM radar_sources WHERE id=%s', (sid,))
            await conn.commit()
        await pool.close()


async def _pending(pool, source, rid, candidate, reason="SOURCE_EXCERPT_NOISE_PENDING"):  # type: ignore[no-untyped-def]
    await _record_sync_diagnostic(pool, source=source, run_id=rid, candidate=candidate,
        canonical_url=candidate.url, kind="filtered", reason_code=reason,
        markdown=candidate.feed_excerpt, feed_excerpt_fallback=True)


async def _statuses(pool, source):  # type: ignore[no-untyped-def]
    async with pool.connection() as conn:
        rows = await (await conn.execute('SELECT status, "reasonCode", "distilledScore", body, "originalMarkdown" FROM radar_sync_diagnostics WHERE "sourceId"=%s', (source.id,))).fetchall()
    return rows


async def test_noise_resolution_is_scoped_to_publication(db):  # type: ignore[no-untyped-def]
    pool, source, rid = db
    dt = datetime(2026, 1, 1, tzinfo=timezone.utc)
    a = RadarCandidate('Title A', 'https://example.com/reused', published_at=dt, feed_excerpt='private feed text')
    b = RadarCandidate('Title B', a.url, published_at=dt, feed_excerpt='other private feed text')
    for candidate in (a, b):
        for reason in ('SOURCE_FEED_EXCERPT', 'SOURCE_EXCERPT_NOISE_PENDING'):
            await _pending(pool, source, rid, candidate, reason)
    await record_noise_disposition(pool, source.id, rid, a, a.url)
    rows = await _statuses(pool, source)
    for row in rows:
        if row['reasonCode'] != 'NOISE_NOT_STORED':
            assert row['status'] == ('dismissed' if row['distilledScore']['publicationIdentity'] == publication_identity(a.title, a.published_at) else 'pending')
            assert not row['body'] and row['originalMarkdown'] is None
    await _pending(pool, source, rid, a)
    assert len(await _statuses(pool, source)) == 5


async def test_final_summary_prevents_delayed_excerpt_reopening(db):  # type: ignore[no-untyped-def]
    pool, source, rid = db
    dt = datetime(2026, 1, 1, tzinfo=timezone.utc)
    item = RadarCandidate('Research &amp; Engineering \\ Anthropic', 'https://example.com/article', published_at=dt, feed_excerpt='private feed text')
    await _pending(pool, source, rid, item)
    async with pool.connection() as conn:
        await lock_excerpt_publication(conn, source.id, item.url, item.title, item.published_at)
        delayed = asyncio.create_task(_pending(pool, source, rid, item))
        await asyncio.sleep(.05)
        assert not delayed.done()
        await conn.execute('INSERT INTO summaries (id,title,body,url,"canonicalUrl",source,"summaryDate","publishedAt","syncRunId","updatedAt",tags) VALUES (%s,%s,\'brief\',%s,%s,\'daily\',current_date,%s,%s,now(),%s)', (str(uuid4()), 'Research & Engineering', item.url, item.url, dt, rid, []))
        from ai_engine.radar.diagnostic_policy import close_excerpt_pending
        await close_excerpt_pending(conn, source.id, item.url, item.title, item.published_at, 'SOURCE_EXCERPT_NOISE_PENDING')
        await conn.commit()
    await asyncio.wait_for(delayed, timeout=3)
    rows = await _statuses(pool, source)
    assert len(rows) == 1 and rows[0]['status'] == 'dismissed'


async def test_excerpt_summary_is_not_a_final_original(db):  # type: ignore[no-untyped-def]
    pool, source, rid = db
    item = RadarCandidate('Title', 'https://example.com/excerpt', feed_excerpt='private feed text')
    async with pool.connection() as conn:
        await conn.execute('INSERT INTO summaries (id,title,body,url,"canonicalUrl",source,"summaryDate","syncRunId","updatedAt",tags) VALUES (%s,%s,\'brief\',%s,%s,\'daily\',current_date,%s,now(),%s)', (str(uuid4()), item.title, item.url, item.url, rid, ['evidence_feed_excerpt']))
        await conn.commit()
    await _pending(pool, source, rid, item)
    rows = await _statuses(pool, source)
    assert len(rows) == 1 and rows[0]['status'] == 'pending'


async def test_same_run_duplicate_excerpt_is_scored_once(db, monkeypatch):  # type: ignore[no-untyped-def]
    from ai_engine.adapters.fake import FakeAdapter
    from ai_engine.contracts.states import AI_JOB_STATUS
    from ai_engine.fetcher.safe_fetch import SafeFetchError
    from ai_engine.radar.distilled_scorer import compute_score
    from ai_engine.radar.sync_runner import run_radar_sync

    pool, source, _ = db
    monkeypatch.setenv('RADAR_READING_MODE', 'browser')
    monkeypatch.setattr('ai_engine.radar.sync_runner.RADAR_FETCH_RETRIES', 0)
    async with pool.connection() as conn:
        await conn.execute('UPDATE radar_sources SET config=%s::jsonb WHERE id=%s', ('{"feedUrl":"https://example.com/feed"}', source.id))
        await conn.commit()
    item = RadarCandidate('LLM agent implementation', 'https://example.com/duplicate',
        snippet='An engineering article about agents and retrieval.', content_origin='rss',
        feed_excerpt='The engineering article describes an agent implementation and measurements. ' * 30,
        feed_source_host='example.com')
    calls = []

    async def fetcher(config):  # type: ignore[no-untyped-def]
        return [item, item]

    async def timeout(url, **kwargs):  # type: ignore[no-untyped-def]
        raise SafeFetchError('URL_FETCH_TIMEOUT', 'timeout', host='example.com')

    async def brief(*args, **kwargs):  # type: ignore[no-untyped-def]
        return type('Brief', (), {'status': AI_JOB_STATUS['SUCCEEDED'],
            'output_text': 'A concise review of the engineering implementation and measurements. ' * 3,
            'cost': type('Cost', (), {'token_input_total': 1, 'token_output_total': 1, 'cost_cents': 0})()})()

    async def scorer(*args, **kwargs):  # type: ignore[no-untyped-def]
        calls.append(1)
        await asyncio.sleep(.05)
        return compute_score(dict.fromkeys(('信息增量', '分析深度', '可行动性', '事实可信度', '时效性', '表达质量', '综合信号'), 1), source_type='rss')

    result = await run_radar_sync(pool, triggered_by='admin', source_ids={source.id}, adapter=FakeAdapter(),
        fetchers={'rss': fetcher}, document_fetcher=timeout, generate_brief=brief, distilled_scorer=scorer,
        candidate_concurrency=2)
    assert result.runs[0].total_failed == 0
    assert len(calls) == 1
    rows = await _statuses(pool, source)
    assert sum(row['reasonCode'] == 'SOURCE_EXCERPT_NOISE_PENDING' and row['status'] == 'pending' for row in rows) == 1
