"""Preview or execute the explicit, resumable Admin radar standard migration."""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar import unification as u


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--actor', required=True)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--preview', action='store_true')
    parser.add_argument('--limit', type=int, default=10)
    parser.add_argument('--rollback-audit')
    args = parser.parse_args()
    args.state_dir.mkdir(parents=True, exist_ok=True)
    store = DbJobStore(dsn=os.environ['DATABASE_URL'])
    await store.open()
    try:
        if args.rollback_audit:
            print(json.dumps({'restored': await u.rollback(store.pool, args.actor, args.rollback_audit)}))
            return
        state = await u.snapshot(store.pool, args.actor, args.state_dir)
        if args.preview:
            result = {k: state[k] for k in ('policy', 'batch', 'beforeCounts', 'maxModelCalls')}
            result['targets'] = len(state['targets'])
        else:
            result = await u.run(store.pool, args.actor, args.state_dir, limit=args.limit)
        print(json.dumps(result), flush=True)
    finally:
        await store.close()


if __name__ == '__main__':
    asyncio.run(main())
