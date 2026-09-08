"""Durable handoff for claim-scoped evidence searches.

The browser may poll an evidence task to provide immediate feedback, but it
must not own the state transition.  This worker consumes terminal
``evidence_search`` jobs and converges them to:

    evidence task -> research source ledger -> new review run

The report body is never changed here.  The same handoff is intentionally
idempotent so the Web endpoint can remain a read-side fallback for older
deployments and for an already-open page.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import uuid
from collections.abc import Mapping
from typing import Any

logger = logging.getLogger("ai_engine.evidence_reconciliation")

_ACTIVE_TASK_STATUSES = ("queued", "researching", "evidence_ready")
_TERMINAL_JOB_STATUSES = ("succeeded", "partial", "failed", "cancelled")


def _json_stringify(value: object) -> str:
    """Match the stable JSON shape used by the Web revision hash helper."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def research_revision_hash(row: Mapping[str, object]) -> str:
    """Hash the same fields and property order as ``hashResearchRevision``."""
    raw_tags = row.get("tags")
    tags = list(raw_tags) if isinstance(raw_tags, (list, tuple)) else []
    snapshot = {
        "title": row.get("title") or "",
        "body": row.get("body") or "",
        "background": row.get("background") if row.get("background") is not None else None,
        "conclusion": row.get("conclusion") if row.get("conclusion") is not None else None,
        "risks": row.get("risks") if row.get("risks") is not None else None,
        "tags": tags,
    }
    return hashlib.sha256(_json_stringify(snapshot).encode("utf-8")).hexdigest()


def source_snapshot_hash(rows: list[Mapping[str, object]]) -> str:
    """Hash the source ledger with the same canonical ordering as the BFF."""
    payload = [
        {
            "canonicalKey": str(row.get("canonicalKey") or ""),
            "sourceRef": row.get("sourceRef"),
            "title": row.get("title"),
            "snippet": row.get("description"),
        }
        for row in sorted(rows, key=lambda item: str(item.get("canonicalKey") or ""))
    ]
    return hashlib.sha256(_json_stringify(payload).encode("utf-8")).hexdigest()


def _clip(value: object, limit: int) -> str | None:
    if value is None:
        return None
    text = str(value)
    if len(text) <= limit:
        return text
    return f"{text[: max(0, limit - 1)].rstrip()}…"


async def reconcile_one(pool: Any, task_id: str) -> bool:
    """Advance one terminal evidence job. Return whether state changed."""
    async with pool.connection() as conn:
        async with conn.transaction():
            task = await (
                await conn.execute(
                    'SELECT t."id", t."researchId", t."aiResearchJobId", '
                    '       t."revisionHash", t."claimId", t."status" AS "taskStatus", '
                    '       j."status" AS "jobStatus", j."errorCode", j."errorMessage", '
                    '       r."status" AS "researchStatus", r."title", r."body", '
                    '       r."background", r."conclusion", r."risks", r."tags", '
                    '       original."id" AS "originalJobId" '
                    'FROM "research_evidence_tasks" t '
                    'JOIN "ai_research_jobs" j ON j."id" = t."aiResearchJobId" '
                    'JOIN "researches" r ON r."id" = t."researchId" '
                    'LEFT JOIN "ai_research_jobs" original '
                    '  ON original."draftResearchId" = r."id" '
                    'WHERE t."id" = %s '
                    '  AND t."status" IN (\'queued\', \'researching\', \'evidence_ready\') '
                    'FOR UPDATE OF t, r',
                    (task_id,),
                )
            ).fetchone()
            if task is None:
                return False

            task_status = str(task["taskStatus"])
            job_status = str(task["jobStatus"])
            if job_status not in _TERMINAL_JOB_STATUSES:
                if task_status == "queued" and job_status == "running":
                    await conn.execute(
                        'UPDATE "research_evidence_tasks" SET "status" = \'researching\', '
                        '"startedAt" = COALESCE("startedAt", now()) WHERE "id" = %s',
                        (task_id,),
                    )
                    return True
                return False

            if job_status in ("failed", "cancelled"):
                await conn.execute(
                    'UPDATE "research_evidence_tasks" SET "status" = \'failed\', '
                    '"errorCode" = COALESCE(%s, \'EVIDENCE_SEARCH_FAILED\'), '
                    '"errorMessage" = COALESCE(%s, \'定向补证任务未完成，原研究稿没有改变。\'), '
                    '"completedAt" = now() WHERE "id" = %s',
                    (task["errorCode"], task["errorMessage"], task_id),
                )
                return True

            current_hash = research_revision_hash(task)
            if str(task["researchStatus"]) != "draft" or current_hash != str(task["revisionHash"]):
                await conn.execute(
                    'UPDATE "research_evidence_tasks" SET "status" = \'stale\', '
                    '"errorCode" = \'RESEARCH_REVISION_CHANGED\', '
                    '"errorMessage" = \'研究正文已变化，本次补证不能自动合并；请对当前版本重新审核。\', '
                    '"completedAt" = now() WHERE "id" = %s',
                    (task_id,),
                )
                return True

            source_rows = list(
                await (
                    await conn.execute(
                        'SELECT "sourceRef", "canonicalKey", "title", "snippet" '
                        'FROM "ai_research_sources" '
                        'WHERE "jobId" = %s AND "snippet" IS NOT NULL '
                        '  AND btrim("snippet") <> \'\' ORDER BY "createdAt" ASC',
                        (task["aiResearchJobId"],),
                    )
                ).fetchall()
            )
            if not source_rows:
                await conn.execute(
                    'UPDATE "research_evidence_tasks" SET "status" = \'failed\', '
                    '"errorCode" = \'NO_EVIDENCE_FOUND\', '
                    '"errorMessage" = \'没有找到可核对的新来源，原研究稿没有改变。\', '
                    '"completedAt" = now() WHERE "id" = %s',
                    (task_id,),
                )
                return True

            # Serialise all evidence handoffs for one research.  This makes
            # the partial unique active-review index a last-resort guard, not
            # the normal control-flow mechanism when two claims finish close
            # together.
            await (
                await conn.execute(
                    'SELECT "id" FROM "researches" WHERE "id" = %s FOR UPDATE',
                    (task["researchId"],),
                )
            ).fetchone()

            for source in source_rows:
                canonical_key = str(source["canonicalKey"])[:512]
                await conn.execute(
                    'INSERT INTO "research_sources" '
                    '("researchId", "sourceRef", "canonicalKey", "title", "description") '
                    'VALUES (%s, %s::jsonb, %s, %s, %s) '
                    'ON CONFLICT ("researchId", "canonicalKey") DO UPDATE SET '
                    '"sourceRef" = EXCLUDED."sourceRef", "title" = EXCLUDED."title", '
                    '"description" = EXCLUDED."description"',
                    (
                        task["researchId"],
                        _json_stringify(source["sourceRef"]),
                        canonical_key,
                        _clip(source["title"], 300),
                        _clip(source["snippet"], 1000),
                    ),
                )

            ledger = list(
                await (
                    await conn.execute(
                        'SELECT "sourceRef", "canonicalKey", "title", "description" '
                        'FROM "research_sources" WHERE "researchId" = %s '
                        'ORDER BY "createdAt" ASC',
                        (task["researchId"],),
                    )
                ).fetchall()
            )
            ledger_hash = source_snapshot_hash(ledger)
            active = await (
                await conn.execute(
                    'SELECT "id" FROM "research_review_runs" '
                    'WHERE "researchId" = %s AND "executionStatus" IN (\'queued\', \'reviewing\') '
                    'ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE',
                    (task["researchId"],),
                )
            ).fetchone()
            if active is not None:
                await conn.execute(
                    'UPDATE "research_evidence_tasks" SET "status" = \'evidence_ready\', '
                    '"sourceCount" = %s, "result" = %s::jsonb WHERE "id" = %s',
                    (
                        len(source_rows),
                        _json_stringify({
                            "sourceCount": len(source_rows),
                            "sourceSnapshotHash": ledger_hash,
                            "waitingForReviewRunId": str(active["id"]),
                        }),
                        task_id,
                    ),
                )
                return True

            # A claim-scoped evidence task creates a new immutable review
            # snapshot. Preserve only explicit author decisions that are
            # still meaningful for unchanged claims. Otherwise adding
            # evidence for one claim would silently reopen unrelated
            # "accepted as uncertainty" items in the publication gate.
            previous = await (
                await conn.execute(
                    'SELECT "id" FROM "research_review_runs" '
                    'WHERE "researchId" = %s AND "revisionHash" = %s '
                    '  AND "executionStatus" = \'completed\' '
                    'ORDER BY "createdAt" DESC LIMIT 1',
                    (task["researchId"], task["revisionHash"]),
                )
            ).fetchone()

            run_id = str(uuid.uuid4())
            queued_at = _json_stringify({
                "phase": "queued",
                "status": "queued",
                "attempts": 0,
                "runId": run_id,
                "revisionHash": str(task["revisionHash"]),
                "sourceSnapshotHash": ledger_hash,
                "triggeredBy": "claim_evidence",
                "evidenceTaskId": str(task_id),
                "requestedClaimIds": [str(task["claimId"])],
            })
            await conn.execute(
                'INSERT INTO "research_review_runs" '
                '("id", "researchId", "aiResearchJobId", "revisionHash", '
                ' "sourceSnapshotHash", "policyVersion", "executionStatus", "outcome", '
                ' "attempt", "details", "triggeredBy") '
                'VALUES (%s::uuid, %s, %s, %s, %s, \'fact-review-v1\', \'queued\', NULL, 0, %s::jsonb, \'claim_evidence\')',
                (
                    run_id,
                    task["researchId"],
                    task["originalJobId"],
                    task["revisionHash"],
                    ledger_hash,
                    queued_at,
                ),
            )
            if previous is not None:
                await conn.execute(
                    'INSERT INTO "research_review_decisions" '
                    '("id", "researchReviewRunId", "claimId", "revisionHash", "action", '
                    ' "reason", "metadata", "actorId") '
                    'SELECT gen_random_uuid(), %s::uuid, d."claimId", d."revisionHash", '
                    '       d."action", d."reason", '
                    '       COALESCE(d."metadata", \'{}\'::jsonb) || '
                    '         jsonb_build_object(\'inheritedFromRunId\', %s::text), '
                    '       d."actorId" '
                    'FROM "research_review_decisions" d '
                    'WHERE d."researchReviewRunId" = %s::uuid '
                    '  AND d."revisionHash" = %s AND d."action" = \'accept_uncertainty\'',
                    (run_id, str(previous["id"]), str(previous["id"]), task["revisionHash"]),
                )
            if task["originalJobId"] is not None:
                await conn.execute(
                    'UPDATE "ai_research_jobs" SET "reviewStatus" = \'queued\', '
                    '"reviewAttempts" = 0, "reviewStartedAt" = NULL, "reviewRunToken" = NULL, '
                    '"reviewSummary" = NULL, "reviewClaims" = \'[]\'::jsonb, '
                    '"reviewedAt" = NULL, "reviewDetails" = %s::jsonb WHERE "id" = %s',
                    (queued_at, task["originalJobId"]),
                )
            await conn.execute(
                'UPDATE "researches" SET "reviewStatus" = \'queued\', "reviewAttempts" = 0, '
                '"reviewStartedAt" = NULL, "reviewRunToken" = NULL, "reviewSummary" = NULL, '
                '"reviewClaims" = \'[]\'::jsonb, "reviewedAt" = NULL, '
                '"reviewDetails" = %s::jsonb WHERE "id" = %s',
                (queued_at, task["researchId"]),
            )
            await conn.execute(
                'UPDATE "research_evidence_tasks" SET "status" = \'review_queued\', '
                '"sourceCount" = %s, "reviewRunId" = %s::uuid, "result" = %s::jsonb '
                'WHERE "id" = %s',
                (
                    len(source_rows),
                    run_id,
                    _json_stringify({
                        "sourceCount": len(source_rows),
                        "sourceSnapshotHash": ledger_hash,
                    }),
                    task_id,
                ),
            )
            return True


async def reconcile_pending(pool: Any, *, limit: int = 50) -> int:
    """Reconcile a bounded batch; safe to call repeatedly after restarts."""
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'SELECT t."id" FROM "research_evidence_tasks" t '
                'JOIN "ai_research_jobs" j ON j."id" = t."aiResearchJobId" '
                'WHERE t."status" IN (\'queued\', \'researching\', \'evidence_ready\') '
                '  AND j."status" IN (\'succeeded\', \'partial\', \'failed\', \'cancelled\') '
                'ORDER BY t."createdAt" ASC LIMIT %s',
                (max(1, min(limit, 200)),),
            )
        ).fetchall()
    changed = 0
    for row in rows:
        try:
            changed += int(await reconcile_one(pool, str(row["id"])))
        except Exception:
            logger.warning("evidence task reconciliation failed", exc_info=True, extra={"task_id": str(row["id"])})
    return changed


def _interval_seconds() -> float:
    try:
        value = float(os.environ.get("EVIDENCE_RECONCILIATION_INTERVAL_SECONDS", "2"))
    except (TypeError, ValueError):
        value = 2.0
    return min(max(value, 1.0), 60.0)


async def reconciliation_loop(pool: Any) -> None:
    """Keep evidence handoffs progressing without a browser session."""
    interval = _interval_seconds()
    while True:
        try:
            await reconcile_pending(pool)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("evidence reconciliation loop failed", exc_info=True)
        await asyncio.sleep(interval)


__all__ = [
    "reconcile_one",
    "reconcile_pending",
    "reconciliation_loop",
    "research_revision_hash",
    "source_snapshot_hash",
]
