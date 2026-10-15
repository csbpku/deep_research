"""Admin-only, no-fetch/no-model preview and conditional deletion of scored noise."""
from __future__ import annotations

import argparse
import asyncio
import fcntl
import hashlib
import json
import os
from collections import Counter
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid4, uuid5

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar import governance as g, repair as r
from ai_engine.radar.noise_policy import NOISE_POLICY, confirmed_noise


async def preview(pool: Any, actor: str, directory: Path) -> dict[str, Any]:
    async with pool.connection() as conn:
        async with conn.transaction():
            await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
            actor = await g.verify_admin(conn, actor)
            rows = [dict(x) for x in await (await conn.execute(
                'SELECT s.id,s.title,s."canonicalUrl",s."createdAt",s."updatedAt",s."distilledScore",'
                's."distilledTier",(COALESCE(s."userNote",\'\')<>\'\' OR s."sharedByUserId" IS NOT NULL) AS "userOwned",'
                'md5(to_jsonb(s)::text) AS fingerprint FROM summaries s '
                "WHERE s.source='daily' AND s.\"distilledScore\"->>'tier'='noise' "
                'ORDER BY s."createdAt" DESC,s.id')).fetchall()]
            protections = await g.protected_ids(conn, rows)
    for row in rows:
        row['protectedBy'] = protections.get(str(row['id']), [])
        row['decision'] = ('protected' if row['protectedBy'] or row['userOwned'] else
                           'delete' if confirmed_noise(row['distilledScore']) else 'score_requires_review')
    plan: dict[str, Any] = g.serial({'batchId': str(uuid4()), 'actorId': actor, 'policy': NOISE_POLICY,
                     'rows': rows, 'results': {}, 'modelCalls': 0, 'sourceFetches': 0})
    g.save(directory / 'plan.json', plan)
    return plan


async def apply(pool: Any, actor: str, directory: Path, limit: int) -> dict[str, Any]:
    if not 1 <= limit <= 100:
        raise ValueError('batch limit must be 1..100')
    g.verify_backup()
    path = directory / 'plan.json'
    plan = json.loads(path.read_text())
    async with pool.connection() as conn:
        actor = await g.verify_admin(conn, actor)
    if actor != plan['actorId'] or plan['policy'] != NOISE_POLICY:
        raise PermissionError('plan owner/policy mismatch')
    selected = [item for item in plan['rows'] if item['decision'] == 'delete'
                and str(item['id']) not in plan['results']][:limit]
    processed = len(selected)
    committed: dict[str, Any] = {}
    if selected:
        async with r.deletion_batch(pool, selected) as batch_pool:
            for item in selected:
                sid = str(item['id'])
                # Stable per-item run makes a crash after commit recoverable from audit.
                run = plan['batchId']
                async with batch_pool.connection() as conn:
                    current = await (await conn.execute(
                        'SELECT s.*,rr."sourceId",md5(to_jsonb(s)::text) AS fingerprint '
                        'FROM summaries s LEFT JOIN radar_sync_runs rr ON rr.id=s."syncRunId" WHERE s.id=%s',
                        (sid,))).fetchone()
                    if current is None:
                        audit = await (await conn.execute(
                            "SELECT metadata FROM admin_actions WHERE action='radar_noise_delete' "
                            'AND "targetId"=%s AND "requestId"=%s',
                            (sid, str(uuid5(NAMESPACE_URL, run + ':' + sid + ':radar_noise_delete'))))).fetchone()
                        result = {'status': 'deleted' if audit else 'missing_elsewhere', 'reconciled': True}
                    elif str(current['fingerprint']) != item['fingerprint']:
                        result = {'status': 'snapshot_changed'}
                    else:
                        result = {}
                if current is not None and not result:
                    try:
                        status = await r.mutate(batch_pool, actor, run, dict(current), {}, None, delete=True,
                                                directory=directory, deletion_policy=NOISE_POLICY)
                        result = {'status': status}
                    except r.RepairFailure as exc:
                        result = {'status': 'skipped', 'reason': exc.code}
                if result['status'] == 'deleted':
                    archive = directory / 'deleted' / f'{sid}-{run}.json'
                    result.update(archive=str(archive), archiveSha256=hashlib.sha256(archive.read_bytes()).hexdigest())
                committed[sid] = result
    plan['results'].update(committed)
    g.save(path, plan)
    return {'batchId': plan['batchId'], 'processed': processed,
            'decisions': dict(Counter(x['decision'] for x in plan['rows'])),
            'results': dict(Counter(x['status'] for x in plan['results'].values())),
            'remaining': sum(x['decision'] == 'delete' and str(x['id']) not in plan['results'] for x in plan['rows']),
            'modelCalls': 0, 'sourceFetches': 0}


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['preview', 'apply'])
    parser.add_argument('--actor', required=True)
    parser.add_argument('--state-dir', required=True, type=Path)
    parser.add_argument('--limit', type=int, default=10)
    args = parser.parse_args()
    os.umask(0o077)
    args.state_dir.mkdir(parents=True, exist_ok=True)
    with (args.state_dir / 'purge.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        store = DbJobStore(dsn=os.environ['DATABASE_URL'])
        await store.open()
        try:
            if args.mode == 'preview':
                if (args.state_dir / 'plan.json').exists():
                    raise ValueError('use a new directory for a new preview; never replace an executed plan')
                plan = await preview(store.pool, args.actor, args.state_dir)
                print(json.dumps({'batchId': plan['batchId'], 'noise': len(plan['rows']),
                                  'decisions': dict(Counter(x['decision'] for x in plan['rows']))}))
            else:
                print(json.dumps(await apply(store.pool, args.actor, args.state_dir, args.limit)))
        finally:
            await store.close()


if __name__ == '__main__':
    asyncio.run(main())
