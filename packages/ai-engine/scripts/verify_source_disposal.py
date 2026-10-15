"""Verify disposal, rollback, protection and restore in an isolated restored DB."""
from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar import governance as g, repair as r
from ai_engine.radar.diagnostic_policy import deleted_publication
from ai_engine.radar.source_disposal import SOURCE_DISPOSAL_ACTION, SOURCE_DISPOSAL_POLICY
from scripts.purge_scored_noise import apply


async def main() -> None:
    database = os.environ['GOVERNANCE_VERIFY_DATABASE']
    if not database.startswith('governance_verify_'):
        raise RuntimeError('verification must never run on production')
    dsn = urlunsplit(urlsplit(os.environ['DATABASE_URL'])._replace(path='/'+database))
    directory = Path(os.environ['GOVERNANCE_VERIFY_DIR'])
    directory.mkdir(parents=True, exist_ok=False)
    store = DbJobStore(dsn=dsn)
    await store.open()
    try:
        async with store.pool.connection() as conn:
            actor = await g.verify_admin(conn, os.environ['GOVERNANCE_ACTOR'])
            rows = [dict(x) for x in await (await conn.execute(
                'SELECT s.*,rr."sourceId",md5(to_jsonb(s)::text) AS fingerprint FROM summaries s '
                'LEFT JOIN radar_sync_runs rr ON rr.id=s."syncRunId" '
                "WHERE s.source='daily' AND s.\"distilledScore\" IS NULL ORDER BY s.id")).fetchall()]
            protected = await g.protected_ids(conn, rows)
        row = next(x for x in rows if str(x['id']) not in protected and not x.get('userNote') and not x.get('sharedByUserId'))
        sid = str(row['id'])
        proof = {'id': sid, 'fingerprint': row['fingerprint'], 'updatedAt': str(row['updatedAt']),
                 'checkedAt': time.time(), 'status': 'unavailable', 'errorCode': 'SOURCE_HTTP_403',
                 'prior': {'status': 'blocked', 'attempts': 5, 'errorCode': 'SOURCE_HTTP_403',
                           'observedUpdatedAt': str(row['updatedAt'])}}

        async def mutate(pool, run, version=row, failure=proof, operator=actor):
            return await r.mutate(pool, operator, run, version, {}, None, delete=True, directory=directory,
                                  deletion_policy=SOURCE_DISPOSAL_POLICY, source_failure=failure)

        try:
            await mutate(store.pool, str(uuid4()), operator=str(uuid4()))
            raise AssertionError('unverified actor accepted')
        except PermissionError:
            pass
        for code, version, failure in [
            ('STATE_CHANGED', {**row, 'updatedAt': '2000-01-01'}, proof),
            ('SOURCE_DISPOSAL_NOT_CONFIRMED', row, {**proof, 'errorCode': 'MODEL_TIMEOUT'}),
        ]:
            try:
                await mutate(store.pool, str(uuid4()), version, failure)
                raise AssertionError('invalid deletion accepted')
            except r.RepairFailure as exc:
                assert exc.code == code

        failed = str(uuid4())
        try:
            async with r.deletion_batch(store.pool, [row]) as pool:
                assert await mutate(pool, failed) == 'deleted'
                raise RuntimeError('intentional atomic transaction failure')
        except RuntimeError:
            pass
        async with store.pool.connection() as conn:
            assert await (await conn.execute('SELECT id FROM summaries WHERE id=%s', (sid,))).fetchone()
            assert not await (await conn.execute('SELECT id FROM admin_actions WHERE "targetId"=%s AND action=%s',
                                                 (sid, SOURCE_DISPOSAL_ACTION))).fetchone()
        try:
            await r.restore_deleted(store.pool, actor, directory, directory/'deleted'/f'{sid}-{failed}.json')
            raise AssertionError('uncommitted orphan archive restored')
        except ValueError:
            pass

        async with store.pool.connection() as conn:
            class SameConnection:
                @asynccontextmanager
                async def connection(self):
                    yield conn
            try:
                async with conn.transaction():
                    await conn.execute('INSERT INTO user_bookmarks (id,"userId","targetType","targetId","createdAt") '
                                       "VALUES (%s,%s,'summary',%s,now())", (str(uuid4()), actor, sid))
                    assert await mutate(SameConnection(), str(uuid4())) == 'protected'
                    raise RuntimeError('rollback test bookmark')
            except RuntimeError:
                pass

        run = str(uuid4())
        plan = g.serial({'actorId': actor, 'batchId': run, 'policy': SOURCE_DISPOSAL_POLICY,
                         'rows': [{**row, 'decision': 'delete', 'sourceFailure': proof}], 'results': {}})
        g.save(directory/'plan.json', plan)
        first = await apply(store.pool, actor, directory, 10, policy=SOURCE_DISPOSAL_POLICY, action=SOURCE_DISPOSAL_ACTION)
        assert first['results'] == {'deleted': 1}
        assert await deleted_publication(store.pool, str(row['sourceId']), row['canonicalUrl'], row['title'], row['publishedAt'])
        # A lost checkpoint after commit reconciles with the stable audit key.
        g.save(directory/'plan.json', plan)
        again = await apply(store.pool, actor, directory, 10, policy=SOURCE_DISPOSAL_POLICY, action=SOURCE_DISPOSAL_ACTION)
        assert again['results'] == {'deleted': 1}
        assert (await apply(store.pool, actor, directory, 10, policy=SOURCE_DISPOSAL_POLICY,
                            action=SOURCE_DISPOSAL_ACTION))['processed'] == 0
        archive = directory/'deleted'/f'{sid}-{run}.json'
        assert await r.restore_deleted(store.pool, actor, directory, archive) == sid
        assert not await deleted_publication(store.pool, str(row['sourceId']), row['canonicalUrl'], row['title'], row['publishedAt'])
        try:
            await r.restore_deleted(store.pool, actor, directory, archive)
            raise AssertionError('later existing content overwritten')
        except r.RepairFailure as exc:
            assert exc.code == 'RESTORE_CONFLICT'
        async with store.pool.connection() as conn:
            restored = dict(await (await conn.execute('SELECT s.*,md5(to_jsonb(s)::text) AS fingerprint '
                                                      'FROM summaries s WHERE id=%s', (sid,))).fetchone())
            assert restored['fingerprint'] == row['fingerprint']
            audit = await (await conn.execute('SELECT count(*) n FROM admin_actions WHERE "targetId"=%s AND action=%s',
                                              (sid, SOURCE_DISPOSAL_ACTION))).fetchone()
            assert audit['n'] == 1
        print(json.dumps({'passed': True, 'database': database, 'checks': ['real_admin', 'snapshot_CAS',
            'model_error_retained', 'references_protected', 'atomic_rollback', 'orphan_archive_rejected',
            'commit_reconciliation', 'repeat_idempotent', 'exact_row_restore', 'restore_conflict', 'publication_tombstone']}))
    finally:
        await store.close()


if __name__ == '__main__':
    asyncio.run(main())
