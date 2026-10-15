"""Run durable, audited radar repair without enabling legacy enrichment."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from pathlib import Path

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar import governance as g
from ai_engine.radar.repair import cycle, failure, requeue, restore_deleted, rollback_repair


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--actor', required=True)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--limit', type=int, default=20)
    parser.add_argument('--interval', type=int, default=60)
    parser.add_argument('--delete-confirmed-noise', action='store_true')
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--report', action='store_true')
    parser.add_argument('--requeue', metavar='ID')
    parser.add_argument('--reason', default='')
    parser.add_argument('--restore-archive', type=Path)
    parser.add_argument('--rollback-audit', metavar='ID')
    args = parser.parse_args()
    if not 1 <= args.limit <= 100 or args.interval < 30:
        parser.error('limit must be 1..100 and interval >=30 seconds')
    if args.report:
        print((args.state_dir / 'state.json').read_text())
        return
    store = DbJobStore(dsn=os.environ['DATABASE_URL'])
    await store.open()
    try:
        if args.rollback_audit:
            print(json.dumps({'rolledBack': await rollback_repair(store.pool, args.actor, args.rollback_audit)}))
            return
        if args.restore_archive:
            print(json.dumps({'restored': await restore_deleted(store.pool, args.actor, args.state_dir, args.restore_archive)}))
            return
        if args.requeue:
            await requeue(store.pool, args.actor, args.state_dir, args.requeue, args.reason)
            print(json.dumps({'requeued': args.requeue}))
            return
        while True:
            try:
                result = await cycle(store.pool, args.actor, args.state_dir,
                                     limit=args.limit, delete_noise=args.delete_confirmed_noise)
            except Exception as exc:
                problem = failure(exc)
                result = {'status': 'worker_retry_wait', 'errorCode': problem.code,
                          'reason': problem.detail, 'at': time.time(), 'nextAttemptAt': time.time() + args.interval}
                g.save(args.state_dir / 'operator-failure.json', result)
                print(json.dumps(result), flush=True)
                if args.once:
                    raise SystemExit(1) from None
                await asyncio.sleep(args.interval)
                continue
            print(json.dumps(result), flush=True)
            if args.once:
                break
            await asyncio.sleep(args.interval)
    finally:
        await store.close()


if __name__ == '__main__':
    asyncio.run(main())
