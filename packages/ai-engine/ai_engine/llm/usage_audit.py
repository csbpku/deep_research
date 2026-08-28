"""Best-effort persisted audit records for individual LLM attempts."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

import psycopg

logger = logging.getLogger("ai_engine.llm.usage_audit")


@dataclass(slots=True, frozen=True)
class LlmUsageAttempt:
    operation: str
    provider: str
    requested_model: str
    request_id: str | None = None
    actual_model: str | None = None
    fallback_model: str | None = None
    used_fallback: bool = False
    status: str = "succeeded"
    error_kind: str | None = None
    error_message: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    cost_cents: int | None = None
    latency_ms: int | None = None
    primary_model: str | None = None
    fallback_reason: str | None = None
    attempt_count: int = 1
    final_model: str | None = None
    degraded: bool = False
    endpoint: str | None = None
    circuit_state: str | None = None


async def record_llm_usage(attempt: LlmUsageAttempt) -> None:
    """Persist an attempt without turning audit availability into an outage."""
    if os.environ.get("LLM_USAGE_AUDIT_ENABLED", "true").lower() == "false":
        return
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        return
    try:
        async with await psycopg.AsyncConnection.connect(dsn) as connection:
            await connection.execute(
                'INSERT INTO "llm_usage_events" '
                '("operation", "requestId", "provider", "requestedModel", '
                '"actualModel", "fallbackModel", "usedFallback", "status", '
                '"errorKind", "errorMessage", "inputTokens", "outputTokens", '
                '"costCents", "latencyMs", "primaryModel", "fallbackReason", '
                '"attemptCount", "finalModel", "degraded", "endpoint", '
                '"circuitState") '
                'VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, '
                '%s, %s, %s, %s, %s, %s, %s, %s, %s)',
                (
                    attempt.operation[:120],
                    attempt.request_id[:128] if attempt.request_id else None,
                    attempt.provider[:32],
                    attempt.requested_model[:160],
                    attempt.actual_model[:160] if attempt.actual_model else None,
                    attempt.fallback_model[:160] if attempt.fallback_model else None,
                    attempt.used_fallback,
                    attempt.status[:16],
                    attempt.error_kind[:64] if attempt.error_kind else None,
                    attempt.error_message[:500] if attempt.error_message else None,
                    attempt.input_tokens,
                    attempt.output_tokens,
                    attempt.cost_cents,
                    attempt.latency_ms,
                    attempt.primary_model[:160] if attempt.primary_model else None,
                    attempt.fallback_reason[:120] if attempt.fallback_reason else None,
                    attempt.attempt_count,
                    attempt.final_model[:160] if attempt.final_model else None,
                    attempt.degraded,
                    attempt.endpoint[:300] if attempt.endpoint else None,
                    attempt.circuit_state[:16] if attempt.circuit_state else None,
                ),
            )
            await connection.commit()
    except Exception:
        logger.warning("ai-engine.llm.usage_audit_failed", exc_info=True)


async def record_llm_degraded(
    *,
    operation: str,
    primary_model: str,
    reason: str,
    request_id: str | None = None,
) -> None:
    """Record a deterministic business fallback that made no LLM call."""
    provider, separator, model = primary_model.partition(":")
    await record_llm_usage(
        LlmUsageAttempt(
            operation=operation,
            request_id=request_id,
            provider=provider or "unknown",
            requested_model=model if separator else primary_model,
            primary_model=primary_model,
            fallback_reason=reason,
            final_model=None,
            degraded=True,
            status="degraded",
        )
    )
