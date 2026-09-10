"""Server package — FastAPI app + middleware + routes.

Endpoint surface (Week 2):

- `GET  /healthz` — liveness; returns adapter health + service identity.
- `GET  /health`  — backward-compat alias of `/healthz`.
- `POST /api/ai/jobs` — submit an AI research job; returns 202 within 2s
  with a job id and `status="queued"`. Client polls `GET /api/ai/jobs/{id}`
  every 5s for `current_step` / `final_status` / cost. Mirrors
  ARCHITECTURE §七 "POST /api/ai-research".
- `GET  /api/ai/jobs/{job_id}` — read job status.
- `POST /api/ai/jobs/{job_id}/cancel` — cancel a queued or running job.

Week 1 review 修正：原版在 HTTP 请求内 `await run_one_available_job(...)`,
真实 LLM 接入后时延可达 5 分钟，会把 HTTP 连接耗尽。Week 2 起改 fire-and-forget
后台 task，HTTP 立即返回 202 + queued。Runner 真实 DB 接入留到 Week 2 runner
（实施计划 §四 160 行：PostgreSQL shared runner）。
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
import re
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from contextlib import asynccontextmanager, suppress
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, cast
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import structlog
import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Path, Query, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ai_engine.adapters.base import AdapterSource, ResearchEngineAdapter, build_adapter
from ai_engine.adapters.fake import FakeAdapter
from ai_engine.contracts.errors import AdapterError, ERROR_CODES, HTTP_STATUS
from ai_engine.contracts.states import (
    AI_JOB_STATUS,
    AI_JOB_STEP,
    CREATION_METHOD,
    REPORT_TYPE,
    SOURCE_POLICY,
    AiJobStatus,
    ReportType,
    SourcePolicy,
)
from ai_engine.job_runner.runner import run_one_available_job
from ai_engine.job_runner.store import (
    JobRowView,
    JobStore,
    build_store,
    make_job_snapshot,
)
from ai_engine.job_runner.models import JobSnapshot, ReviewWorkItem
from ai_engine.reviewer import ClaimVerdict
from ai_engine.llm.client import generate_text
from ai_engine.llm.config import config_snapshot, resolve_spec
from ai_engine.llm.usage_audit import LlmUsageAttempt, record_llm_usage

load_dotenv()

logger = logging.getLogger("ai_engine.server")
structlog.configure(
    processors=[
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
)


def _json_int(value: object, default: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return default
    return default


def _json_str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def _clip_db_text(value: str | None, limit: int) -> str | None:
    """Fit source metadata into the shared Prisma varchar contract."""
    if value is None:
        return None
    if len(value) <= limit:
        return value
    suffix = "…"
    return f"{value[: max(0, limit - len(suffix))].rstrip()}{suffix}"


def _review_source_snapshot_hash(sources: tuple[AdapterSource, ...]) -> str:
    """Hash the exact evidence metadata handed to a fact reviewer.

    The hash is an audit coordinate, not a quality score.  Keep ordering and
    the captured excerpt in the snapshot so a later review can explain which
    evidence set it actually saw.
    """
    payload = [
        {
            "canonicalKey": source.canonical_key,
            "sourceRef": source.source_ref,
            "title": source.title,
            "snippet": source.snippet,
        }
        for source in sorted(sources, key=lambda item: item.canonical_key)
    ]
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _merge_auto_radar_refs(
    auto_refs: tuple[dict[str, str | bool], ...],
    resolved_refs: tuple[dict[str, str | bool], ...],
) -> tuple[dict[str, str | bool], ...]:
    """Append explicitly requested automatic radar context.

    This helper remains available for an explicit opt-in flow, but normal
    research submission must not call it: an empty "资料范围" selection
    means the user chose web search without silently adding project history.
    """
    user_keys = {
        (str(ref.get("type")), str(ref.get("value")))
        for ref in resolved_refs
    }
    auto = tuple(
        ref for ref in auto_refs
        if (str(ref.get("type")), str(ref.get("value"))) not in user_keys
    )
    return resolved_refs + auto


def _is_idempotency_replay(existing: JobRowView | None, requested_job_id: str) -> bool:
    """Distinguish a real replay from the Web BFF's pre-created queue row.

    The Web BFF creates ``ai_research_jobs`` before forwarding the request so
    it can attach product events and conversation metadata.  Consequently,
    the first engine request can find its own queued row through the unique
    idempotency key.  That row still needs hydration and enqueueing; only a
    different job id (or a row that has already moved past queued) is a replay.
    """
    if existing is None:
        return False
    snapshot = existing.snapshot
    return snapshot.job_id != requested_job_id or snapshot.status != "queued"


# ──────────────────────────────────────────────────────────────────────
# App factory
# ──────────────────────────────────────────────────────────────────────


@asynccontextmanager
async def _lifespan(app_instance: FastAPI) -> AsyncIterator[None]:
    structlog.get_logger("ai_engine.server").info(
        "ai-engine.boot",
        extra={"adapter": os.environ.get("AI_ENGINE_ADAPTER", "gpt_researcher")},
    )
    # W2 review 修正:process-level store singleton,所有 endpoint / 后台
    # task 共享同一个 instance。否则每次请求新建,POST 写进去的 job 在
    # 下一个 GET 不可见。lifespan 创建并绑定到 app.state.job_store。
    store = build_store()
    app_instance.state.job_store = store
    # Start the process-level DB pool once. Radar routes and the share
    # submission worker reuse this pool; HTTP handlers only enqueue work.
    from ai_engine.job_runner.db_store import DbJobStore
    share_worker_task: asyncio.Task[None] | None = None
    ai_job_worker_task: asyncio.Task[None] | None = None
    fact_review_worker_task: asyncio.Task[None] | None = None
    import_worker_task: asyncio.Task[None] | None = None
    radar_sync_task: asyncio.Task[None] | None = None
    submission_task: asyncio.Task[None] | None = None
    topic_proposal_task: asyncio.Task[None] | None = None
    topic_synth_task: asyncio.Task[None] | None = None
    topic_issue_task: asyncio.Task[None] | None = None
    enrichment_recovery_task: asyncio.Task[None] | None = None
    llm_recovery_task: asyncio.Task[None] | None = None
    render_review_task: asyncio.Task[None] | None = None
    review_reconciliation_task: asyncio.Task[None] | None = None
    evidence_reconciliation_task: asyncio.Task[None] | None = None
    # asyncio tasks can start immediately, so publish the adapter before any
    # worker reads app.state.adapter.
    app_instance.state.adapter = build_adapter()
    if isinstance(store, DbJobStore):
        await store.open()
        app_instance.state.db_pool = store.pool
        app_instance.state.radar_sync_lock = asyncio.Lock()
        await store.start_reaper()
        if os.environ.get("SHARE_WORKER_ENABLED", "1") == "1":
            share_worker_task = asyncio.create_task(
                _share_submission_worker_loop(app_instance),
                name="share-submission-worker",
            )
        if os.environ.get("AI_JOB_WORKER_ENABLED", "1") == "1":
            ai_job_worker_task = asyncio.create_task(
                _ai_job_worker_loop(app_instance),
                name="ai-job-worker",
            )
        if os.environ.get("FACT_REVIEW_WORKER_ENABLED", "1") == "1":
            fact_review_worker_task = asyncio.create_task(
                _fact_review_worker_loop(app_instance),
                name="fact-review-worker",
            )
        if os.environ.get("EVIDENCE_RECONCILIATION_ENABLED", "1") == "1":
            evidence_reconciliation_task = asyncio.create_task(
                _evidence_reconciliation_loop(app_instance),
                name="evidence-reconciliation-worker",
            )
        if os.environ.get("IMPORT_WORKER_ENABLED", "1") == "1":
            import_worker_task = asyncio.create_task(
                _import_worker_loop(),
                name="content-import-worker",
            )
        if os.environ.get("RADAR_SYNC_CRON_ENABLED", "1") == "1":
            radar_sync_task = asyncio.create_task(
                _radar_sync_loop(app_instance),
                name="radar-sync-cron",
            )
        if os.environ.get("RADAR_ENRICHMENT_RECOVERY_ENABLED", "1") == "1":
            enrichment_recovery_task = asyncio.create_task(
                _enrichment_recovery_loop(app_instance),
                name="radar-enrichment-recovery",
            )
        if os.environ.get("LLM_RECOVERY_ENABLED", "1") == "1":
            llm_recovery_task = asyncio.create_task(
                _llm_recovery_loop(app_instance),
                name="llm-recovery",
            )
        if os.environ.get("RADAR_RENDER_REVIEW_ENABLED", "1") == "1":
            render_review_task = asyncio.create_task(
                _render_review_loop(app_instance),
                name="radar-render-review",
            )
        if os.environ.get("RADAR_REVIEW_RECONCILIATION_ENABLED", "1") == "1":
            review_reconciliation_task = asyncio.create_task(
                _review_reconciliation_loop(app_instance),
                name="radar-review-reconciliation",
            )
        # P1-B: submission worker
        if os.environ.get("SUBMISSION_WORKER_ENABLED", "1") == "1":
            submission_task = asyncio.create_task(
                _submission_worker_loop(app_instance),
                name="radar-submission-worker",
            )
        # P1-D: existing topics refresh after the radar pipeline; proposal
        # generation is a separate daily cron for Admin review only.
        if os.environ.get("TOPIC_PROPOSAL_ENABLED", "1") == "1":
            topic_proposal_task = asyncio.create_task(
                _topic_proposal_loop(app_instance),
                name="radar-topic-proposals",
            )
        # Synthesis remains a separate five-minute worker.
        if os.environ.get("TOPIC_SYNTHESIS_ENABLED", "1") == "1":
            topic_synth_task = asyncio.create_task(
                _topic_synthesis_loop(app_instance),
                name="radar-topic-synthesis",
            )
        if os.environ.get("TOPIC_ISSUE_ENABLED", "1") == "1":
            topic_issue_task = asyncio.create_task(
                _topic_issue_loop(app_instance),
                name="radar-topic-issues",
            )
    try:
        yield
    finally:
        if share_worker_task is not None:
            share_worker_task.cancel()
            with suppress(asyncio.CancelledError):
                await share_worker_task
        if ai_job_worker_task is not None:
            ai_job_worker_task.cancel()
            with suppress(asyncio.CancelledError):
                await ai_job_worker_task
        if fact_review_worker_task is not None:
            fact_review_worker_task.cancel()
            with suppress(asyncio.CancelledError):
                await fact_review_worker_task
        if evidence_reconciliation_task is not None:
            evidence_reconciliation_task.cancel()
            with suppress(asyncio.CancelledError):
                await evidence_reconciliation_task
        if import_worker_task is not None:
            import_worker_task.cancel()
            with suppress(asyncio.CancelledError):
                await import_worker_task
        if radar_sync_task is not None:
            radar_sync_task.cancel()
            with suppress(asyncio.CancelledError):
                await radar_sync_task
        if submission_task is not None:
            submission_task.cancel()
            with suppress(asyncio.CancelledError):
                await submission_task
        if topic_proposal_task is not None:
            topic_proposal_task.cancel()
            with suppress(asyncio.CancelledError):
                await topic_proposal_task
        if topic_synth_task is not None:
            topic_synth_task.cancel()
            with suppress(asyncio.CancelledError):
                await topic_synth_task
        if topic_issue_task is not None:
            topic_issue_task.cancel()
            with suppress(asyncio.CancelledError):
                await topic_issue_task
        if enrichment_recovery_task is not None:
            enrichment_recovery_task.cancel()
            with suppress(asyncio.CancelledError):
                await enrichment_recovery_task
        if llm_recovery_task is not None:
            llm_recovery_task.cancel()
            with suppress(asyncio.CancelledError):
                await llm_recovery_task
        if render_review_task is not None:
            render_review_task.cancel()
            with suppress(asyncio.CancelledError):
                await render_review_task
        if review_reconciliation_task is not None:
            review_reconciliation_task.cancel()
            with suppress(asyncio.CancelledError):
                await review_reconciliation_task
        if isinstance(store, DbJobStore):
            try:
                from ai_engine.radar.enrichment_worker import release_enrichment_leases

                released = await release_enrichment_leases(store.pool)
                if released:
                    structlog.get_logger("ai_engine.server").info(
                        "ai-engine.radar.enrichment.leases_released",
                        released=released,
                    )
            except Exception:
                structlog.get_logger("ai_engine.server").warning(
                    "ai-engine.radar.enrichment.lease_release_failed",
                    exc_info=True,
                )
            await store.close()
    structlog.get_logger("ai_engine.server").info("ai-engine.shutdown")


import os  # noqa: E402  (kept here to keep import block visually grouped)


async def _share_submission_worker_loop(app_instance: FastAPI) -> None:
    """Poll frozen share_submissions without blocking request handlers."""
    from ai_engine.share_submission_worker import run_one_share_submission

    while True:
        try:
            result = await run_one_share_submission(
                app_instance.state.db_pool,
                app_instance.state.adapter,
                worker_id=f"share-{os.getpid()}",
            )
            if result is None:
                await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            structlog.get_logger("ai_engine.share_submission").error(
                "ai-engine.share_submission.loop_failed",
                error_type=type(exc).__name__,
            )
            await asyncio.sleep(1.0)


async def _ai_job_worker_loop(app_instance: FastAPI) -> None:
    """Poll ai_research_jobs every 1s, acquire+run one job at a time.

    Mirrors share_submission loop — single acquire+run per iteration;
    returns after each job so failures never block the entire queue.
    """
    store: JobStore = app_instance.state.job_store
    adapter: ResearchEngineAdapter = app_instance.state.adapter
    logger = structlog.get_logger("ai_engine.worker")
    wid = f"ai-worker-{os.getpid()}"
    while True:
        try:
            await store.open()
            outcome = await run_one_available_job(
                store=store,
                adapter=adapter,
                worker_id=wid,
                draft_factory=_make_draft_factory(store),
            )
            if outcome is None:
                await asyncio.sleep(1.0)
            else:
                logger.info(
                    "ai-engine.worker.done",
                    job_id=outcome.job_id,
                    final_status=outcome.final_status,
                    cost_cents=outcome.cost.cost_cents,
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "ai-engine.worker.loop_failed",
                exc_info=True,
                error_type=type(exc).__name__,
                error_message=str(exc)[:300],
            )
            await asyncio.sleep(1.0)


def _fact_review_timeout_seconds() -> int:
    """Bound one independent review attempt; it must not hold the job queue."""
    try:
        value = int(os.environ.get("FACT_REVIEW_TIMEOUT_SECONDS", "180"))
    except (TypeError, ValueError):
        value = 180
    return min(max(value, 30), 600)


def _fact_review_heartbeat_seconds(store: JobStore) -> float:
    """Use the store's lease cadence without coupling the worker to DB types."""
    configured = getattr(store, "_review_heartbeat_seconds", 15)
    try:
        return max(5.0, float(configured))
    except (TypeError, ValueError):
        return 15.0


async def _review_heartbeat_loop(store: JobStore, work: ReviewWorkItem) -> None:
    """Keep an active review claim alive; expiry remains crash recovery."""
    review_logger = structlog.get_logger("ai_engine.fact_review")
    while True:
        await asyncio.sleep(_fact_review_heartbeat_seconds(store))
        try:
            renewed = await store.heartbeat_review(work)
        except Exception:  # pragma: no cover - defensive worker boundary
            review_logger.warning(
                "ai-engine.fact-review.heartbeat_failed",
                exc_info=True,
                review_run_id=work.review_run_id,
            )
            return
        if not renewed:
            review_logger.warning(
                "ai-engine.fact-review.lease_lost",
                review_run_id=work.review_run_id,
            )
            return


def _claims_from_review_inventory(
    checkpoints: Mapping[str, object],
) -> tuple["ClaimVerdict", ...]:
    """Recover settled batch rows and unresolved inventory claim rows.

    Inventory is not evidence. It is the last reliable boundary before the
    slower adjudication call. Keeping both the inventory and the settled
    batch rows on timeout lets the UI preserve successful work while saying
    "identified, not judged" for the active/failed batch.
    """
    from ai_engine.reviewer import _parse_review_payload

    phase_payload = checkpoints.get("adjudicating")
    if not isinstance(phase_payload, dict):
        return ()
    raw_inventory = phase_payload.get("inventory")
    if not isinstance(raw_inventory, list):
        return ()
    settled_by_id: dict[str, ClaimVerdict] = {}
    raw_settled = phase_payload.get("settled_claims")
    if isinstance(raw_settled, list):
        parsed_settled = _parse_review_payload({"claims": raw_settled})
        settled_by_id = {
            claim.claim_id: claim
            for claim in parsed_settled.claims
            if claim.claim_id
        }
    claims: list[ClaimVerdict] = []
    for raw in raw_inventory:
        if not isinstance(raw, dict):
            continue
        claim_id = raw.get("claim_id")
        claim_text = raw.get("claim")
        if (
            not isinstance(claim_id, str)
            or not claim_id.strip()
            or not isinstance(claim_text, str)
            or not claim_text.strip()
        ):
            continue
        claim_type = raw.get("claim_type")
        if claim_type not in {"external_fact", "research_process", "interpretation", "citation_relationship"}:
            claim_type = "external_fact"
        risk = raw.get("risk")
        if risk not in {"high", "medium", "low", "opinion"}:
            risk = "medium"
        is_fact = claim_type == "external_fact" and risk != "opinion"
        settled = settled_by_id.get(claim_id.strip())
        if settled is not None:
            claims.append(ClaimVerdict(
                claim_id=claim_id.strip(),
                claim=claim_text.strip(),
                risk=cast(Any, risk),
                verdict=settled.verdict,
                evidence=settled.evidence,
                correction=settled.correction,
                reason=settled.reason,
                judgment_status=settled.judgment_status,
                execution_error_code=settled.execution_error_code,
                location=settled.location,
                claim_type=cast(Any, claim_type),
            ))
            continue
        claims.append(ClaimVerdict(
            claim_id=claim_id.strip(),
            claim=claim_text.strip(),
            risk=cast(Any, risk),
            verdict="unverified" if is_fact else "not_applicable",
            evidence=None,
            reason=(
                "审核在逐条判断证据前中断；这条声明已被识别，但尚未判断为真或假。"
                if is_fact
                else "这条内容属于研究过程、观点或引用关系，不进入事实发布门禁。"
            ),
            judgment_status="not_judged" if is_fact else "settled",
            execution_error_code="review_interrupted" if is_fact else None,
            claim_type=cast(Any, claim_type),
        ))
    return tuple(claims)


def _claim_evidence_relation(value: Mapping[str, object] | ClaimVerdict) -> str:
    """Reduce a claim to the evidence relation used for second-opinion diffing."""
    judgment_status = (
        value.judgment_status if isinstance(value, ClaimVerdict) else value.get("judgment_status")
    )
    if judgment_status in {"not_judged", "execution_failed", "disputed"}:
        return "unsettled"
    verdict = value.verdict if isinstance(value, ClaimVerdict) else value.get("verdict")
    evidence = value.evidence if isinstance(value, ClaimVerdict) else value.get("evidence")
    has_excerpt = bool(
        evidence.excerpt.strip()
        if hasattr(evidence, "excerpt") and isinstance(evidence.excerpt, str)
        else isinstance(evidence, dict) and isinstance(evidence.get("excerpt"), str) and evidence.get("excerpt", "").strip()
    )
    normalized = str(verdict or "").lower()
    if normalized in {"supported", "verified", "pass"} and has_excerpt:
        return "supported"
    if normalized in {"contradicted", "conflict", "correctable"}:
        return "contradicted"
    return "unverified"


async def _review_one_item(store: JobStore, work: ReviewWorkItem) -> None:
    """Run one claim review and commit only the review snapshot.

    The report body is intentionally not passed to a repair writer here.  A
    fact review is an assessment artifact; changing the research requires an
    explicit user revision and a new review of that revision.
    """
    from ai_engine.reviewer import (
        DefaultResearchReviewer,
        ReviewResult,
        _citation_ledger,
    )
    review_logger = structlog.get_logger("ai_engine.fact_review")
    heartbeat_task = asyncio.create_task(
        _review_heartbeat_loop(store, work),
        name=f"fact-review-heartbeat-{work.review_run_id or work.job_id}",
    )

    try:
        # A review is a workflow, not a single opaque model call. Persist the
        # cheap deterministic checkpoints first so a page refresh can explain
        # what the worker actually reached, and a crash can be retried without
        # presenting the report as factually wrong.
        checkpoint_review = getattr(store, "checkpoint_review", None)
        workflow_checkpoints: dict[str, object] = {}
        phase_order = {
            "inventorying": 0,
            "adjudicating": 1,
            "matching": 2,
            "conflict_check": 3,
        }

        async def checkpoint(payload: dict[str, object]) -> None:
            phase = payload.get("phase")
            previous_phase = workflow_checkpoints.get("phase")
            current_rank = phase_order.get(phase) if isinstance(phase, str) else None
            previous_rank = phase_order.get(previous_phase) if isinstance(previous_phase, str) else None
            if current_rank is not None and previous_rank is not None and current_rank < previous_rank:
                # A final summary can arrive after the reviewer already
                # reported a later phase. Keep its metrics, but do not move
                # the visible workflow backwards.
                workflow_checkpoints.update({
                    key: value for key, value in payload.items() if key != "phase"
                })
                return
            workflow_checkpoints.update(payload)
            # A reviewer may report a richer payload for the same phase after
            # the initial worker checkpoint. The adjudication phase reports
            # one event per independent batch, so persist same-phase updates
            # as well; otherwise a crash during batch 3 would leave the UI
            # believing that only batch 1 ever started.
            if phase == previous_phase and phase != "adjudicating":
                return
            if not callable(checkpoint_review):
                return
            try:
                await checkpoint_review(work, payload)
            except Exception:  # pragma: no cover - diagnostic boundary
                review_logger.warning(
                    "ai-engine.fact-review.checkpoint_failed",
                    exc_info=True,
                    review_run_id=work.review_run_id,
                    phase=payload.get("phase"),
                )

        captured_sources = [
            source for source in work.sources
            if isinstance(source.snippet, str) and source.snippet.strip()
        ]
        await checkpoint({
            "phase": "inventorying",
            "inventory": {
                "report_chars": len(work.report),
                "source_count": len(work.sources),
                "captured_source_count": len(captured_sources),
                "source_snapshot_hash": work.source_snapshot_hash,
            },
        })
        async def review_progress(phase: str, payload: dict[str, object]) -> None:
            await checkpoint({"phase": phase, phase: payload})

        try:
            reviewer_llm = os.environ.get("FACT_REVIEWER_LLM")
            if work.review_mode == "evidence_challenge":
                # An explicit challenge model is optional. When omitted, the
                # same provider may be used for a second call, but the
                # strategy is still independent and is recorded below.
                reviewer_llm = os.environ.get("FACT_CHALLENGE_REVIEWER_LLM") or reviewer_llm
            reviewer = DefaultResearchReviewer(
                llm_spec=resolve_spec("utility", explicit=reviewer_llm),
            )
            if work.review_mode == "evidence_challenge" and work.target_claim:
                target = work.target_claim
                target_claim_id = target.get("claim_id")
                target_claim_text = target.get("claim")
                target_risk = target.get("risk")
                if not isinstance(target_claim_id, str) or not isinstance(target_claim_text, str):
                    raise ValueError("evidence challenge target claim is incomplete")
                if target_risk not in {"high", "medium", "low", "opinion"}:
                    target_risk = "medium"
                result = await asyncio.wait_for(
                    reviewer.challenge_support(
                        work.report,
                        work.sources,
                        work.topic,
                        report_type=work.report_type,
                        claim_id=target_claim_id,
                        claim=target_claim_text,
                        risk=cast(Any, target_risk),
                        phase_callback=review_progress,
                    ),
                    timeout=_fact_review_timeout_seconds(),
                )
                if result.claims:
                    challenged = result.claims[0]
                    previous_relation = _claim_evidence_relation(target)
                    second_relation = _claim_evidence_relation(challenged)
                    if (
                        previous_relation != "unsettled"
                        and second_relation != "unsettled"
                        and previous_relation != second_relation
                    ):
                        challenged = replace(
                            challenged,
                            judgment_status="disputed",
                            execution_error_code=None,
                            reason="原审核与独立复核对这条声明的证据关系不一致；系统不会替你判定真伪。",
                        )
                        result = replace(
                            result,
                            status="needs_revision",
                            claims=(challenged,),
                            error=None,
                            error_code=None,
                            coverage_status="complete",
                        )
            else:
                result = await asyncio.wait_for(
                    reviewer.review(
                        work.report,
                        work.sources,
                        work.topic,
                        report_type=work.report_type,
                        phase_callback=review_progress,
                    ),
                    timeout=_fact_review_timeout_seconds(),
                )
        except asyncio.TimeoutError:
            checkpoint_claims = _claims_from_review_inventory(workflow_checkpoints)
            result = ReviewResult(
                "review_unavailable",
                claims=(*checkpoint_claims, *_citation_ledger(work.report, work.sources)),
                error="事实审核超时，已保留待核验状态",
                error_code="timeout",
                attempts=work.attempts,
                coverage_status="insufficient",
            )
        except Exception as exc:  # pragma: no cover - defensive worker boundary
            review_logger.warning(
                "ai-engine.fact-review.failed",
                exc_info=True,
                job_id=work.job_id,
                error_type=type(exc).__name__,
            )
            checkpoint_claims = _claims_from_review_inventory(workflow_checkpoints)
            result = ReviewResult(
                "review_unavailable",
                claims=(*checkpoint_claims, *_citation_ledger(work.report, work.sources)),
                error=f"{type(exc).__name__}: reviewer unavailable",
                error_code="provider_unavailable",
                attempts=work.attempts,
                coverage_status="insufficient",
            )

        await checkpoint({
            "phase": "matching",
            "matching": {
                "claim_count": len(result.claims),
                "evidence_binding_repaired_count": result.evidence_binding_repaired_count,
                "completed_at": datetime.now(timezone.utc).isoformat(),
            },
        })
        await checkpoint({
            "phase": "conflict_check",
            "conflict_check": {
                "claim_count": len(result.claims),
                "factual_claim_count": result.factual_claim_count,
                "contradicted_count": result.contradicted_count,
                "unverified_count": result.unverified_count,
                "not_judged_count": result.not_judged_count,
                "execution_failed_claim_count": result.execution_failed_claim_count,
                "disputed_count": result.disputed_count,
                "completed_at": datetime.now(timezone.utc).isoformat(),
            },
        })
        details = result.to_dict()
        # Keep the phase evidence alongside the terminal verdict.  The
        # checkpoint row is the recoverability record; replacing it with only
        # the final model payload would make a completed review opaque again.
        details.update(workflow_checkpoints)
        details["phase"] = "completed"
        details["attempts"] = work.attempts
        # Keep the operational failure class explicit in the durable snapshot.
        # Older rows only carried the human-readable error, which made timeout
        # and parser failures indistinguishable in the recovery UI.
        details["error_code"] = result.error_code
        details["review_mode"] = work.review_mode
        if work.review_mode == "evidence_challenge":
            details["review_strategy"] = "independent_second_opinion"
            details["challenge_model_configured"] = bool(os.environ.get("FACT_CHALLENGE_REVIEWER_LLM"))
        await store.complete_review(work, details)
    finally:
        heartbeat_task.cancel()
        with suppress(asyncio.CancelledError):
            await heartbeat_task


async def _fact_review_worker_loop(app_instance: FastAPI) -> None:
    """Recover and process review work independently from research jobs."""
    store: JobStore = app_instance.state.job_store
    review_logger = structlog.get_logger("ai_engine.fact_review")
    worker_id = f"fact-review-{os.getpid()}"
    while True:
        try:
            await store.open()
            work = await store.claim_next_review(worker_id)
            if work is None:
                await asyncio.sleep(1.0)
                continue
            await _review_one_item(store, work)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            review_logger.warning(
                "ai-engine.fact-review.loop_failed",
                exc_info=True,
                error_type=type(exc).__name__,
            )
            await asyncio.sleep(1.0)


async def _import_worker_loop() -> None:
    """Continuously consume content_import_jobs with a dedicated DB store."""
    from ai_engine.import_worker import run_one_import_job
    from ai_engine.job_runner.db_store import IMPORT_TABLE, DbJobStore

    log = structlog.get_logger("ai_engine.import_worker")
    poll_seconds = float(os.environ.get("IMPORT_WORKER_POLL_SECONDS", "1"))
    store = DbJobStore(table_name=IMPORT_TABLE)
    try:
        await store.open()
        await store.start_reaper()
        while True:
            try:
                job_id = await run_one_import_job(
                    store,
                    worker_id=f"import-{os.getpid()}",
                )
                if job_id is None:
                    await asyncio.sleep(poll_seconds)
                else:
                    log.info("ai-engine.import_worker.done", job_id=job_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.warning("ai-engine.import_worker.loop_failed", exc_info=True)
                await asyncio.sleep(poll_seconds)
    finally:
        await store.close()


def _seconds_until_next_radar_window(
    schedule: str,
    tz: ZoneInfo,
    *,
    now: datetime | None = None,
) -> float:
    """Seconds until the next daily HH:MM window in ``tz`` (Asia/Shanghai)."""
    try:
        hour_s, _, minute_s = schedule.partition(":")
        hour = int(hour_s)
        minute = int(minute_s)
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            raise ValueError
    except ValueError:
        hour, minute = 8, 0
    now = now or datetime.now(tz)
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


# P1.6: tiered polling intervals.
# Per-source-type default cadence (minutes) — overrides live in
# radar_sources.config["pollingIntervalMinutes"] when set, otherwise the
# tier default applies. ``hot`` is reserved for sources that benefit from
# sub-hour freshness (HN Algolia, vendor news, vendor changelogs);
# ``mid`` covers arXiv + community feeds; curated GitHub repositories are
# intentionally polled less often because their detail view has an explicit
# Zread refresh action.
_RADAR_DEFAULT_TIER_MINUTES: dict[str, int] = {
    "hackernews": 30,
    "hn_algolia": 30,
    "vendor_news": 60,
    "vendor_changelog": 60,
    "rss": 60,
    "huggingface_papers": 30,
    "huggingface_models": 120,
    "openreview": 60,
    "arxiv": 60,
    "devto": 120,
    "lobsters": 120,
    "reddit": 120,
    "github": 30,
    "github_trending": 30,
    "github_topic_search": 120,
    "producthunt": 240,
    "sitemap_watch": 360,
    "wechat": 360,
}


def _radar_polling_interval_minutes(source_type: str, config: Mapping[str, Any]) -> int:
    """Pick the smallest positive interval allowed for a source.

    Order of precedence:
        1. explicit ``pollingIntervalMinutes`` in the radar_sources.config
        2. tier default keyed by source_type
        3. 60 minutes (one hour, the universal fallback)
    """
    raw = config.get("pollingIntervalMinutes")
    try:
        explicit = int(raw) if raw is not None else None
    except (TypeError, ValueError):
        explicit = None
    if explicit is not None and explicit > 0:
        return max(5, min(explicit, 24 * 60))
    return _RADAR_DEFAULT_TIER_MINUTES.get(source_type, 60)


async def _radar_tiered_sync_loop(app_instance: FastAPI) -> None:
    """P1.6: per-source polling cadence.

    Replaces the previous single-shot daily loop. Every ``RADAR_TICK_SECONDS``
    (default 60) we wake, query ``radar_sources`` for sources whose next-fire
    moment has arrived, and run only those. The cron-time ``RADAR_SYNC_CRON_TIME``
    stays as a once-a-day forced full sweep so the system always catches up
    even if the loop wedged.

    Concurrency is the same as before (single asyncio.Lock; per-source fetcher
    concurrency lives in the runner).
    """
    from ai_engine.radar.sync_endpoint import run_radar_sync_job

    log = structlog.get_logger("ai_engine.radar")
    tick_seconds = max(15.0, float(os.environ.get("RADAR_TICK_SECONDS", "60")))
    daily_full_sync_time = os.environ.get("RADAR_SYNC_CRON_TIME", "08:00")
    tz = ZoneInfo("Asia/Shanghai")
    # Do not force a full sweep on every process restart. launchd can restart
    # the worker during a dependency outage; initializing this two days in the
    # past multiplied every restart into another full source fan-out. Each
    # source's persisted lastSyncAt still determines whether it is due.
    last_daily_full_sync = datetime.now(tz)
    last_run_at_per_source: dict[str, datetime] = {}
    consecutive_failures = 0

    while True:
        try:
            await asyncio.sleep(tick_seconds)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning(
                "ai-engine.radar.tiered_loop_tick_failed",
                error_type=type(exc).__name__,
            )
            continue

        now = datetime.now(tz)
        due_source_ids: list[str] = []
        try:
            async with app_instance.state.db_pool.connection() as conn:
                rows = await (
                    await conn.execute(
                        'SELECT "id", "sourceType", "config", "lastSyncAt" '
                        'FROM "radar_sources" WHERE "enabled" = true '
                        'ORDER BY "createdAt" ASC'
                    )
                ).fetchall()
            today_at_8am = now.replace(
                hour=int(daily_full_sync_time.split(":")[0]),
                minute=int(daily_full_sync_time.split(":")[1]),
                second=0,
                microsecond=0,
            )
            full_sync_overdue = (
                last_daily_full_sync.date() < now.date()
                or (last_daily_full_sync < today_at_8am <= now)
            )

            for row in rows:
                raw_config = row.get("config") or {}
                config = dict(raw_config) if isinstance(raw_config, dict) else {}
                interval_minutes = _radar_polling_interval_minutes(
                    str(row["sourceType"]), config
                )
                last_run = last_run_at_per_source.get(str(row["id"]))
                last_sync = row.get("lastSyncAt")
                anchor = last_run or (
                    last_sync if isinstance(last_sync, datetime) else None
                )
                if anchor is None:
                    due_source_ids.append(str(row["id"]))
                    continue
                if anchor.tzinfo is None:
                    anchor = anchor.replace(tzinfo=tz)
                if (now - anchor).total_seconds() >= interval_minutes * 60:
                    due_source_ids.append(str(row["id"]))

            # Force a full sweep at the configured daily window so any tier
            # drift or missed loop iteration gets caught up.
            if full_sync_overdue:
                due_source_ids = [str(row["id"]) for row in rows]
                last_daily_full_sync = now
        except Exception as exc:
            log.warning(
                "ai-engine.radar.due_source_query_failed",
                error_type=type(exc).__name__,
            )
            continue

        # Stamp first so even a failed run still suppresses re-firing within
        # the pollingIntervalMinutes window after we exit the loop body.
        for source_id in due_source_ids:
            last_run_at_per_source[source_id] = now

        if not due_source_ids:
            continue

        try:
            await run_radar_sync_job(
                pool=app_instance.state.db_pool,
                adapter=app_instance.state.adapter,
                triggered_by="cron",
                request_id=f"tiered-{uuid.uuid4()}",
                source_ids=set(due_source_ids),
                lock=getattr(app_instance.state, "radar_sync_lock", None),
            )
            consecutive_failures = 0
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Log with full message + traceback so future regressions
            # don't show up as a 5-line structlog entry with no context.
            log.warning(
                "ai-engine.radar.tiered_job_failed",
                error_type=type(exc).__name__,
                error_message=str(exc)[:500],
                sources=len(due_source_ids),
                consecutive_failures=consecutive_failures + 1,
            )
            log.error(
                "ai-engine.radar.tiered_job_traceback",
                exc_info=exc,
            )
            consecutive_failures += 1
            if consecutive_failures >= 5:
                log.error(
                    "ai-engine.radar.tiered_job_persistent",
                    note="5+ consecutive failures — investigate scheduler health",
                )


async def _radar_sync_loop(app_instance: FastAPI) -> None:
    """Scheduled radar sync → enrichment at 08:00 Asia/Shanghai.

    Controlled by ``RADAR_SYNC_CRON_ENABLED`` (default 1 when a real DB pool
    is present) and ``RADAR_SYNC_CRON_TIME`` (default "08:00"). The shared
    ``radar_sync_lock`` prevents overlap with an admin-triggered sync.

    Kept as a thin shim that delegates to ``_radar_tiered_sync_loop``; the
    old name is preserved so historical ``lifespan`` callers stay valid.
    """
    await _radar_tiered_sync_loop(app_instance)


def _llm_recovery_interval_seconds() -> float:
    try:
        return max(
            300.0,
            float(os.environ.get("LLM_RECOVERY_INTERVAL_SECONDS", "600")),
        )
    except (TypeError, ValueError):
        return 600.0


def _llm_recovery_limit() -> int:
    try:
        return max(1, int(os.environ.get("LLM_RECOVERY_LIMIT", "50")))
    except (TypeError, ValueError):
        return 50


def _enrichment_recovery_interval_seconds() -> float:
    try:
        return max(
            30.0,
            float(os.environ.get("RADAR_ENRICHMENT_RECOVERY_INTERVAL_SECONDS", "60")),
        )
    except (TypeError, ValueError):
        return 60.0


def _enrichment_worker_count() -> int:
    """Return the number of independent durable enrichment consumers."""
    try:
        return max(
            1,
            int(os.environ.get("RADAR_ENRICHMENT_CONCURRENCY", "2")),
        )
    except (TypeError, ValueError):
        return 2


async def _enrichment_recovery_loop(app_instance: FastAPI) -> None:
    """Reclaim crashed enrichment leases independently of long source calls."""
    from ai_engine.radar.enrichment_worker import recover_expired_enrichment_leases

    interval = _enrichment_recovery_interval_seconds()
    limit = _llm_recovery_limit()
    log = structlog.get_logger("ai_engine.radar.enrichment_recovery")
    log.info(
        "ai-engine.radar.enrichment_recovery.started",
        interval_seconds=interval,
        limit=limit,
    )
    while True:
        try:
            recovered = await recover_expired_enrichment_leases(
                app_instance.state.db_pool,
                limit=limit,
            )
            if recovered:
                log.info(
                    "ai-engine.radar.enrichment_recovery.completed",
                    recovered=recovered,
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning(
                "ai-engine.radar.enrichment_recovery.failed",
                error_type=type(exc).__name__,
                error_message=str(exc)[:500],
            )
        try:
            await asyncio.sleep(interval)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning(
                "ai-engine.radar.enrichment_recovery.sleep_failed",
                error_type=type(exc).__name__,
            )


async def _llm_recovery_loop(app_instance: FastAPI) -> None:
    """Retry recoverable radar work after a temporary local/network outage.

    A provider outage is not a content-quality decision.  The radar pipeline
    therefore leaves score/enrichment work retryable, and this loop revisits a
    bounded batch on a fixed cadence instead of waiting for the next source
    publication.  The existing workers own the quality gates and per-call
    retry/fallback policy.
    """
    from ai_engine.radar.candidate_postprocessor import score_missing_candidates
    from ai_engine.radar.enrichment_worker import run_enrichment_for_pending

    interval = _llm_recovery_interval_seconds()
    limit = _llm_recovery_limit()
    worker_count = _enrichment_worker_count()
    consumer_idle_interval = min(
        30.0,
        _enrichment_recovery_interval_seconds(),
    )
    log = structlog.get_logger("ai_engine.llm_recovery")
    log.info(
        "ai-engine.llm_recovery.started",
        interval_seconds=interval,
        limit=limit,
        enrichment_workers=worker_count,
    )

    stats = {"enriched": 0}
    stats_lock = asyncio.Lock()

    async def _enrichment_consumer(worker_index: int) -> None:
        """Keep one durable claim slot busy without blocking its siblings."""
        while True:
            try:
                enriched = await run_enrichment_for_pending(
                    app_instance.state.db_pool,
                    limit=1,
                    concurrency=1,
                )
                if enriched:
                    async with stats_lock:
                        stats["enriched"] += enriched
                else:
                    await asyncio.sleep(consumer_idle_interval)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning(
                    "ai-engine.llm_recovery.enrichment_consumer_failed",
                    worker_index=worker_index,
                    error_type=type(exc).__name__,
                    error_message=str(exc)[:500],
                )
                await asyncio.sleep(consumer_idle_interval)

    consumers = [
        asyncio.create_task(
            _enrichment_consumer(index),
            name=f"radar-enrichment-consumer-{index}",
        )
        for index in range(worker_count)
    ]
    try:
        # Scoring is periodic work, while enrichment is a durable queue with
        # independent consumers. A slow Zread/remote call must not hold the
        # radar sync lock or prevent other source kinds from being claimed.
        while True:
            try:
                lock = getattr(app_instance.state, "radar_sync_lock", None)
                if lock is None:
                    raise RuntimeError("radar sync lock is not initialized")
                async with lock:
                    scored = await score_missing_candidates(
                        app_instance.state.db_pool,
                        limit=limit,
                    )
                async with stats_lock:
                    enriched = stats["enriched"]
                    stats["enriched"] = 0
                log.info(
                    "ai-engine.llm_recovery.completed",
                    interval_seconds=interval,
                    limit=limit,
                    scored=scored,
                    enriched=enriched,
                    rescored=0,
                    enrichment_workers=worker_count,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning(
                    "ai-engine.llm_recovery.failed",
                    error_type=type(exc).__name__,
                    error_message=str(exc)[:500],
                    interval_seconds=interval,
                )
            try:
                await asyncio.sleep(interval)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning(
                    "ai-engine.llm_recovery.sleep_failed",
                    error_type=type(exc).__name__,
                )
    finally:
        for consumer in consumers:
            consumer.cancel()
        await asyncio.gather(*consumers, return_exceptions=True)


async def _render_review_loop(app_instance: FastAPI) -> None:
    """Run real-browser review after content review queues an enriched row."""
    from ai_engine.radar.render_review_worker import render_review_loop

    await render_review_loop(app_instance.state.db_pool)


async def _review_reconciliation_loop(app_instance: FastAPI) -> None:
    """Converge persisted high-value radar review state after restarts."""
    from ai_engine.radar.review_reconciliation import review_reconciliation_loop

    await review_reconciliation_loop(app_instance.state.db_pool)


async def _evidence_reconciliation_loop(app_instance: FastAPI) -> None:
    """Finish claim-scoped evidence handoffs after the browser is gone."""
    from ai_engine.evidence_reconciliation import reconciliation_loop

    await reconciliation_loop(app_instance.state.db_pool)


# ──────────────────────────────────────────────────────────────────────
# P1-B / P1-D 进程内 worker loop
# ──────────────────────────────────────────────────────────────────────


async def _submission_worker_loop(app_instance: FastAPI) -> None:
    """P1-B: 持续消费 radar_submissions 行的状态推进。
    失败隔离：worker 抛任何异常都不会让 loop 退出。
    """
    from ai_engine.radar.submission_worker import run_submission_worker

    log = structlog.get_logger("ai_engine.radar.submission")
    poll_seconds = float(os.environ.get("SUBMISSION_WORKER_POLL_SECONDS", "2"))
    while True:
        try:
            processed = await run_submission_worker(
                app_instance.state.db_pool,
                max_iterations=int(os.environ.get("SUBMISSION_WORKER_ITERATIONS", "1")),
            )
            if processed == 0:
                await asyncio.sleep(poll_seconds)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning(
                "ai-engine.radar.submission.loop_failed",
                error_type=type(exc).__name__,
            )
            await asyncio.sleep(poll_seconds)


async def _topic_synthesis_loop(app_instance: FastAPI) -> None:
    """P1-D V2: 每 5 分钟跑一次 hash-gated 主题 AI 综述。"""
    from ai_engine.radar.topic_synthesis_v2 import run_topic_synthesis_v2

    log = structlog.get_logger("ai_engine.radar.topic_synth")
    interval = float(os.environ.get("TOPIC_SYNTHESIS_INTERVAL_SECONDS", "300"))
    while True:
        try:
            await asyncio.sleep(interval)
            await run_topic_synthesis_v2(app_instance.state.db_pool)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning(
                "ai-engine.radar.topic_synth.loop_failed",
                error_type=type(exc).__name__,
            )
            await asyncio.sleep(interval)


async def _topic_issue_loop(app_instance: FastAPI) -> None:
    """P1-D V2: periodically cluster eligible candidates into TopicIssue."""
    from ai_engine.radar.topic_issue_worker import run_topic_issue_worker

    log = structlog.get_logger("ai_engine.radar.topic_issue")
    interval = float(os.environ.get("TOPIC_ISSUE_INTERVAL_SECONDS", "300"))
    while True:
        try:
            await asyncio.sleep(interval)
            result = await run_topic_issue_worker(app_instance.state.db_pool)
            log.info("ai-engine.radar.topic_issue.done", **result)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning(
                "ai-engine.radar.topic_issue.loop_failed",
                error_type=type(exc).__name__,
            )
            await asyncio.sleep(interval)


async def _topic_proposal_loop(app_instance: FastAPI) -> None:
    """P1-D: daily proposal generation for Admin review only.

    This job writes ``topic_proposals`` and ``topic_proposal_candidates``;
    approval remains an explicit Admin action in the web BFF.
    """
    from ai_engine.radar.topic_proposal_worker import run_topic_proposal_generation

    log = structlog.get_logger("ai_engine.radar.topic_proposals")
    schedule = os.environ.get("TOPIC_PROPOSAL_CRON_TIME", "09:00")
    tz = ZoneInfo("Asia/Shanghai")
    while True:
        try:
            await asyncio.sleep(_seconds_until_next_radar_window(schedule, tz))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning(
                "ai-engine.radar.topic_proposals.schedule_failed",
                error_type=type(exc).__name__,
            )
            await asyncio.sleep(3600.0)
            continue
        try:
            result = await run_topic_proposal_generation(
                app_instance.state.db_pool
            )
            log.info(
                "ai-engine.radar.topic_proposals.done",
                **result,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning(
                "ai-engine.radar.topic_proposals.run_failed",
                error_type=type(exc).__name__,
            )


app = FastAPI(
    title="Deep Research AI Engine",
    version="0.1.0",
    lifespan=_lifespan,
)

from ai_engine.radar.sync_endpoint import router as radar_router  # noqa: E402
from ai_engine.radar.topic_endpoint import router as topic_router  # noqa: E402
from ai_engine.server.chat import _anythingllm_usage, router as chat_router  # noqa: E402
from ai_engine.server.research_chat import router as research_chat_router  # noqa: E402

app.include_router(radar_router)
app.include_router(topic_router)
app.include_router(chat_router)
app.include_router(research_chat_router)

logger.info("ai-engine.llm.routes", extra={"routes": config_snapshot()})


# ──────────────────────────────────────────────────────────────────────
# Middleware: request_id + structured access log
# ──────────────────────────────────────────────────────────────────────


@app.middleware("http")
async def request_context_middleware(request: Request, call_next):  # type: ignore[no-untyped-def]
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    request.state.request_id = request_id
    try:
        log = structlog.get_logger("ai_engine.http")
    except Exception:  # pragma: no cover - third-party logging configuration
        log = None
    started = asyncio.get_event_loop().time()
    try:
        response = await call_next(request)
    except AdapterError as exc:
        elapsed_ms = int((asyncio.get_event_loop().time() - started) * 1000)
        _safe_structlog(
            log,
            "error",
            "ai-engine.error",
            request_id=request_id,
            route=request.url.path,
            method=request.method,
            latency_ms=elapsed_ms,
            error_code=exc.code,
            error_message=exc.message,
        )
        return _error_response(exc, request_id)
    except Exception as exc:  # pragma: no cover — defensive
        elapsed_ms = int((asyncio.get_event_loop().time() - started) * 1000)
        _safe_structlog(
            log,
            "exception",
            "ai-engine.unhandled",
            request_id=request_id,
            route=request.url.path,
            latency_ms=elapsed_ms,
        )
        # Week 1 review 修正:structlog JSONRenderer 配 exc_info 时,
        # format_exc_info processor 没在 chain 里,异常 stack 不进 JSON。
        # 用 traceback 显式打 stderr,运维 grep 能直接定位。
        import traceback as _tb
        print(f"[UNHANDLED {request_id}] {type(exc).__name__}: {exc}", file=__import__('sys').stderr)
        _tb.print_exception(type(exc), exc, exc.__traceback__, file=__import__('sys').stderr)
        return JSONResponse(
            status_code=500,
            content={
                "code": "INTERNAL",
                "message": "internal server error",
                "requestId": request_id,
            },
        )
    elapsed_ms = int((asyncio.get_event_loop().time() - started) * 1000)
    # Access logging happens after the handler has produced a response. A
    # third-party research dependency may reconfigure structlog at runtime;
    # logging must never turn an otherwise valid response into Starlette's
    # plain-text ``500 Internal Server Error``.
    _safe_structlog(
        log,
        "info",
        "ai-engine.request",
        request_id=request_id,
        route=request.url.path,
        method=request.method,
        status=response.status_code,
        latency_ms=elapsed_ms,
    )
    # Surface the request_id on every response so the BFF can correlate.
    response.headers["x-request-id"] = request_id
    return response


def _safe_structlog(log: Any, method_name: str, event: str, **kwargs: Any) -> None:
    """Emit a structured log without allowing logging failures into HTTP."""
    if log is None:
        return
    try:
        getattr(log, method_name)(event, **kwargs)
    except Exception:  # pragma: no cover - logging is best-effort by design
        with suppress(Exception):
            logger.exception("structured logging failed for %s", event)


def _error_response(exc: AdapterError, request_id: str) -> JSONResponse:
    payload: dict[str, Any] = {
        "code": exc.code,
        "message": exc.message,
        "requestId": request_id,
    }
    if exc.details is not None:
        payload["details"] = exc.details
    return JSONResponse(status_code=exc.http_status, content=payload)


# ──────────────────────────────────────────────────────────────────────
# Singletons (Week 1 in-memory)
# ──────────────────────────────────────────────────────────────────────


def _store_singleton() -> JobStore:
    """返回 process-level store。

    W2 review 修正:之前的 `assert isinstance(store, InMemoryJobStore)` 把
    DbJobStore 拒之门外,即使 JOB_RUNNER_BACKEND=db 也立刻挂。

    Resolve 顺序:
    1. FastAPI dependency_overrides[_store_singleton] (测试注入) — 优先;
    2. app.state.job_store (lifespan 创建,生产路径);
    3. build_store() lazy fallback (dev 启动未经过 lifespan)。

    共享单例,否则 POST 写进去 GET 看不见。
    """
    # 1. 测试 override
    override = app.dependency_overrides.get(_store_singleton)
    if override is not None:
        return cast(JobStore, override())
    # 2. lifespan 创建
    state_store = getattr(app.state, "job_store", None)
    if state_store is not None:
        return cast(JobStore, state_store)
    # 3. lazy fallback
    store = build_store()
    app.state.job_store = store
    return store


def _adapter_singleton() -> ResearchEngineAdapter:
    """Return whatever `build_adapter()` produces."""
    adapter = build_adapter()
    # The `claude`/`gpt_researcher` factories raise before returning, so the
    # only thing that comes back here conforms to the Protocol.
    return adapter


# ──────────────────────────────────────────────────────────────────────
# Request/Response models
# ──────────────────────────────────────────────────────────────────────


class SubmitAiJobBody(BaseModel):
    """Mirrors `packages/shared/src/schemas.ts CreateAiJobInput`.

    Validated via Pydantic instead of Zod to keep the engine self-contained.
    The Web BFF still validates first; this is defence-in-depth.

    W6: 加 `idempotency_key` 字段 —— BFF 把客户端 `Idempotency-Key` header
    透传到这里;同一 (requester_id, key) 二次提交返回原 job,不再 enqueue 也不扣 quota。
    """

    job_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    requester_id: str = Field(default="00000000-0000-0000-0000-000000000001")
    topic: str = Field(min_length=2, max_length=200)
    context: str | None = Field(default=None, max_length=20000)
    report_type: ReportType = Field(default="research_report")
    # P1.8: reportLength scales gpt-researcher's TOTAL_WORDS / MAX_URLS_TO_SCRAPE
    # (deep preset allows up to 48 captured web sources).
    source_policy: SourcePolicy = Field(default="prefer_user_sources")
    report_length: str = Field(default="standard")  # brief | standard | deep
    max_urls_to_scrape: int | None = Field(default=None, ge=5, le=48)
    source_refs: list[dict[str, str | bool]] = Field(default_factory=list, max_length=10)
    idempotency_key: str | None = Field(default=None, max_length=64)


class SubmitAiJobResponse(BaseModel):
    job_id: str
    status: str
    topic: str | None = None
    final_status: str | None = None
    current_step: str | None = None
    sources_count: int = 0
    partial_sources_count: int = 0
    failed_sources_count: int = 0
    error_stage: str | None = None
    draft_research_id: str | None = None
    report_type: str | None = None
    output_text: str | None = None
    token_input_total: int = 0
    token_output_total: int = 0
    cost_cents: int = 0
    search_count: int = 0
    error_code: str | None = None
    error_message: str | None = None
    error_details: dict[str, object] | None = None
    request_id: str | None = None
    started_at: str | None = None
    created_at: str | None = None
    completed_at: str | None = None
    # W7 (工程师 B): structured output flag. True when the engine
    # produced a conclusion without any grounded source.
    is_inferred: bool = False
    review: dict[str, object] | None = None
    # Deep-research branch checkpoint. Kept separate from fact-review fields
    # so the UI can explain long-running work without inventing a result.
    research_progress: dict[str, object] | None = None


class ReviewResearchBody(BaseModel):
    """Synchronous re-review input for an already edited private draft."""

    topic: str = Field(min_length=2, max_length=300)
    report: str = Field(min_length=1, max_length=100_000)
    sources: list[dict[str, object]] = Field(default_factory=list, max_length=100)


class AssistantSelection(BaseModel):
    quote: str = Field(min_length=1, max_length=12000)
    start_offset: int = Field(ge=0)
    end_offset: int = Field(ge=0)
    content_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class ResearchAssistantBody(BaseModel):
    operation: str = Field(pattern=r"^(explain|translate|rewrite|summarize|knowledge_card|guide|guide_section|guide_synthesis|counterpoint|fact_check|conclusion_check)$")
    body: str = Field(min_length=1, max_length=256000)
    selection: AssistantSelection | None = None
    instruction: str | None = Field(default=None, max_length=2000)
    topic: str = Field(default="调研文章", max_length=300)
    sources: list[dict[str, object]] = Field(default_factory=list, max_length=100)
    summary_id: str | None = Field(default=None, max_length=64, alias="summaryId")


class CancelAiJobResponse(BaseModel):
    job_id: str
    was_queued: bool
    was_running: bool


class ListAiJobsItem(BaseModel):
    """One row in :class:`ListAiJobsResponse`.

    Mirrors the columns the BFF history page needs. ``published_research_id``
    is non-null iff ``status == "succeeded"`` AND the linked draft has been
    promoted to a published Research row (joined in the SQL).

    Note: ``status`` is typed as ``str`` (not ``AiJobStatus``) because
    Pydantic v2 cannot resolve ``Literal`` aliases that come from a sibling
    module — for v0 we keep the contract simple and validate at the BFF.
    """
    job_id: str
    topic: str
    status: str
    current_step: str | None = None
    report_type: str
    report_length: str = "standard"
    has_report: bool = False
    # Number of persisted, fetched source excerpts.  ``source_refs`` is the
    # user's requested input and cannot tell the UI whether the run actually
    # produced inspectable evidence.
    captured_sources_count: int = 0
    # ``has_report`` is kept for backwards compatibility, but it only means
    # that some output was persisted.  The UI needs to distinguish a real
    # reader-facing report from the recoverable evidence digest used when the
    # writer did not return publishable prose.
    deliverable_status: str = "none"  # report | evidence_only | none
    source_policy: str
    source_refs: list[dict[str, object]] = Field(default_factory=list)
    token_input_total: int = 0
    token_output_total: int = 0
    cost_cents: int = 0
    draft_research_id: str | None = None
    published_research_id: str | None = None
    error_code: str | None = None
    error_message: str | None = None
    error_details: dict[str, object] | None = None
    # Report generation and fact review are separate boundaries. Keep the
    # review outcome in history so a completed-but-unverified report does not
    # look identical to a fully audited one.
    review_status: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    completed_at: str | None = None


class ListAiJobsResponse(BaseModel):
    items: list[ListAiJobsItem]
    total: int
    limit: int
    offset: int


def _research_deliverable_status(
    output_text: str | None,
    draft_research_id: str | None,
) -> str:
    """Return the user-facing deliverable kind for a history row.

    A persisted output is not necessarily a report.  When the report writer
    times out or returns no usable prose, the adapter stores an evidence
    digest so the work is recoverable.  That digest must not appear as a
    completed report in the task list (including for legacy rows that were
    incorrectly stored with ``succeeded``).
    """
    normalized = " ".join((output_text or "").split())
    if "报告模型没有返回可发布的研究正文" in normalized and "研究结论：待补写" in normalized:
        return "evidence_only"
    if output_text and output_text.strip() or draft_research_id:
        return "report"
    return "none"


class HealthResponse(BaseModel):
    status: str
    adapter: str
    jobs_in_memory: int
    request_id: str


# ──────────────────────────────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────────────────────────────


def _anythingllm_enabled_for(body: ResearchAssistantBody) -> bool:
    """Enable the AnythingLLM experiment only for explicitly listed radar IDs."""
    if body.operation not in {"guide", "guide_section", "guide_synthesis"} or not body.summary_id:
        return False
    if not os.environ.get("ANYTHINGLLM_URL", "").strip() or not os.environ.get("ANYTHINGLLM_API_KEY", "").strip():
        return False
    configured = {item.strip() for item in os.environ.get("ANYTHINGLLM_RADAR_IDS", "").split(",") if item.strip()}
    return body.summary_id in configured


def _extract_json_object(value: str) -> dict[str, object] | None:
    """Remove reasoning wrappers and recover the first JSON object from a model response."""
    cleaned = _strip_reasoning_blocks(value)
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        parsed = json.loads(cleaned[start:end + 1])
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _strip_reasoning_blocks(value: str) -> str:
    """Remove provider reasoning markup before it reaches a reader.

    Reasoning models are not fully consistent: some emit a closed ``<think>``
    block, while truncated responses may omit the closing tag.  The latter
    must not leak internal reasoning into the user-facing suggestion.
    """
    cleaned = str(value or "").strip()
    cleaned = re.sub(
        r"<think[^>]*>.*?</think[^>]*>",
        "",
        cleaned,
        flags=re.IGNORECASE | re.DOTALL,
    )
    cleaned = re.sub(
        r"<think[^>]*>[\s\S]*$",
        "",
        cleaned,
        flags=re.IGNORECASE,
    ).strip()
    return cleaned


async def _anythingllm_guide(
    body: ResearchAssistantBody,
) -> tuple[dict[str, object] | None, int | None, int | None, str | None]:
    """Call AnythingLLM for the opt-in radar experiment; failures fall back upstream."""
    base_url = os.environ.get("ANYTHINGLLM_URL", "").strip().rstrip("/")
    api_key = os.environ.get("ANYTHINGLLM_API_KEY", "").strip()
    workspace = os.environ.get("ANYTHINGLLM_WORKSPACE", "").strip()
    if not base_url or not api_key or not workspace:
        return None, None, None, None
    if body.operation == "guide":
        instruction = "只输出紧凑 JSON，不要输出<think>、解释或 Markdown。schema: {\"version\":2,\"summary\":\"一句话判断\",\"outline\":[{\"heading\":\"主题\",\"takeaway\":\"本部分说明\",\"quote\":\"该部分逐字原文短引\"}],\"keyTakeaways\":[{\"claim\":\"关键观点\",\"whyItMatters\":\"重要性\",\"evidence\":\"原文短引\"}]}。outline 最多 6 条，keyTakeaways 最多 3 条，每个 outline.quote 必须来自对应部分且不能重复 Abstract，证据必须来自原文。"
    elif body.operation == "guide_section":
        instruction = "只输出紧凑 JSON，不要输出<think>、解释或 Markdown。schema: {\"version\":2,\"outline\":[{\"heading\":\"本段主题\",\"takeaway\":\"本段说明\"}],\"keyTakeaways\":[{\"claim\":\"局部观点\",\"evidence\":\"原文短引\"}]}。"
    else:
        instruction = "只输出紧凑 JSON，不要输出<think>、解释或 Markdown。将这些分段笔记合并为 {\"version\":2,\"summary\":\"一句话判断\",\"outline\":[{\"heading\":\"主题\",\"takeaway\":\"说明\"}],\"keyTakeaways\":[{\"claim\":\"观点\",\"evidence\":\"引用\"}]}。"
    prompt = f"主题：{body.topic}\n原文或分段笔记：\n{body.body}\n\n{instruction}"
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"{base_url}/api/v1/workspace/{workspace}/chat",
                headers={"Authorization": f"Bearer {api_key}"},
                json={"message": prompt, "mode": "chat", "sessionId": f"radar-{body.summary_id}"},
            )
        if response.status_code >= 400:
            return None, None, None, None
        payload = response.json()
        text = payload.get("textResponse") if isinstance(payload, dict) else None
        if not isinstance(payload, dict) or not isinstance(text, str):
            return None, None, None, None
        tokens_in, tokens_out, actual_model = _anythingllm_usage(payload)
        return _extract_json_object(text), tokens_in, tokens_out, actual_model
    except (httpx.HTTPError, ValueError, TypeError):
        return None, None, None, None


@app.post("/api/ai/research-assistant")
async def research_assistant(body: ResearchAssistantBody, request: Request) -> dict[str, object]:
    """Small synchronous editor assistant; never mutates the research draft."""
    started = asyncio.get_event_loop().time()
    request_id = getattr(request.state, "request_id", None)
    original = body.selection.quote if body.selection else body.body[:12000]
    # The web route already chunks long radar articles. Keep the engine-side
    # fallback generous so a retry cannot fail merely because the article is
    # larger than the old 60K ceiling.
    context = body.body[:256000]
    warnings: list[str] = []
    claims: list[dict[str, object]] = []
    if _anythingllm_enabled_for(body):
        external_guide, tokens_in, tokens_out, actual_model = await _anythingllm_guide(body)
        if external_guide:
            await record_llm_usage(
                LlmUsageAttempt(
                    operation=f"research_assistant.{body.operation}.anythingllm",
                    request_id=request_id,
                    provider="anythingllm",
                    requested_model=actual_model or "workspace-default",
                    actual_model=actual_model,
                    input_tokens=tokens_in,
                    output_tokens=tokens_out,
                    latency_ms=int((asyncio.get_event_loop().time() - started) * 1000),
                )
            )
            return {
                "operation": body.operation,
                "original": original,
                "suggestion": json.dumps(external_guide, ensure_ascii=False),
                "guide": external_guide,
                "rationale": "anythingllm",
                "claims": [],
                "warnings": warnings,
                "request_id": request_id,
                "metrics": {
                    "provider": "anythingllm",
                    "token_input_total": tokens_in,
                    "token_output_total": tokens_out,
                },
            }
    if body.operation in {"fact_check", "conclusion_check"}:
        from ai_engine.reviewer import DefaultResearchReviewer
        sources: list[AdapterSource] = []
        for raw in body.sources:
            canonical = raw.get("canonicalKey") or raw.get("canonical_key")
            if isinstance(canonical, str) and canonical.strip():
                sources.append(AdapterSource(
                    source_ref={"type": "url", "value": canonical},
                    canonical_key=canonical, title=_json_str(raw.get("title")),
                    snippet=_json_str(raw.get("description")),
                    score=None, step_captured=cast("Any", AI_JOB_STEP["SEARCH"]), is_accessible=True,
                ))
        reviewed = await DefaultResearchReviewer(
            llm_spec=resolve_spec(
                "utility", explicit=os.environ.get("FACT_REVIEWER_LLM")
            )
        ).review(
            original if body.operation == "fact_check" else context, tuple(sources), body.topic,
        )
        for claim in reviewed.claims:
            verdict = "unsupported" if claim.verdict == "correctable" else claim.verdict
            if verdict not in {"verified", "unsupported", "contradicted", "unverified"}:
                verdict = "unverified"
            claims.append({"text": claim.claim, "verdict": verdict, "evidence": claim.evidence.excerpt if claim.evidence else None})
        metrics = {
            "latency_ms": int((asyncio.get_event_loop().time() - started) * 1000),
            "token_input_total": 0,
            "token_output_total": 0,
            "cost_cents": 0,
        }
        _safe_structlog(
            structlog.get_logger("ai_engine.research_assistant"),
            "info",
            "research-assistant.completed",
            request_id=request_id,
            operation=body.operation,
            **metrics,
        )
        return {"operation": body.operation, "original": original, "suggestion": None, "rationale": reviewed.status, "claims": claims, "warnings": warnings, "request_id": request_id, "metrics": metrics}

    # M5: 结构化 AI导读（radar 阅读面板）—— 强制 JSON 输出，json-repair 容错解析。
    if body.operation in {"guide", "guide_section", "guide_synthesis"}:
        from ai_engine.prompt import (
            _RADAR_GUIDE_INSTRUCTION,
            _RADAR_GUIDE_SECTION_INSTRUCTION,
            _RADAR_GUIDE_SECTION_SYSTEM,
            _RADAR_GUIDE_SYSTEM,
            _RADAR_GUIDE_SYNTHESIS_INSTRUCTION,
            _RADAR_GUIDE_SYNTHESIS_SYSTEM,
        )

        guide_instruction, guide_system = {
            "guide": (_RADAR_GUIDE_INSTRUCTION, _RADAR_GUIDE_SYSTEM),
            "guide_section": (_RADAR_GUIDE_SECTION_INSTRUCTION, _RADAR_GUIDE_SECTION_SYSTEM),
            "guide_synthesis": (_RADAR_GUIDE_SYNTHESIS_INSTRUCTION, _RADAR_GUIDE_SYNTHESIS_SYSTEM),
        }[body.operation]
        # Structured reading output should have room for a complete map and
        # evidence. The request/body limits remain the crash guard; this is
        # no longer constrained to a short-summary budget.
        max_tokens = 8192 if body.operation == "guide_synthesis" else 6000

        generated = await generate_text(
            user_prompt=(
                f"主题：{body.topic}\n原文：\n{context}\n\n{guide_instruction}"
            ),
            system_prompt=guide_system,
            llm_spec=resolve_spec(
                "utility", explicit=os.environ.get("RESEARCH_ASSISTANT_LLM")
            ),
            tier="light", max_tokens=max_tokens, timeout=120.0,
            disable_thinking=True,
            operation=f"research_assistant.{body.operation}",
            request_id=request_id,
        )
        metrics = {
            "latency_ms": int((asyncio.get_event_loop().time() - started) * 1000),
            "token_input_total": generated.input_tokens,
            "token_output_total": generated.output_tokens,
            "cost_cents": 0,
        }
        # json-repair 容错解析 LLM 输出；失败时降级返回空 guide（BFF 降级到 markdown）。
        guide: dict[str, object] | None = None
        try:
            from json_repair import repair_json
            guide = json.loads(repair_json(generated.text.strip()))
            if not isinstance(guide, dict):
                guide = None
        except Exception:
            guide = None
        _safe_structlog(
            structlog.get_logger("ai_engine.research_assistant"),
            "info",
            "research-assistant.completed",
            request_id=request_id,
            operation=body.operation,
            guide_parsed=guide is not None,
            **metrics,
        )
        # Keep a usable markdown fallback when the model's JSON is malformed.
        # The BFF can render this instead of turning a recoverable formatting
        # problem into the generic "生成阅读内容失败" state.
        suggestion = _strip_reasoning_blocks(generated.text) if guide is None else None
        return {"operation": body.operation, "original": original, "suggestion": suggestion, "guide": guide, "rationale": guide_instruction, "claims": [], "warnings": warnings, "request_id": request_id, "metrics": metrics}

    if body.operation == "knowledge_card":
        # This branch is intentionally opt-in: the web BFF only calls it
        # after the reader clicks "提炼为知识卡片". It produces a short,
        # editable preview and never writes a Research row.
        source_context = json.dumps(
            body.sources[:12],
            ensure_ascii=False,
            separators=(",", ":"),
        )
        generated = await generate_text(
            user_prompt=(
                f"主题：{body.topic}\n"
                f"待提炼的 AI 回答：\n{context}\n"
                f"可用来源：\n{source_context}\n\n"
                "请把这条回答提炼成一张短知识卡片。只输出 JSON，不要输出 Markdown、解释或 <think>。"
                "格式必须是："
                "{\"title\":\"卡片标题\",\"body\":\"核心结论\",\"conclusion\":\"一句话结论\",\"tags\":[\"标签\"]}。"
                "title 不超过 60 字；body 不超过 500 字；conclusion 不超过 160 字；tags 最多 5 个。"
                "只保留回答中有依据的内容，不补充回答和来源中没有的事实。"
            ),
            system_prompt=(
                "你是知识整理助手。你的工作是把用户明确选中的一条 AI 回答压缩成可复用的短知识卡片。"
                "知识卡片必须保留边界和不确定性；来源不足时要在结论中保留“待核验”语义。"
                "只返回合法 JSON。"
            ),
            llm_spec=resolve_spec(
                "utility", explicit=os.environ.get("RESEARCH_ASSISTANT_LLM")
            ),
            tier="light",
            max_tokens=900,
            timeout=45.0,
            disable_thinking=True,
            operation="research_assistant.knowledge_card",
            request_id=request_id,
        )
        metrics = {
            "latency_ms": int((asyncio.get_event_loop().time() - started) * 1000),
            "token_input_total": generated.input_tokens,
            "token_output_total": generated.output_tokens,
            "cost_cents": 0,
        }
        card: dict[str, object] | None = None
        try:
            from json_repair import repair_json

            parsed_card = json.loads(repair_json(_strip_reasoning_blocks(generated.text)))
            if isinstance(parsed_card, dict):
                title = str(parsed_card.get("title") or "").strip()[:60]
                card_body = str(parsed_card.get("body") or "").strip()[:500]
                conclusion = str(parsed_card.get("conclusion") or "").strip()[:160]
                raw_tags = parsed_card.get("tags")
                tags = [
                    str(tag).strip()[:40]
                    for tag in raw_tags
                    if str(tag).strip()
                ][:5] if isinstance(raw_tags, list) else []
                if title and card_body:
                    card = {
                        "title": title,
                        "body": card_body,
                        "conclusion": conclusion or card_body[:160],
                        "tags": tags,
                    }
        except Exception:
            card = None
        _safe_structlog(
            structlog.get_logger("ai_engine.research_assistant"),
            "info",
            "research-assistant.completed",
            request_id=request_id,
            operation=body.operation,
            card_parsed=card is not None,
            **metrics,
        )
        return {
            "operation": body.operation,
            "original": original,
            "suggestion": json.dumps(card, ensure_ascii=False) if card else None,
            "card": card,
            "rationale": "explicit_knowledge_card_extraction",
            "claims": [],
            "warnings": warnings if card else ["知识卡片预览解析失败，请重试"],
            "request_id": request_id,
            "metrics": metrics,
        }

    prompts = {
        "explain": "解释选中的术语或片段：先定义，再结合上下文说明其在本文中的具体含义、涉及的变量或机制，以及为什么重要；不要只说它是一个术语，不要泛泛而谈。",
        "translate": "完整翻译输入内容，保留专有名词、标题、列表、表格、代码块、链接和段落结构。",
        "rewrite": "改写这段文字，使其更清晰、准确、紧凑，保留原意。",
        "summarize": "把这段文字压缩成一段简洁摘要。",
        "counterpoint": "为这段文字补充一个有事实依据的反方观点。",
    }
    instruction = body.instruction or prompts[body.operation]
    is_translation = body.operation == "translate"
    generated = await generate_text(
        user_prompt=original if is_translation else f"主题：{body.topic}\n上下文：{context}\n待处理文字：{original}\n要求：{instruction}",
        system_prompt=(
            f"你是专业翻译助手。{instruction}只返回翻译结果，不要重复输入、任务说明或提示词。"
            if is_translation
            else "你是研究文章编辑助手。只返回建议文本，不要 Markdown 包装或解释。"
        ),
        # Translation is chunked by the BFF, but a full-fidelity rewrite can
        # still be longer than a short editing response.  Keep enough output
        # room and expose provider truncation so callers do not treat a
        # partial translation as a successful one.
        llm_spec=resolve_spec(
            "utility", explicit=os.environ.get("RESEARCH_ASSISTANT_LLM")
        ),
        tier="light", max_tokens=1400 if body.operation == "explain" else 5000, timeout=30.0 if body.operation == "explain" else 60.0,
        disable_thinking=True,
        operation=f"research_assistant.{body.operation}",
        request_id=request_id,
    )
    metrics = {
        "latency_ms": int((asyncio.get_event_loop().time() - started) * 1000),
        "token_input_total": generated.input_tokens,
        "token_output_total": generated.output_tokens,
        # Provider pricing is intentionally not guessed here; the numeric
        # field remains present for a downstream cost meter to fill in.
        "cost_cents": 0,
    }
    _safe_structlog(
        structlog.get_logger("ai_engine.research_assistant"),
        "info",
        "research-assistant.completed",
        request_id=request_id,
        operation=body.operation,
        **metrics,
    )
    return {"operation": body.operation, "original": original, "suggestion": _strip_reasoning_blocks(generated.text), "rationale": instruction, "claims": [], "warnings": warnings, "truncated": generated.truncated, "finishReason": generated.finish_reason, "request_id": request_id, "metrics": metrics}


@app.post("/api/ai/review")
async def review_research(body: ReviewResearchBody, request: Request) -> dict[str, object]:
    """Re-review an edited report without invoking the Generator Agent."""
    from ai_engine.reviewer import DefaultResearchReviewer

    sources: list[AdapterSource] = []
    for raw in body.sources:
        canonical = raw.get("canonicalKey") or raw.get("canonical_key")
        if not isinstance(canonical, str) or not canonical.strip():
            continue
        raw_ref = raw.get("sourceRef") or raw.get("source_ref")
        source_ref: dict[str, str | bool] = {"type": "url", "value": canonical}
        if isinstance(raw_ref, dict):
            candidate = {
                str(key): value
                for key, value in raw_ref.items()
                if isinstance(value, (str, bool))
            }
            if candidate:
                source_ref = candidate
        sources.append(
            AdapterSource(
                source_ref=source_ref,
                canonical_key=canonical,
                title=_json_str(raw.get("title")),
                snippet=_json_str(raw.get("description")),
                score=None,
                step_captured=cast("Any", AI_JOB_STEP["SEARCH"]),
                is_accessible=True,
            )
        )
    result = await DefaultResearchReviewer(
        llm_spec=resolve_spec(
            "utility", explicit=os.environ.get("FACT_REVIEWER_LLM")
        ),
    ).review(body.report, tuple(sources), body.topic)
    return {
        "review": result.to_dict(),
        "request_id": getattr(request.state, "request_id", None),
    }


@app.get("/health")
async def health_alias(
    request: Request,
    store: Annotated[JobStore, Depends(_store_singleton)],
) -> dict[str, str]:
    return await _health_payload(request, store)


@app.get("/healthz")
async def healthz(
    request: Request,
    store: Annotated[JobStore, Depends(_store_singleton)],
) -> dict[str, str]:
    return await _health_payload(request, store)


async def _health_payload(request: Request, store: JobStore) -> dict[str, str]:
    adapter = _adapter_singleton()
    health = await adapter.health()
    return {
        "status": "ok" if health.ok else "degraded",
        "adapter": health.adapter_name,
        "jobs_in_memory": health.details.get("jobs_in_memory", "0"),
        "request_id": getattr(request.state, "request_id", ""),
    }


@app.post(
    "/api/ai/jobs",
    response_model=SubmitAiJobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def submit_ai_job(
    body: SubmitAiJobBody,
    request: Request,
    store: Annotated[JobStore, Depends(_store_singleton)],
) -> SubmitAiJobResponse:
    if body.source_policy == "only_user_sources" and not body.source_refs:
        raise _http_error(
            "AI_INVALID_SOURCE_POLICY",
            "only_user_sources requires at least one source_ref",
        )

    resolved_source_refs: tuple[dict[str, str | bool], ...] = tuple(body.source_refs)
    from ai_engine.job_runner.db_store import DbJobStore
    if isinstance(store, DbJobStore):
        try:
            resolved_source_refs = await store.resolve_internal_source_refs(
                body.source_refs,
                requester_id=body.requester_id,
            )
        except AdapterError as exc:
            raise _http_error(exc.code, exc.message) from exc
        # Do not append recent radar items implicitly. The confirmation UI
        # treats project history as an optional, user-selected source; adding
        # it here would expand the research boundary after confirmation and
        # makes an empty "当前资料" indicator misleading.

    # W6: Idempotency replay — same (requester_id, idempotency_key) returns the
    # original job without enqueueing a new one. Status 200 instead of 202 so
    # clients can distinguish replay from fresh submit.
    if body.idempotency_key:
        existing = await store.find_by_idempotency_key(
            body.requester_id, body.idempotency_key
        )
        if _is_idempotency_replay(existing, body.job_id):
            assert existing is not None
            snap = existing.snapshot
            return SubmitAiJobResponse(
                job_id=snap.job_id,
                status=snap.status,
                final_status=snap.status if snap.status in {"succeeded", "failed", "partial", "cancelled"} else None,
                current_step=snap.current_step,
                sources_count=len(snap.source_refs),
                token_input_total=0,
                token_output_total=0,
                cost_cents=0,
                search_count=0,
                error_code=None,
                error_message=None,
                request_id=getattr(request.state, "request_id", None),
            )

    # W6: Quota check — happens AFTER idempotency replay so replays don't
    # double-charge. Counts today's accepted submissions for the user and the
    # team (DB path sums across all users).
    user_used = await store.count_submissions_today(requester_id=body.requester_id)
    team_used = await store.count_submissions_today(team_scope=True)
    user_limit = int(os.environ.get("BUDGET_USER_DAILY", "5"))
    team_limit = int(os.environ.get("BUDGET_TEAM_DAILY", "20"))
    if user_used >= user_limit:
        raise _http_error_with_details(
            "AI_QUOTA_EXCEEDED",
            "个人今日 AI 调研配额已用完",
            {"scope": "user", "used": user_used, "limit": user_limit},
        )
    if team_used >= team_limit:
        raise _http_error_with_details(
            "AI_QUOTA_EXCEEDED",
            "团队今日 AI 调研配额已用完",
            {"scope": "team", "used": team_used, "limit": team_limit},
        )

    # 1. Persist the snapshot so subsequent GET can find it.
    snapshot = make_job_snapshot(
        topic=body.topic,
        requester_id=body.requester_id,
        report_type=body.report_type,
        source_policy=body.source_policy,
        report_length=body.report_length,
        max_urls_to_scrape=body.max_urls_to_scrape,
    )
    # Override job_id with the caller-provided one (BFF-supplied uuid).
    snapshot = type(snapshot)(
        job_id=body.job_id,
        requester_id=snapshot.requester_id,
        topic=snapshot.topic,
        context=body.context,
        report_type=snapshot.report_type,
        source_policy=snapshot.source_policy,
        report_length=snapshot.report_length,
        max_urls_to_scrape=snapshot.max_urls_to_scrape,
        status=snapshot.status,
        current_step=snapshot.current_step,
        attempts=snapshot.attempts,
        idempotency_key=body.idempotency_key,
        source_refs=resolved_source_refs,
    )
    await store.enqueue(snapshot)
    if isinstance(store, DbJobStore):
        await store.persist_source_refs(body.job_id, resolved_source_refs)

    # 2. Fire-and-forget background runner. Week 1 review 修正：原版同步
    # await run_one_available_job 会阻塞 HTTP 连接 5 分钟。Week 2 起改
    # 后台 task，立即返回 202 + queued。BFF 后续 5s 轮询 GET 拿状态。
    #
    # 注意：必须显式把 request-scoped 的 store + adapter 捕获进 task —
    # 否则 request 结束后依赖被释放，且测试通过 app.dependency_overrides
    # 注入的 fake adapter / store 不会被后台 task 看到。
    adapter = _adapter_singleton()
    job_id = body.job_id
    request_id = getattr(request.state, "request_id", None)
    asyncio.create_task(
        _background_run(
            store=store,
            adapter=adapter,
            job_id=job_id,
            request_id=request_id,
        )
    )

    return SubmitAiJobResponse(
        job_id=job_id,
        status="queued",
        final_status=None,
        current_step=None,
        sources_count=0,
        token_input_total=0,
        token_output_total=0,
        cost_cents=0,
        search_count=0,
        error_code=None,
        error_message=None,
        request_id=request_id,
    )


async def _background_run(
    *,
    store: JobStore,
    adapter: ResearchEngineAdapter,
    job_id: str,
    request_id: str | None,
) -> None:
    """后台跑一个 job;出错仅记日志,不影响 HTTP 响应(已经返回)。

    store / adapter 从 endpoint 显式传 — 这样:
    1. 测试通过 app.dependency_overrides 注入的 fake adapter / InMemoryJobStore
       在后台 task 里仍可见(endpoint 已经 resolve 过);
    2. 生产 uvicorn 单进程场景下 request-scoped store 在 request 结束后会被释放,
       但 submit 自身是同步 path,store 在 task 创建时已经被引用,gather 期间
       不会释放。
    Week 2 引入 DB-backed store 后改成 process-global singleton,本签名不变。

    W2 review 修正:跑 succeeded 时 draft_factory 必须能 INSERT 一条 research 行
    返真 id。InMemoryJobStore 路径用线程级 _draft_for_test in-memory 模拟;
    DbJobStore 路径直连 Postgres 写 researches 表。
    """
    log = structlog.get_logger("ai_engine.runner")
    try:
        outcome = await run_one_available_job(
            store=store, adapter=adapter,
            draft_factory=_make_draft_factory(store),
        )
        if outcome is None:
            log.warning(
                "ai-engine.background.no_job",
                request_id=request_id,
                job_id=job_id,
            )
        else:
            log.info(
                "ai-engine.background.done",
                request_id=request_id,
                job_id=outcome.job_id,
                final_status=outcome.final_status,
                current_step=outcome.current_step,
                cost_cents=outcome.cost.cost_cents,
            )
    except Exception as exc:
        log.exception(
            "ai-engine.background.unhandled",
            request_id=request_id,
            job_id=job_id,
            error_type=type(exc).__name__,
            error_message=str(exc)[:300],
        )
        # W2 review 修正:用 log.exception 已输出完整 traceback(JSON 渲染层
        # format_exc_info 链没装,但 stdlib logger 会写到 stderr 的 unhandled
        # 行附带 "Traceback (most recent call last): ...")。这里不再额外
        # print,避免把请求 body / env 变量刷到 stderr。


DraftFactory = Callable[
    [JobSnapshot, tuple[AdapterSource, ...], str, dict[str, object] | None],
    Awaitable[str | None],
]


def _make_draft_factory(store: JobStore) -> DraftFactory:
    """根据 store 类型返回对应的 draft_factory (INSERT research row 返 id)。

    - DbJobStore: 复用 psycopg pool 直接 INSERT researches,返真 id;
    - InMemoryJobStore: 单元测试用,在 _drafts_for_tests dict 里写一份返 uuid。
    """
    from ai_engine.job_runner.db_store import DbJobStore as _Db

    if isinstance(store, _Db):

        async def _factory(
            snapshot: JobSnapshot,
            sources: tuple[AdapterSource, ...],
            output_text: str,
            review_details: dict[str, object] | None = None,
        ) -> str | None:
            assert isinstance(store, _Db)
            # The runner may be retried after the draft INSERT committed but
            # before mark_terminal committed. Derive the draft id from the job
            # id so replaying the same job cannot create duplicate drafts.
            new_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"deep-research:ai-job:{snapshot.job_id}"))
            body = output_text.strip()
            origin_sha256 = hashlib.sha256(body.encode("utf-8")).hexdigest()
            sql = (
                'INSERT INTO "researches" '
                '("id", "type", "status", "title", "body", "authorId", "creationMethod", '
                ' "reviewStatus", "reviewAttempts", "reviewSummary", "reviewClaims", "reviewDetails", "reviewedAt", '
                ' "aiAssisted", "originContentSha256", "createdAt", "updatedAt") '
                "VALUES (%s, 'research', 'draft', %s, %s, %s, 'ai_research', %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, NULL, true, %s, now(), now()) "
                'ON CONFLICT ("id") DO NOTHING'
            )
            review_status = review_details.get("status") if review_details else None
            review_attempts = _json_int(review_details.get("attempts", 0)) if review_details else 0
            review_summary = (
                {
                    "corrected_count": review_details.get("corrected_count", 0),
                    "unverified_count": review_details.get("unverified_count", 0),
                    "not_judged_count": review_details.get("not_judged_count", 0),
                    "execution_failed_claim_count": review_details.get("execution_failed_claim_count", 0),
                    "disputed_count": review_details.get("disputed_count", 0),
                    "contradicted_count": review_details.get("contradicted_count", 0),
                    "factual_claim_count": review_details.get("factual_claim_count", 0),
                    "citation_count": review_details.get("citation_count", 0),
                    "citation_pending_count": review_details.get("citation_pending_count", 0),
                    "evidence_binding_repaired_count": review_details.get("evidence_binding_repaired_count", 0),
                    "coverage_status": review_details.get("coverage_status", "complete"),
                    "review_outcome": review_details.get("review_outcome"),
                }
                if review_details
                else None
            )
            review_claims = review_details.get("claims", []) if review_details else []
            async with store.pool.connection() as conn:
                async with conn.transaction():
                    await conn.execute(
                        sql,
                        (
                            new_id,
                            snapshot.topic[:300],
                            body,
                            snapshot.requester_id,
                            review_status,
                            review_attempts,
                            json.dumps(review_summary, ensure_ascii=False) if review_summary is not None else None,
                            json.dumps(review_claims, ensure_ascii=False),
                            json.dumps(review_details, ensure_ascii=False) if review_details is not None else None,
                            origin_sha256,
                        ),
                    )
                    for source in sources:
                        await conn.execute(
                            'INSERT INTO "research_sources" '
                            '("researchId", "sourceRef", "canonicalKey", "title", "description", "createdAt") '
                            'VALUES (%s, %s::jsonb, %s, %s, %s, now()) '
                            'ON CONFLICT ("researchId", "canonicalKey") DO UPDATE SET '
                            '"title" = EXCLUDED."title", "description" = EXCLUDED."description"',
                            (
                                new_id,
                                json.dumps(source.source_ref, ensure_ascii=False),
                                source.canonical_key[:512],
                                _clip_db_text(source.title, 300),
                                _clip_db_text(source.snippet, 1000),
                            ),
                        )
                    if snapshot.report_type != "summary_brief":
                        review_id = str(
                            uuid.uuid5(
                                uuid.NAMESPACE_URL,
                                f"deep-research:ai-job:{snapshot.job_id}:review:1",
                            )
                        )
                        await conn.execute(
                            'INSERT INTO "research_review_runs" '
                            '("id", "researchId", "aiResearchJobId", "revisionHash", '
                            ' "sourceSnapshotHash", "policyVersion", "executionStatus", '
                            ' "attempt", "details", "triggeredBy", "createdAt") '
                            'VALUES (%s, %s, %s, %s, %s, %s, \'queued\', 0, %s::jsonb, \'system\', now()) '
                            'ON CONFLICT ("id") DO NOTHING',
                            (
                                review_id,
                                new_id,
                                snapshot.job_id,
                                origin_sha256,
                                _review_source_snapshot_hash(sources),
                                "fact-review-v1",
                                json.dumps(
                                    {
                                        "phase": "queued",
                                        "status": "queued",
                                        "attempts": 0,
                                    },
                                    ensure_ascii=False,
                                ),
                            ),
                        )
            return new_id

        return _factory

    async def _in_memory_factory(
        snapshot: JobSnapshot,
        sources: tuple[AdapterSource, ...],
        output_text: str,
        review_details: dict[str, object] | None = None,
    ) -> str | None:
        # InMemory 测试路径:用全局 dict 记录 fake draft id。
        # 让 _background_run 测试 / FakeAdapter 测试可走 succeeded。
        from ai_engine.job_runner.db_store import _drafts_for_tests
        new_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"deep-research:ai-job:{snapshot.job_id}"))
        _drafts_for_tests[new_id] = {
            "topic": snapshot.topic,
            "requester_id": snapshot.requester_id,
            "sources": len(sources),
            "body": output_text,
            "review": review_details or {},
        }
        return new_id

    return _in_memory_factory


# ─── 列表（兼容 GET /api/ai/jobs） ───────────────────────────────────────────
#
# 历史表（v0）：列出某用户最近的 ai_research_jobs 行。
# 鉴权依赖 BFF：web 在调用本端前已 requireUser(query req.cookie) 并把 u.id
# 注入 querystring 的 requester_id。本端用 Pydantic `Query(min_length=36,
# max_length=36)` 强制 UUID —— 漏传/伪造直接 422，关闭 IDOR。
# "已发布" 判定在 SQL 层 LEFT JOIN researches WHERE status='published'，
# BFF 拿到 publishedResearchId 后挂"已发布" pill，无需前端跑 N+1。


# 只接受枚举里的合法值,空白/None 等同于"全部"
_VALID_LIST_STATUSES: tuple[AiJobStatus, ...] = (
    "queued", "running", "partial", "succeeded", "failed", "cancelled",
)


def _parse_status_filter(raw: str | None) -> tuple[AiJobStatus, ...] | None:
    """Comma-separated subset of AiJobStatus. None / "" → no filter.

    Raises HTTPException(422) on unknown values so the BFF surfaces the
    reason instead of getting an opaque empty list.
    """
    if not raw:
        return None
    out: list[AiJobStatus] = []
    for piece in (p.strip() for p in raw.split(",")):
        if not piece:
            continue
        if piece not in _VALID_LIST_STATUSES:
            # Keep it inside the catch-block so the BFF can translate.
            raise HTTPException(
                status_code=422,
                detail={"code": "VALIDATION_FAILED",
                        "message": f"unknown status {piece!r}"},
            )
        if piece not in out:
            out.append(piece)
    return tuple(out) if out else None


@app.get("/api/ai/jobs", response_model=ListAiJobsResponse)
async def list_ai_jobs(
    request: Request,
    store: Annotated[JobStore, Depends(_store_singleton)],
    requester_id: Annotated[str, Query(min_length=36, max_length=36)],
    status: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ListAiJobsResponse:
    rows = await store.list_jobs(
        requester_id=requester_id,
        status_filter=_parse_status_filter(status),
        limit=limit,
        offset=offset,
    )
    total = await store.count_jobs(
        requester_id=requester_id,
        status_filter=_parse_status_filter(status),
    )

    items: list[ListAiJobsItem] = []
    for view in rows:
        snap = view.snapshot
        output_text = getattr(view, "output_text", None)
        draft_research_id = getattr(view, "draft_research_id", None)
        draft_research_body = getattr(view, "draft_research_body", None)
        items.append(
            ListAiJobsItem(
                job_id=snap.job_id,
                topic=snap.topic,
                status=snap.status,
                current_step=snap.current_step,
                report_type=snap.report_type,
                report_length=snap.report_length,
                has_report=bool(output_text or draft_research_id),
                captured_sources_count=len(getattr(view, "last_sources", ())),
                deliverable_status=_research_deliverable_status(
                    output_text or draft_research_body,
                    draft_research_id,
                ),
                source_policy=snap.source_policy,
                source_refs=[cast(dict[str, object], dict(ref)) for ref in snap.source_refs],
                token_input_total=getattr(view, "last_token_in", 0),
                token_output_total=getattr(view, "last_token_out", 0),
                cost_cents=getattr(view, "last_cost_cents", 0),
                draft_research_id=draft_research_id,
                published_research_id=getattr(view, "published_research_id", None),
                error_code=getattr(view, "last_error_code", None),
                error_message=getattr(view, "last_error_message", None),
                error_details=getattr(view, "last_error_details", None),
                review_status=(
                    getattr(view, "review_details", {}).get("status")
                    if isinstance(getattr(view, "review_details", None), dict)
                    and isinstance(getattr(view, "review_details", {}).get("status"), str)
                    else None
                ),
                created_at=_iso(getattr(view, "created_at", None)),
                updated_at=_iso(getattr(view, "updated_at", None)),
                completed_at=_iso(getattr(view, "completed_at", None)),
            )
        )
    return ListAiJobsResponse(
        items=items,
        total=total,
        limit=limit,
        offset=offset,
    )


def _iso(value: datetime | None) -> str | None:
    """ISO-8601 UTC string for the row timestamp; empty string → None."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


@app.get("/api/ai/jobs/{job_id}", response_model=SubmitAiJobResponse)
async def get_ai_job(
    job_id: Annotated[str, Path(min_length=1)],
    request: Request,
    store: Annotated[JobStore, Depends(_store_singleton)],
) -> SubmitAiJobResponse:
    row: Any = await _store_get_row(store, job_id)
    if row is None:
        raise _http_error("AI_JOB_NOT_FOUND", f"job {job_id} not found")
    snap: JobSnapshot = row.snapshot
    last_sources = getattr(row, "last_sources", ())
    last_failed_sources = getattr(row, "last_failed_sources", ())
    persisted_review = getattr(row, "review_details", None)
    research_progress = (
        persisted_review.get("research_progress")
        if isinstance(persisted_review, dict)
        and isinstance(persisted_review.get("research_progress"), dict)
        else None
    )
    # W7 (工程师 B): an inferred conclusion is one that succeeded with
    # zero grounded sources. We surface this on the response so the
    # BFF / UI can render it differently.
    is_inferred = snap.status == "succeeded" and len(last_sources) == 0
    error_stage = snap.current_step if snap.status in ("failed", "partial") else None
    return SubmitAiJobResponse(
        job_id=snap.job_id,
        status="stored",
        topic=snap.topic,
        final_status=snap.status,
        current_step=snap.current_step,
        sources_count=len(last_sources),
        partial_sources_count=len(last_sources),
        failed_sources_count=len(last_failed_sources),
        error_stage=error_stage,
        draft_research_id=getattr(row, "draft_research_id", None),
        report_type=snap.report_type,
        output_text=getattr(row, "output_text", None),
        token_input_total=getattr(row, "last_token_in", 0),
        token_output_total=getattr(row, "last_token_out", 0),
        cost_cents=getattr(row, "last_cost_cents", 0),
        search_count=len(last_sources),
        error_code=getattr(row, "last_error_code", None),
        error_message=getattr(row, "last_error_message", None),
        error_details=getattr(row, "last_error_details", None),
        request_id=getattr(request.state, "request_id", None),
        started_at=_iso(getattr(row, "started_at", None)),
        created_at=_iso(getattr(row, "created_at", None)),
        completed_at=_iso(getattr(row, "completed_at", None)),
        is_inferred=is_inferred,
        review=persisted_review,
        research_progress=research_progress,
    )


async def _store_get_row(store: JobStore, job_id: str) -> Any | None:
    """Read a job row across sync (InMemory) and async (DB) stores."""
    maybe = store.get_row(job_id)
    if inspect.isawaitable(maybe):
        return await maybe
    return maybe


@app.post("/api/ai/jobs/{job_id}/cancel", response_model=CancelAiJobResponse)
async def cancel_ai_job(
    job_id: Annotated[str, Path(min_length=1)],
    store: Annotated[JobStore, Depends(_store_singleton)],
) -> CancelAiJobResponse:
    row = await _store_get_row(store, job_id)
    if row is None:
        raise _http_error("AI_JOB_NOT_FOUND", f"job {job_id} not found")
    current_status = row.snapshot.status
    if current_status not in {"queued", "running"}:
        raise _http_error(
            "AI_JOB_NOT_CANCELLABLE",
            f"job {job_id} is already {current_status}",
        )

    previous_status = await store.cancel_job(job_id)
    if previous_status is None:
        raise _http_error(
            "AI_JOB_NOT_CANCELLABLE",
            f"job {job_id} changed state before cancellation",
        )

    # The DB queue is authoritative. Adapter cancellation is best-effort: a
    # process restart legitimately leaves no matching in-memory adapter job.
    adapter = _adapter_singleton()
    if previous_status == "running":
        try:
            await adapter.cancel(job_id)
        except AdapterError as exc:
            structlog.get_logger("ai_engine.cancel").warning(
                "ai-engine.cancel.adapter_missed",
                job_id=job_id,
                error_code=exc.code,
            )
    return CancelAiJobResponse(
        job_id=job_id,
        was_queued=previous_status == "queued",
        was_running=previous_status == "running",
    )


# ──────────────────────────────────────────────────────────────────────
# W4-2: POST /api/shares — user URL share → pending_review → admin approval
# ──────────────────────────────────────────────────────────────────────


class ShareUrlRequest(BaseModel):
    """Mirrors `packages/shared/src/schemas.ts ShareUrlInput`.

    Defence-in-depth validation in `validate_share_input` (server/share.py)
    runs after this Pydantic check.

    The BFF sends `userNote` (camelCase) per the shared Zod schema; we
    accept both `userNote` and `user_note` here. Same for `requesterId`.
    """

    url: str = Field(min_length=1, max_length=2048)
    user_note: str | None = Field(default=None, max_length=500, alias="userNote")
    requester_id: str = Field(
        default="00000000-0000-0000-0000-000000000001",
        alias="requesterId",
    )

    model_config = {"populate_by_name": True}


class ShareSubmitResponse(BaseModel):
    summary_id: str
    status: str
    canonical_url: str
    request_id: str | None = None


@app.post(
    "/api/shares",
    response_model=ShareSubmitResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def submit_share(
    body: ShareUrlRequest,
    request: Request,
) -> ShareSubmitResponse:
    """Compatibility ingress that queues the frozen share_submissions model.

    The Web BFF normally inserts this row itself. If it forwards here instead,
    this endpoint follows the same queue and never invokes the retired
    ``server.share`` summary path.
    """
    from ai_engine.ingestion.pipeline import canonicalize_url
    from ai_engine.job_runner.db_store import DbJobStore as _Db

    parts = urlsplit(body.url)
    canonical = canonicalize_url(body.url)
    if parts.scheme not in {"http", "https"} or not parts.hostname or not canonical:
        raise _http_error("VALIDATION_FAILED", "url must be an HTTP(S) URL")
    request_id = getattr(request.state, "request_id", None)
    store = _store_singleton()
    if not isinstance(store, _Db):
        return ShareSubmitResponse(
            summary_id="00000000-0000-0000-0000-000000000099",
            status="pending",
            canonical_url=canonical,
            request_id=request_id,
        )

    submission_id = str(uuid.uuid4())
    async with store.pool.connection() as conn:
        async with conn.transaction():
            existing = await (
                await conn.execute(
                    'SELECT "id", "status" FROM "share_submissions" '
                    'WHERE "submitterId" = %s AND "canonicalUrl" = %s '
                    "AND \"status\" = 'pending' LIMIT 1",
                    (body.requester_id, canonical),
                )
            ).fetchone()
            if existing is not None:
                existing_row = cast(dict[str, Any], existing)
                return ShareSubmitResponse(
                    summary_id=str(existing_row["id"]),
                    status=str(existing_row["status"]),
                    canonical_url=canonical,
                    request_id=request_id,
                )
            await conn.execute(
                'INSERT INTO "share_submissions" '
                '("id", "submitterId", "url", "canonicalUrl", "userNote", '
                '"status", "createdAt", "updatedAt") '
                "VALUES (%s, %s, %s, %s, %s, 'pending', now(), now())",
                (
                    submission_id,
                    body.requester_id,
                    body.url,
                    canonical,
                    body.user_note,
                ),
            )
    return ShareSubmitResponse(
        summary_id=submission_id,
        status="pending",
        canonical_url=canonical,
        request_id=request_id,
    )


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────


def _http_error(code: str, message: str) -> HTTPException:
    """Convert a contract error code into a FastAPI HTTPException."""
    if code not in ERROR_CODES:
        code = "INTERNAL"
    http_status = HTTP_STATUS.get(code, 500)
    return HTTPException(
        status_code=http_status,
        detail={"code": code, "message": message},
    )


def _http_error_with_details(
    code: str, message: str, details: dict[str, object]
) -> HTTPException:
    """Like ``_http_error`` but attaches a `details` object for the BFF."""
    if code not in ERROR_CODES:
        code = "INTERNAL"
    http_status = HTTP_STATUS.get(code, 500)
    return HTTPException(
        status_code=http_status,
        detail={"code": code, "message": message, "details": details},
    )


__all__ = ["app", "build_adapter", "build_store", "FakeAdapter"]


# Quiet linter — referenced by future test files; avoid unused warning.
_ = (datetime, timezone, AI_JOB_STATUS, REPORT_TYPE, SOURCE_POLICY, CREATION_METHOD)
