"""Authorized SSH maintenance counterpart of the Admin BFF.

Never reads an actor from environment defaults: the operator must explicitly
identify a real database Admin. State and audits use the same core as the BFF.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from urllib.parse import urlsplit, urlunsplit

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar import governance


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('preview', 'report', 'apply', 'recover', 'rollback'))
    parser.add_argument('--actor', required=True)
    parser.add_argument('--batch')
    parser.add_argument('--limit', type=int, default=10)
    parser.add_argument('--isolated-database')
    args = parser.parse_args()
    dsn = os.environ['DATABASE_URL']
    if args.isolated_database:
        if not args.isolated_database.startswith('governance_verify_'):
            parser.error('only an isolated governance verification database is allowed')
        parts = urlsplit(dsn)
        dsn = urlunsplit(parts._replace(path='/' + args.isolated_database))
    store = DbJobStore(dsn=dsn)
    await store.open()
    try:
        async with store.pool.connection() as conn:
            actor = await governance.verify_admin(conn, args.actor)
        if args.mode == 'preview':
            result = governance.summary(await governance.snapshot(store.pool, actor))
        else:
            if not args.batch:
                parser.error('--batch is required')
            plan = governance.load(args.batch)
            if plan['actorId'] != actor:
                raise PermissionError('batch belongs to a different Admin')
            if args.mode == 'report':
                result = plan
            elif args.mode == 'recover':
                result = await governance.recover(store.pool, actor, args.batch, limit=args.limit)
            else:
                result = await governance.execute(store.pool, actor, args.batch, limit=args.limit,
                                                  rollback=args.mode == 'rollback')
        print(json.dumps(result, ensure_ascii=False, default=str))
    finally:
        await store.close()


if __name__ == '__main__':
    asyncio.run(main())
