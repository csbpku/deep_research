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
    parser.add_argument('--review-legacy-noise', action='store_true',
                        help='Explicitly permit bounded paid review of legacy noise only; retained scores stay unchanged')
    parser.add_argument('--previous-state', type=Path,
                        help='Carry forward per-item call counts from a stopped batch; never reset its budget')
    parser.add_argument('--rollback-audit')
    parser.add_argument('--restore-score-audit', help='Conditionally restore an originally retained score; keep verified reading changes')
    args = parser.parse_args()
    args.state_dir.mkdir(parents=True, exist_ok=True)
    store = DbJobStore(dsn=os.environ['DATABASE_URL'])
    await store.open()
    try:
        if args.rollback_audit or args.restore_score_audit:
            print(json.dumps({'restored': await u.rollback(store.pool, args.actor,
                             args.rollback_audit or args.restore_score_audit,
                             scores_only=bool(args.restore_score_audit))}))
            return
        state = await u.snapshot(store.pool, args.actor, args.state_dir,
                                 review_legacy_noise=args.review_legacy_noise, previous_state=args.previous_state)
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
