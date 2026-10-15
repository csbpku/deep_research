"""Explicit Admin-only fixed disposal of incomplete radar with verified source failures.

Inspection is a private source-only preflight receipt. This command performs no
fetch or model calls. It requires owner authorization, backup, terminal history,
recent evidence and a matching snapshot, and never labels the result noise.
"""

from __future__ import annotations

import argparse
import asyncio
import fcntl
import json
import os
from collections import Counter
from pathlib import Path
from typing import Any
from uuid import uuid4

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar import governance as g, repair as r
from ai_engine.radar.source_disposal import (
    SOURCE_DISPOSAL_ACTION,
    SOURCE_DISPOSAL_POLICY,
    source_disposal_eligible,
)
from scripts.purge_scored_noise import apply


async def preview(pool: Any, actor: str, directory: Path, inspection: Path) -> dict[str, Any]:
    receipt = json.loads(inspection.read_text())
    proofs = receipt["results"]
    async with pool.connection() as conn:
        async with conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            actor = await g.verify_admin(conn, actor)
            rows = [
                dict(x)
                for x in await (
                    await conn.execute(
                        'SELECT s.*,rr."sourceId",md5(to_jsonb(s)::text) AS fingerprint FROM summaries s '
                        'LEFT JOIN radar_sync_runs rr ON rr.id=s."syncRunId" WHERE s.id=ANY(%s::uuid[]) '
                        'ORDER BY s."createdAt" DESC,s.id',
                        (list(proofs),),
                    )
                ).fetchall()
            ]
            protections = await g.protected_ids(conn, rows)
    for row in rows:
        proof = proofs[str(row["id"])]
        row["sourceFailure"] = proof
        row["protectedBy"] = protections.get(str(row["id"]), [])
        eligible = source_disposal_eligible(
            row, proof, incomplete=not r.has_score(row) or r.needs_summary(row)
        )
        row["decision"] = (
            "protected"
            if row["protectedBy"] or row.get("userNote") or row.get("sharedByUserId")
            else "delete"
            if eligible
            else "retain"
        )
    plan = g.serial(
        {
            "batchId": str(uuid4()),
            "actorId": actor,
            "policy": SOURCE_DISPOSAL_POLICY,
            "rows": rows,
            "results": {},
            "modelCalls": 0,
            "sourceFetches": 0,
        }
    )
    g.save(directory / "plan.json", plan)
    return plan


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["preview", "apply"])
    parser.add_argument("--actor", required=True)
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--inspection", type=Path)
    parser.add_argument("--limit", type=int, default=10)
    args = parser.parse_args()
    os.umask(0o077)
    args.state_dir.mkdir(parents=True, exist_ok=True)
    with (args.state_dir / "purge.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        store = DbJobStore(dsn=os.environ["DATABASE_URL"])
        await store.open()
        try:
            if args.mode == "preview":
                if not args.inspection or (args.state_dir / "plan.json").exists():
                    raise ValueError("provide inspection and a new preview directory")
                plan = await preview(store.pool, args.actor, args.state_dir, args.inspection)
                print(
                    json.dumps(
                        {
                            "batchId": plan["batchId"],
                            "decisions": dict(Counter(x["decision"] for x in plan["rows"])),
                        }
                    )
                )
            else:
                print(
                    json.dumps(
                        await apply(
                            store.pool,
                            args.actor,
                            args.state_dir,
                            args.limit,
                            policy=SOURCE_DISPOSAL_POLICY,
                            action=SOURCE_DISPOSAL_ACTION,
                        )
                    )
                )
        finally:
            await store.close()


if __name__ == "__main__":
    asyncio.run(main())
