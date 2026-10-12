"""Exercise governance against an explicitly isolated restored database."""
from __future__ import annotations

import asyncio
import os
from uuid import NAMESPACE_URL, uuid4, uuid5
from urllib.parse import urlsplit, urlunsplit

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar import governance as g


async def main() -> None:
    database = os.environ['GOVERNANCE_VERIFY_DATABASE']
    if not database.startswith('governance_verify_'):
        raise RuntimeError('verification must never run on production')
    dsn = urlunsplit(urlsplit(os.environ['DATABASE_URL'])._replace(path='/' + database))
    store = DbJobStore(dsn=dsn)
    await store.open()
    try:
        plan = await g.snapshot(store.pool, 'shaobo.chen@shopee.com')
        assert plan['operations']
        batch, actor = plan['batchId'], plan['actorId']
        pilot = await g.execute(store.pool, actor, batch, limit=10)
        assert pilot['counts'] == {'applied': 10}, pilot
        async with store.pool.connection() as conn:
            async with conn.transaction():
                assert await g.apply_one(conn, actor, batch, plan['operations'][0]) == 'already_applied'
        rollback = await g.execute(store.pool, actor, batch, limit=100, rollback=True)
        assert rollback['counts'].get('rolled_back') == 10, rollback
        # Chain: unsupported grade repair followed by external-reading tags.
        op = next(o for o in plan['operations'] if o['reason'] == 'unsupported_grade')
        chain_batch = str(uuid4())
        async with store.pool.connection() as conn:
            async with conn.transaction():
                row = dict(await (await conn.execute('SELECT * FROM summaries WHERE id=%s', (op['id'],))).fetchone())
                first = {**op, 'expectedUpdatedAt': str(row['updatedAt'])}
                assert await g.apply_one(conn, actor, chain_batch, first) == 'applied'
                row = dict(await (await conn.execute('SELECT * FROM summaries WHERE id=%s', (op['id'],))).fetchone())
                recovery = {'table': 'summaries', 'id': op['id'], 'reason': 'verified_source_recovery',
                            'before': {'tags': row['tags']}, 'after': {'tags': [*row['tags'], 'external_reading']},
                            'expectedUpdatedAt': str(row['updatedAt'])}
                recovery_batch = str(uuid5(NAMESPACE_URL, chain_batch + ':recovery'))
                assert await g.apply_one(conn, actor, recovery_batch, recovery) == 'applied'
                assert await g.apply_one(conn, actor, recovery_batch, recovery, rollback=True) == 'rolled_back'
                assert await g.apply_one(conn, actor, chain_batch, first, rollback=True) == 'rolled_back'
        # Optimistic lock rejects a stale timestamp even if values match.
        async with store.pool.connection() as conn:
            async with conn.transaction():
                assert await g.apply_one(conn, actor, str(uuid4()), first) == 'conflict'
        # State and audit vanish together when the transaction fails.
        failed_batch = str(uuid4())
        try:
            async with store.pool.connection() as conn:
                async with conn.transaction():
                    row = dict(await (await conn.execute('SELECT * FROM summaries WHERE id=%s', (op['id'],))).fetchone())
                    assert await g.apply_one(conn, actor, failed_batch, {**op, 'expectedUpdatedAt': str(row['updatedAt'])}) == 'applied'
                    raise RuntimeError('intentional transaction failure')
        except RuntimeError:
            pass
        async with store.pool.connection() as conn:
            assert not await (await conn.execute('SELECT id FROM admin_actions WHERE metadata->>\'batchId\'=%s', (failed_batch,))).fetchone()
            row = dict(await (await conn.execute('SELECT * FROM summaries WHERE id=%s', (op['id'],))).fetchone())
            assert all(row[k] == v for k, v in op['before'].items())
        print('PASS: snapshot, Admin, pilot, idempotence, rollback chain, CAS conflict, atomic failure')
    finally:
        await store.close()


if __name__ == '__main__':
    asyncio.run(main())
