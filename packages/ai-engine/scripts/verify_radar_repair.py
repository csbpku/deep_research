"""Check repair transactions ONLY in an isolated governance_verify_* restore.

No fetches/models. Synthetic fixtures are rolled back, including their audits.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from uuid import uuid4

from psycopg import AsyncConnection, conninfo
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from ai_engine.radar import repair as r
from ai_engine.radar.diagnostic_policy import deleted_publication
from ai_engine.radar.distilled_scorer import DISTILLED_VERSION


async def verify(database: str) -> dict[str, bool]:
    if not database.startswith('governance_verify_') or not database.replace('_', '').isalnum():
        raise ValueError('only an isolated governance_verify_* database is allowed')
    dsn = conninfo.make_conninfo(os.environ['DATABASE_URL'], dbname=database)
    conn = await AsyncConnection.connect(dsn, row_factory=dict_row)

    class Pool:
        @asynccontextmanager
        async def connection(self):
            yield conn

    pool = Pool()
    checks: dict[str, bool] = {}
    try:
        async with conn.transaction(force_rollback=True):
            actor_row = await (await conn.execute("SELECT id FROM users WHERE role='admin' LIMIT 1")).fetchone()
            assert actor_row
            actor = str(actor_row['id'])
            seed = await (await conn.execute('SELECT id,"sourceId" FROM radar_sync_runs LIMIT 1')).fetchone()
            assert seed
            sid, did, other_did = str(uuid4()), str(uuid4()), str(uuid4())
            url = 'https://example.org/governance-fixture/' + sid
            score = {'isDefault': False, 'version': DISTILLED_VERSION, 'tier': 'noise',
                     'dimensions': dict.fromkeys('abcdefg', 1), 'weakPoint': 'No implementation',
                     'weakPointEvidence': 'only a landing page'}
            row = await (await conn.execute('INSERT INTO summaries '
                '(id,title,body,url,"canonicalUrl",source,"summaryDate","updatedAt","distilledScore",'
                '"distilledTier","syncRunId",tags) VALUES (%s,%s,%s,%s,%s,\'daily\',current_date,now(),%s,\'noise\',%s,%s) RETURNING *',
                (sid, 'governance fixture', 'Source summary ' * 20, url, url, Jsonb(score), seed['id'], ['external_reading']))).fetchone()
            assert row
            row = {**dict(row), 'sourceId': seed['sourceId']}
            other_run = await (await conn.execute('SELECT id FROM radar_sync_runs WHERE id<>%s LIMIT 1', (seed['id'],))).fetchone()
            assert other_run
            for diagnostic_id, run_id in [(did, seed['id']), (other_did, other_run['id'])]:
                await conn.execute('INSERT INTO radar_sync_diagnostics '
                    '(id,"sourceId","runId",kind,title,url,"canonicalUrl","reasonCode","reasonMessage","updatedAt") '
                    "VALUES (%s,%s,%s,'failed','fixture',%s,%s,'PENDING_SCORE','fixture',now())",
                    (diagnostic_id, seed['sourceId'], run_id, url, url))
            evidence = r.Evidence('The complete source states: only a landing page', 'github_readme', True)
            with tempfile.TemporaryDirectory(prefix='radar-repair-check-') as temp:
                directory = Path(temp)
                try:
                    await r.mutate(pool, actor, str(uuid4()), {**row, 'updatedAt': 'stale'}, {'body': 'new'},
                                   evidence, delete=False, directory=directory)
                except r.RepairFailure as exc:
                    assert exc.code == 'STATE_CHANGED'
                else:
                    raise AssertionError('CAS accepted stale row')
                checks['cas_conflict'] = True
                await conn.execute('INSERT INTO user_bookmarks (id,"userId","targetType","targetId") '
                                   "VALUES (%s,%s,'summary',%s)", (str(uuid4()), actor, sid))
                assert await r.mutate(pool, actor, str(uuid4()), row, {}, evidence, delete=True, directory=directory) == 'protected'
                await conn.execute('DELETE FROM user_bookmarks WHERE "targetId"=%s', (sid,))
                annotation = str(uuid4())
                await conn.execute('INSERT INTO radar_annotations '
                    '(id,"summaryId","authorId",kind,quote,"startOffset","endOffset") '
                    "VALUES (%s,%s,%s,'note','source',0,6)", (annotation, sid, actor))
                assert await r.mutate(pool, actor, str(uuid4()), row, {}, evidence, delete=True, directory=directory) == 'protected'
                await conn.execute('DELETE FROM radar_annotations WHERE id=%s', (annotation,))
                checks['bookmark_annotation_protection'] = True
                owner_repo = 'governance-fixture/' + sid
                await conn.execute('INSERT INTO radar_tracked_repos (id,"ownerRepo",status) VALUES (%s,%s,\'pinned\')',
                                   (str(uuid4()), owner_repo))
                pins = await r.g.protected_ids(conn, [{'id': sid, 'canonicalUrl': 'https://github.com/' + owner_repo}])
                assert 'radar_tracked_repos' in pins[sid]
                checks['manual_repo_pin_protection'] = True
                original_audit = r.audit

                async def fail_audit(*args: Any, **kwargs: Any) -> None:
                    raise RuntimeError('synthetic audit failure')

                r.audit = fail_audit
                try:
                    try:
                        await r.mutate(pool, actor, str(uuid4()), row, {'body': 'failed transaction'},
                                       evidence, delete=False, directory=directory)
                    except RuntimeError:
                        pass
                    current = await (await conn.execute('SELECT body FROM summaries WHERE id=%s', (sid,))).fetchone()
                    assert current and current['body'] == row['body']
                    checks['audit_failure_rolls_back_update'] = True
                finally:
                    r.audit = original_audit
                run = str(uuid4())
                assert await r.mutate(pool, actor, run, row, {}, evidence, delete=True, directory=directory) == 'deleted'
                assert not await (await conn.execute('SELECT id FROM summaries WHERE id=%s', (sid,))).fetchone()
                assert not await (await conn.execute('SELECT id FROM radar_sync_diagnostics WHERE id=%s', (did,))).fetchone()
                assert await (await conn.execute('SELECT id FROM radar_sync_diagnostics WHERE id=%s', (other_did,))).fetchone()
                assert await deleted_publication(pool, str(seed['sourceId']), url, row['title'], None)
                assert not await deleted_publication(pool, str(seed['sourceId']), url, 'new publication', None)
                checks['delete_same_evidence_only_and_tombstone'] = True
                archive = directory / 'deleted' / f'{sid}-{run}.json'
                original_verify = r.g.verify_backup
                r.g.verify_backup = lambda: None  # Database name guard above; this script uses the verified restore.
                try:
                    assert await r.restore_deleted(pool, actor, directory, archive) == sid
                    restored = await (await conn.execute('SELECT * FROM summaries WHERE id=%s', (sid,))).fetchone()
                    assert restored and r.g.serial(restored) == r.g.serial({k: v for k, v in row.items() if k != 'sourceId'})
                    assert await (await conn.execute('SELECT id FROM radar_sync_diagnostics WHERE id=%s', (did,))).fetchone()
                    assert not await deleted_publication(pool, str(seed['sourceId']), url, row['title'], None)
                    try:
                        await r.restore_deleted(pool, actor, directory, archive)
                    except r.RepairFailure as exc:
                        assert exc.code == 'RESTORE_CONFLICT'
                    else:
                        raise AssertionError('restore overwrote existing row')
                    checks['restore_exact_row_diagnostics_and_conflict'] = True
                    await r.mutate(pool, actor, str(uuid4()), row, {'body': 'repaired body'},
                                   evidence, delete=False, directory=directory)
                    repair_audit = await (await conn.execute(
                        "SELECT id FROM admin_actions WHERE action='radar_repair_apply' AND \"targetId\"=%s LIMIT 1",
                        (sid,))).fetchone()
                    assert repair_audit
                    assert await r.rollback_repair(pool, actor, str(repair_audit['id'])) == sid
                    restored_body = await (await conn.execute('SELECT body FROM summaries WHERE id=%s', (sid,))).fetchone()
                    assert restored_body and restored_body['body'] == row['body']
                    try:
                        await r.rollback_repair(pool, actor, str(repair_audit['id']))
                    except r.RepairFailure as exc:
                        assert exc.code == 'ROLLBACK_CONFLICT'
                    else:
                        raise AssertionError('rollback accepted changed timestamp')
                    checks['repair_rollback_and_later_edit_conflict'] = True
                    item = {'errorCode': 'SOURCE_HTTP_404', 'reason': 'source HTTP 404', 'attempts': 1,
                            'nextAttemptAt': 12345, 'status': 'retry_wait'}
                    failure_run = str(uuid4())
                    await r.record_failure(pool, actor, failure_run, row, item)
                    await r.record_failure(pool, actor, failure_run, row, item)
                    failures = await (await conn.execute(
                        "SELECT count(*) n FROM admin_actions WHERE action='radar_repair_failed' AND \"targetId\"=%s", (sid,))).fetchone()
                    assert failures and failures['n'] == 1
                    checks['failure_outbox_idempotence'] = True
                    incomplete = await (await conn.execute(
                        'UPDATE summaries SET interpretation=NULL,"updatedAt"=clock_timestamp() WHERE id=%s RETURNING *',
                        (sid,))).fetchone()
                    assert incomplete
                    incomplete = {**dict(incomplete), 'sourceId': seed['sourceId']}
                    await r.record_failure(pool, actor, str(uuid4()), incomplete, {
                        **item, 'errorCode': 'MODEL_SUMMARY_INVALID', 'reason': 'missing judgement'})
                    await r.mutate(pool, actor, str(uuid4()), incomplete, {'body': 'summary ' * 30},
                                   evidence, delete=False, directory=directory)
                    pending_summary = await (await conn.execute(
                        'SELECT status FROM radar_sync_diagnostics WHERE "runId"=%s AND "canonicalUrl"=%s '
                        'AND "reasonCode"=\'REPAIR_MODEL_SUMMARY_INVALID\'', (seed['id'], url))).fetchone()
                    assert pending_summary and pending_summary['status'] == 'pending'
                    checks['partial_repair_keeps_unresolved_summary_diagnostic'] = True
                finally:
                    r.g.verify_backup = original_verify
    finally:
        await conn.close()
    return checks


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True)
    args = parser.parse_args()
    print(json.dumps(asyncio.run(verify(args.database))))
