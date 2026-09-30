"""Fill missing active radar scores without scheduling enrichment work."""
# ruff: noqa: E402

from __future__ import annotations

import argparse
import asyncio
import fcntl
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

PACKAGE_ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, PACKAGE_ROOT)

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.llm.client import is_quota_error
from ai_engine.llm.config import resolve_primary_and_fallback
from ai_engine.radar.candidate_postprocessor import score_missing_candidates
from ai_engine.radar.distilled_scorer import DISTILLED_VERSION, DistilledScore, score_with_llm
from ai_engine.radar.scoring_input import transient_scoring_input


SCOPE = "unscored_only"
TRANSIENT_SCOPE = "unscored_transient_v1"
ARCHIVED_SCOPE = "unscored_transient_including_archived_v1"


def enable_stage_logging() -> None:
    logger = logging.getLogger("ai_engine.radar.distilled_scorer")
    logger.addHandler(logging.StreamHandler(sys.stdout))
    logger.setLevel(logging.INFO)
    logger.propagate = False


def save_state(path: Path, state: dict[str, Any]) -> None:
    state["updated_at"] = time.time()
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n")
    temporary.replace(path)


def quota_wait_seconds(error: Exception, default: float) -> float:
    headers = getattr(getattr(error, "response", None), "headers", {})
    try:
        # A short Retry-After often denotes RPM rather than the plan window.
        return max(default, float(headers.get("retry-after", 0)))
    except (TypeError, ValueError):
        return default


def require_minimax_only() -> None:
    for purpose in ("research", "utility"):
        for tier in ("light", "heavy"):
            primary, fallback = resolve_primary_and_fallback(purpose, tier=tier)
            if primary.vendor != "minimax" or fallback is not None:
                raise RuntimeError("maintenance requires MiniMax-only routes without fallback")


async def current_ids(pool: Any, ids: tuple[str, ...]) -> set[str]:
    if not ids:
        return set()
    async with pool.connection() as conn:
        rows = await (await conn.execute(
            'SELECT "id" FROM summaries WHERE "id" = ANY(%s::uuid[]) '
            'AND "distilledScore" IS NOT NULL',
            (list(ids),),
        )).fetchall()
    return {str(dict(row)["id"]) for row in rows}


async def run_resumable(
    store: Any,
    ids: tuple[str, ...],
    *,
    path: Path,
    timeout: int,
    quota_wait: float,
    concurrency: int = 1,
    transient_external: bool = False,
    include_archived: bool = False,
    retry_unresolved: bool = False,
) -> int:
    require_minimax_only()
    concurrency = max(1, min(concurrency, 5))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if path.exists():
            state = json.loads(path.read_text())
            scope = (
                ARCHIVED_SCOPE if include_archived else
                TRANSIENT_SCOPE if transient_external else SCOPE
            )
            if state["version"] != DISTILLED_VERSION or state.get("scope") != scope:
                raise RuntimeError("checkpoint score version or scope mismatch")
            if retry_unresolved:
                state["unresolved"] = []
        else:
            done = await current_ids(store.pool, ids)
            state = {"version": DISTILLED_VERSION,
                     "scope": ARCHIVED_SCOPE if include_archived else
                              TRANSIENT_SCOPE if transient_external else SCOPE,
                     "targets": [i for i in ids if i not in done],
                     "completed": [], "unresolved": [], "pause_until": 0, "status": "running"}
        save_state(path, state)
        while True:
            pending = [i for i in state["targets"]
                       if i not in state["completed"] and i not in state["unresolved"]]
            if not pending:
                state["status"] = "completed_with_unresolved" if state["unresolved"] else "completed"
                save_state(path, state)
                print(f'complete scored={len(state["completed"])} unresolved={len(state["unresolved"])}', flush=True)
                return 2 if state["unresolved"] else 0
            delay = state["pause_until"] - time.time()
            if delay > 0:
                state["status"] = "quota_paused"
                save_state(path, state)
                print(f'quota_paused next_probe_in={min(delay, 900):.0f}s remaining={len(pending)}', flush=True)
                await asyncio.sleep(min(delay, 900))
                state["pause_until"] = 0
                state["status"] = "running"
                save_state(path, state)
                continue

            batch = pending[:concurrency]
            state["status"] = "running"
            state["pause_until"] = 0
            save_state(path, state)

            async def score_target(
                target: str,
            ) -> tuple[str, str, str | None, Exception | None]:
                if target in await current_ids(store.pool, (target,)):
                    return target, "completed", None, None

                quota_error: Exception | None = None
                error_kind: str | None = None

                async def bounded_score(
                    title: str,
                    content: str,
                    **kwargs: Any,
                ) -> DistilledScore:
                    nonlocal quota_error, error_kind
                    try:
                        return await asyncio.wait_for(
                            score_with_llm(
                                title,
                                content,
                                raise_on_error=True,
                                **kwargs,
                            ),
                            timeout=timeout,
                        )
                    except Exception as exc:
                        error_kind = type(exc).__name__
                        if is_quota_error(exc):
                            quota_error = exc
                        raise

                try:
                    await score_missing_candidates(
                        store.pool,
                        limit=1,
                        summary_ids=(target,),
                        rescore=False,
                        suppress_enrichment=True,
                        concurrency=1,
                        scorer=bounded_score,
                        only_unscored=True,
                        transient_input=transient_scoring_input if transient_external else None,
                        include_archived=include_archived,
                    )
                except Exception as exc:
                    error_kind = type(exc).__name__
                    if is_quota_error(exc):
                        quota_error = exc
                if target in await current_ids(store.pool, (target,)):
                    return target, "completed", error_kind, None
                if quota_error is not None:
                    return target, "quota", error_kind, quota_error
                return target, "unresolved", error_kind, None

            def record_result(
                result: tuple[str, str, str | None, Exception | None],
            ) -> bool:
                target, outcome, error_kind, quota_error = result
                if error_kind is not None:
                    state["last_error_kind"] = error_kind
                elif state["status"] != "quota_paused":
                    state["last_error_kind"] = None
                if outcome == "completed":
                    if target not in state["completed"]:
                        state["completed"].append(target)
                elif outcome == "unresolved":
                    if target not in state["unresolved"]:
                        state["unresolved"].append(target)
                else:
                    assert quota_error is not None
                    pause_until = time.time() + quota_wait_seconds(quota_error, quota_wait)
                    state["pause_until"] = max(state["pause_until"], pause_until)
                    state["status"] = "quota_paused"
                save_state(path, state)
                print(
                    f'progress scored={len(state["completed"])} '
                    f'unresolved={len(state["unresolved"])} targets={len(state["targets"])} '
                    f'status={state["status"]} error={error_kind}',
                    flush=True,
                )
                return outcome == "quota"

            print(f"batch_start count={len(batch)} concurrency={concurrency}", flush=True)
            tasks = {asyncio.create_task(score_target(target)): target for target in batch}
            pending_tasks = set(tasks)
            recorded: set[asyncio.Task[Any]] = set()
            quota_detected = False

            while pending_tasks and not quota_detected:
                finished, pending_tasks = await asyncio.wait(
                    pending_tasks,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in finished:
                    recorded.add(task)
                    quota_detected = record_result(task.result()) or quota_detected
                    if quota_detected:
                        break

            if quota_detected:
                for task in pending_tasks:
                    task.cancel()
                if pending_tasks:
                    await asyncio.gather(*pending_tasks, return_exceptions=True)
                for task in tasks:
                    if task in recorded or task.cancelled():
                        continue
                    record_result(task.result())


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fill unscored active radar candidates without enrichment",
    )
    parser.add_argument("--limit", type=int, default=5_000)
    parser.add_argument("--batch-size", type=int, default=10)
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--timeout-seconds", type=int, default=180)
    parser.add_argument("--source-type", default=None)
    parser.add_argument("--summary-id", action="append", default=[])
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--state-file", type=Path)
    parser.add_argument("--minimax-only", action="store_true")
    parser.add_argument("--quota-wait-seconds", type=float, default=5 * 3600)
    parser.add_argument("--transient-external", action="store_true")
    parser.add_argument("--include-archived", action="store_true")
    parser.add_argument("--retry-unresolved", action="store_true")
    args = parser.parse_args()
    if args.minimax_only != bool(args.state_file):
        parser.error("--minimax-only and --state-file must be used together")
    if args.quota_wait_seconds < 1:
        parser.error("--quota-wait-seconds must be positive")
    if args.transient_external and not args.minimax_only:
        parser.error("--transient-external requires --minimax-only and --state-file")
    if args.include_archived and not args.transient_external:
        parser.error("--include-archived requires --transient-external")

    limit = max(1, min(args.limit, 10_000))
    concurrency = max(1, min(args.concurrency, 5))
    batch_size = concurrency if args.minimax_only else max(1, min(args.batch_size, 25))
    timeout_seconds = max(30, args.timeout_seconds)
    source_filter = ""
    statuses = (
        "('candidate', 'published', 'archived')"
        if args.include_archived else "('candidate', 'published')"
    )
    query_params: tuple[object, ...] = (limit,)
    if args.source_type:
        source_filter = (
            'AND COALESCE(rs."sourceType", CASE '
            'WHEN s."source" = \'user\' THEN \'web_share\' ELSE \'rss\' END) = %s '
        )
        query_params = (args.source_type, limit)
    if args.summary_id:
        source_filter += 'AND s."id" = ANY(%s::uuid[]) '
        query_params = (*query_params[:-1], args.summary_id, query_params[-1])

    load_dotenv()
    enable_stage_logging()
    store = DbJobStore(dsn=os.environ["DATABASE_URL"])
    await store.open()
    try:
        async with store.pool.connection() as conn:
            rows = await (
                await conn.execute(
                    'SELECT s."id" FROM "summaries" s '
                    'LEFT JOIN "radar_sync_runs" rr ON rr."id" = s."syncRunId" '
                    'LEFT JOIN "radar_sources" rs ON rs."id" = rr."sourceId" '
                    f'WHERE s."status" IN {statuses} '
                    'AND s."distilledScore" IS NULL '
                    'AND ((s."source" = \'daily\' AND s."syncRunId" IS NOT NULL) '
                    'OR (s."source" = \'user\' AND s."status" IN '
                    '(\'candidate\', \'published\') AND EXISTS ('
                    'SELECT 1 FROM "share_submissions" sh '
                    'WHERE sh."publishedSummaryId" = s."id" '
                    'AND sh."status" = \'approved\'))) '
                    + source_filter
                    + "ORDER BY CASE WHEN s.\"status\" = 'archived' THEN 1 ELSE 0 END, "
                    's."createdAt" DESC, s."id" ASC LIMIT %s',
                    query_params,
                )
            ).fetchall()
        ids = tuple(str(dict(row)["id"]) for row in rows)
        source_label = args.source_type or "all"
        print(
            f"active_targets={len(ids)} source_type={source_label} "
            f"batch_size={batch_size} concurrency={concurrency}",
            flush=True,
        )
        if not ids or args.dry_run:
            return 0
        if args.minimax_only:
            return await run_resumable(
                store, ids, path=args.state_file, timeout=timeout_seconds,
                quota_wait=args.quota_wait_seconds, concurrency=concurrency,
                transient_external=args.transient_external,
                include_archived=args.include_archived,
                retry_unresolved=args.retry_unresolved,
            )

        async def bounded_score(
            title: str,
            content: str,
            **kwargs: Any,
        ) -> DistilledScore:
            return await asyncio.wait_for(
                score_with_llm(title, content, **kwargs),
                timeout=timeout_seconds,
            )

        scored_total = 0
        unresolved_total = 0
        for start in range(0, len(ids), batch_size):
            batch = ids[start : start + batch_size]
            scored = await score_missing_candidates(
                store.pool,
                limit=len(batch),
                summary_ids=batch,
                rescore=False,
                suppress_enrichment=True,
                concurrency=concurrency,
                scorer=bounded_score,
                only_unscored=True,
                transient_input=transient_scoring_input if args.transient_external else None,
            )
            unresolved = len(batch) - scored
            scored_total += scored
            unresolved_total += unresolved
            print(
                f"batch={start // batch_size + 1} targets={len(batch)} "
                f"scored={scored} unresolved={unresolved} "
                f"total_scored={scored_total}",
                flush=True,
            )

        print(
            f"complete targets={len(ids)} scored={scored_total} "
            f"unresolved={unresolved_total}",
            flush=True,
        )
        return 0
    finally:
        await store.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
