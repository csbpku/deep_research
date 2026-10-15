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
                "WHERE s.source='daily' AND s.\"distilledScore\" IS NULL AND s.\"syncRunId\" IS NOT NULL "
                "AND NOT EXISTS (SELECT 1 FROM admin_actions a WHERE a.action='radar_source_unavailable_delete' "
                'AND a."targetId"=s.id) ORDER BY s.id')).fetchall()]
            protected = await g.protected_ids(conn, rows)
        row = next(x for x in rows if str(x['id']) not in protected and not x.get('userNote') and not x.get('sharedByUserId'))
        sid = str(row['id'])
        fixture_ids = [str(uuid4()), str(uuid4())]
        async with store.pool.connection() as conn:
            async with conn.transaction():
                for fixture, status in zip(fixture_ids, ('pending', 'dismissed'), strict=True):
                    await conn.execute('INSERT INTO radar_sync_diagnostics '
                        '(id,"sourceId","runId",kind,status,title,url,"canonicalUrl",body,"reasonCode","updatedAt") '
                        "VALUES (%s,%s,%s,'failed',%s,'fixture',%s,%s,'fixture','REPAIR_HISTORY_FIXTURE',now())",
                        (fixture, row['sourceId'], row['syncRunId'], status, row['canonicalUrl'], row['canonicalUrl']))
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
                async with pool.connection() as conn:
                    kept = await (await conn.execute('SELECT id,status FROM radar_sync_diagnostics '
                        'WHERE id=ANY(%s::uuid[])', (fixture_ids,))).fetchall()
                    assert len(kept) == 2 and all(x['status'] == 'dismissed' for x in kept)
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
        # Reproduce a legacy archive with missing diagnostics, then correct it.
        original_retention = r._retain_source_diagnostics

        async def legacy_move(conn, *args, **kwargs):
            await conn.execute('DELETE FROM radar_sync_diagnostics WHERE "runId"=%s AND "canonicalUrl"=%s AND '
                               + r.OWN_DIAGNOSTICS, (row['syncRunId'], row['canonicalUrl']))
            return {}

        r._retain_source_diagnostics = legacy_move
        try:
            first = await apply(store.pool, actor, directory, 10, policy=SOURCE_DISPOSAL_POLICY, action=SOURCE_DISPOSAL_ACTION)
        finally:
            r._retain_source_diagnostics = original_retention
        assert first['results'] == {'deleted': 1}
        archive = directory/'deleted'/f'{sid}-{run}.json'
        correction = await r.retain_deleted_diagnostics(store.pool, actor, directory, archive)
        assert correction['restored'] >= 2 and correction['closedPending'] >= 1
        assert (await r.retain_deleted_diagnostics(store.pool, actor, directory, archive))['status'] == 'already_preserved'
        assert await deleted_publication(store.pool, str(row['sourceId']), row['canonicalUrl'], row['title'], row['publishedAt'])
        # A lost checkpoint after commit reconciles with the stable audit key.
        g.save(directory/'plan.json', plan)
        again = await apply(store.pool, actor, directory, 10, policy=SOURCE_DISPOSAL_POLICY, action=SOURCE_DISPOSAL_ACTION)
        assert again['results'] == {'deleted': 1}
        assert (await apply(store.pool, actor, directory, 10, policy=SOURCE_DISPOSAL_POLICY,
                            action=SOURCE_DISPOSAL_ACTION))['processed'] == 0
        async with store.pool.connection() as conn:
            pending_after = dict(await (await conn.execute('SELECT * FROM radar_sync_diagnostics WHERE id=%s',
                                                           (fixture_ids[0],))).fetchone())
            assert pending_after['status'] == 'dismissed'
            await conn.execute('UPDATE radar_sync_diagnostics SET "reasonMessage"=\'later edit\',"updatedAt"=now() WHERE id=%s',
                               (fixture_ids[0],))
        try:
            await r.restore_deleted(store.pool, actor, directory, archive)
            raise AssertionError('later diagnostic changes overwritten')
        except r.RepairFailure as exc:
            assert exc.code == 'RESTORE_CONFLICT'
        async with store.pool.connection() as conn:
            await conn.execute('UPDATE radar_sync_diagnostics SET "reasonMessage"=%s,"updatedAt"=%s WHERE id=%s',
                (pending_after['reasonMessage'], pending_after['updatedAt'], fixture_ids[0]))
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
            fixtures = await (await conn.execute('SELECT id,status FROM radar_sync_diagnostics WHERE id=ANY(%s::uuid[])',
                                                (fixture_ids,))).fetchall()
            assert {str(x['id']): x['status'] for x in fixtures} == dict(zip(fixture_ids, ('pending', 'dismissed'), strict=True))
        print(json.dumps({'passed': True, 'database': database, 'checks': ['real_admin', 'snapshot_CAS',
            'model_error_retained', 'references_protected', 'atomic_rollback', 'orphan_archive_rejected',
            'commit_reconciliation', 'repeat_idempotent', 'exact_row_restore', 'restore_conflict', 'publication_tombstone',
            'diagnostic_history_retained', 'legacy_history_recovered', 'pending_closed', 'history_recovery_idempotent',
            'later_diagnostic_edit_protected', 'original_diagnostic_states_restored']}))
    finally:
        await store.close()


if __name__ == '__main__':
    asyncio.run(main())
