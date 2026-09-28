"""Atomic token reservations for configurable per-user and platform budgets."""

from __future__ import annotations

import contextvars
import logging
import os
import uuid
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from typing import AsyncIterator, Iterator

import psycopg

from ai_engine.text_chunking import count_text_tokens

logger = logging.getLogger("ai_engine.llm.token_budget")
_budget_user_id: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "llm_budget_user_id", default=None
)
_budget_task: contextvars.ContextVar["TokenBudgetTask | None"] = contextvars.ContextVar(
    "llm_budget_task", default=None
)


@dataclass(frozen=True, slots=True)
class TokenBudgetSettings:
    user_limit: int
    user_period_days: int
    platform_daily_limit: int
    reservation_ttl_seconds: int

    @property
    def enabled(self) -> bool:
        return self.user_limit > 0 or self.platform_daily_limit > 0


@dataclass(frozen=True, slots=True)
class TokenReservation:
    id: str
    reserved_tokens: int


@dataclass(slots=True)
class TokenBudgetTask:
    reservation: TokenReservation | None
    actual_tokens: int = 0

    def record(self, input_tokens: int, output_tokens: int) -> None:
        self.actual_tokens += max(0, input_tokens) + max(0, output_tokens)


class TokenBudgetError(RuntimeError):
    """Base class for fail-closed budget errors."""


class TokenBudgetExceeded(TokenBudgetError):
    status_code = 429

    def __init__(self, *, scope: str, used: int, limit: int, requested: int) -> None:
        self.scope = scope
        self.used = used
        self.limit = limit
        self.requested = requested
        label = "个人周期" if scope == "user" else "平台今日"
        super().__init__(f"{label}模型 token 额度不足，已暂停新的模型调用")

    def details(self) -> dict[str, int | str]:
        return {
            "scope": self.scope,
            "used": self.used,
            "limit": self.limit,
            "requested": self.requested,
        }


class TokenBudgetUnavailable(TokenBudgetError):
    """Raised when an enabled budget cannot be checked or recorded."""


def token_budget_settings() -> TokenBudgetSettings:
    def read_int(name: str, default: int, *, minimum: int = 0) -> int:
        raw = os.environ.get(name)
        if raw is None or not raw.strip():
            return default
        try:
            value = int(raw)
        except ValueError as exc:
            raise ValueError(f"{name} must be an integer") from exc
        if value < minimum:
            raise ValueError(f"{name} must be >= {minimum}")
        return value

    return TokenBudgetSettings(
        user_limit=read_int("LLM_TOKEN_BUDGET_USER_LIMIT", 0),
        user_period_days=read_int("LLM_TOKEN_BUDGET_USER_PERIOD_DAYS", 30, minimum=1),
        platform_daily_limit=read_int("LLM_TOKEN_BUDGET_PLATFORM_DAILY_LIMIT", 0),
        reservation_ttl_seconds=read_int(
            "LLM_TOKEN_BUDGET_RESERVATION_TTL_SECONDS", 3600, minimum=30
        ),
    )


def estimate_call_tokens(
    *, user_prompt: str, system_prompt: str | None, max_output_tokens: int
) -> int:
    prompt_tokens = count_text_tokens(user_prompt)
    if system_prompt:
        prompt_tokens += count_text_tokens(system_prompt)
    return max(1, prompt_tokens + max(0, max_output_tokens))


@contextmanager
def bind_budget_user(user_id: str | None) -> Iterator[None]:
    """Bind a trusted authenticated user to model calls in this async context."""
    token = _budget_user_id.set(str(user_id) if user_id else None)
    try:
        yield
    finally:
        _budget_user_id.reset(token)


def current_budget_user() -> str | None:
    return _budget_user_id.get()


def current_budget_task() -> TokenBudgetTask | None:
    return _budget_task.get()


@asynccontextmanager
async def reserve_llm_token_task(
    *,
    operation: str,
    estimated_tokens: int,
    user_id: str | None = None,
) -> AsyncIterator[TokenBudgetTask]:
    """Reserve a complete multi-call task before its first model request."""
    if _budget_task.get() is not None:
        raise RuntimeError("nested token-budget tasks are not supported")
    reservation = await reserve_llm_tokens(
        operation=operation,
        requested_tokens=max(0, estimated_tokens),
        user_id=user_id,
    )
    task = TokenBudgetTask(reservation=reservation)
    token = _budget_task.set(task)
    try:
        yield task
    except BaseException:
        if reservation is not None:
            if task.actual_tokens:
                await settle_llm_tokens(reservation, task.actual_tokens)
            else:
                await release_llm_tokens(reservation)
        raise
    else:
        if reservation is not None:
            if task.actual_tokens:
                await settle_llm_tokens(reservation, task.actual_tokens)
            else:
                await release_llm_tokens(reservation)
    finally:
        _budget_task.reset(token)


async def reserve_llm_tokens(
    *, operation: str, requested_tokens: int, user_id: str | None = None
) -> TokenReservation | None:
    """Atomically hold estimated input plus maximum output before a model call.

    A zero limit disables that scope. When either scope is enabled, a missing
    database or ledger table is an error rather than a quota bypass.
    """
    settings = token_budget_settings()
    if not settings.enabled:
        return None
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise TokenBudgetUnavailable("token budget is enabled but DATABASE_URL is missing")

    identity = user_id if user_id is not None else current_budget_user()
    if identity is not None:
        try:
            identity = str(uuid.UUID(identity))
        except ValueError as exc:
            if settings.user_limit > 0:
                raise TokenBudgetUnavailable("token budget user identity is not a UUID") from exc
            identity = None
    now = datetime.now(timezone.utc)
    user_period_start = now - timedelta(days=settings.user_period_days)
    platform_day_start = datetime.combine(now.date(), time.min, tzinfo=timezone.utc)
    reservation_id = str(uuid.uuid4())

    try:
        async with await psycopg.AsyncConnection.connect(dsn) as connection:
            async with connection.transaction():
                # A short global lock keeps the two-scope check and insert
                # atomic across engine processes; per-user locking documents
                # the ownership boundary and leaves room for a later sharded gate.
                await connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtext('llm-token-budget:global'))"
                )
                if identity is not None:
                    await connection.execute(
                        "SELECT pg_advisory_xact_lock(hashtext(%s))",
                        (f"llm-token-budget:user:{identity}",),
                    )
                await connection.execute(
                    'UPDATE "llm_token_budget_events" SET "status" = \'released\' '
                    'WHERE "status" = \'reserved\' AND "expiresAt" <= now()'
                )

                if settings.user_limit > 0 and identity is not None:
                    row = await (
                        await connection.execute(
                            'SELECT COALESCE(SUM(CASE WHEN "status" = \'reserved\' '
                            'THEN "reservedTokens" ELSE COALESCE("actualTokens", 0) END), 0) '
                            'FROM "llm_token_budget_events" WHERE "userId" = %s '
                            'AND ("createdAt" >= %s OR "status" = \'reserved\') '
                            'AND "status" IN (\'reserved\', \'settled\')',
                            (identity, user_period_start),
                        )
                    ).fetchone()
                    used = int(row[0] or 0) if row is not None else 0
                    if used + requested_tokens > settings.user_limit:
                        raise TokenBudgetExceeded(
                            scope="user", used=used, limit=settings.user_limit,
                            requested=requested_tokens,
                        )

                if settings.platform_daily_limit > 0:
                    row = await (
                        await connection.execute(
                            'SELECT COALESCE(SUM(CASE WHEN "status" = \'reserved\' '
                            'THEN "reservedTokens" ELSE COALESCE("actualTokens", 0) END), 0) '
                            'FROM "llm_token_budget_events" WHERE '
                            '("createdAt" >= %s OR "status" = \'reserved\') '
                            'AND "status" IN (\'reserved\', \'settled\')',
                            (platform_day_start,),
                        )
                    ).fetchone()
                    used = int(row[0] or 0) if row is not None else 0
                    if used + requested_tokens > settings.platform_daily_limit:
                        raise TokenBudgetExceeded(
                            scope="platform_daily", used=used,
                            limit=settings.platform_daily_limit,
                            requested=requested_tokens,
                        )

                await connection.execute(
                    'INSERT INTO "llm_token_budget_events" '
                    '("id", "userId", "operation", "reservedTokens", "status", '
                    '"expiresAt", "createdAt") '
                    'VALUES (%s, %s, %s, %s, \'reserved\', now() + (%s * interval \'1 second\'), now())',
                    (
                        reservation_id,
                        identity,
                        operation[:120],
                        requested_tokens,
                        settings.reservation_ttl_seconds,
                    ),
                )
        return TokenReservation(reservation_id, requested_tokens)
    except (TokenBudgetExceeded, TokenBudgetUnavailable):
        raise
    except Exception as exc:
        logger.exception("llm.token_budget.reserve_failed")
        raise TokenBudgetUnavailable("token budget could not be checked") from exc


async def settle_llm_tokens(reservation: TokenReservation, actual_tokens: int) -> None:
    await _finish_reservation(reservation, status="settled", actual_tokens=max(0, actual_tokens))


async def release_llm_tokens(reservation: TokenReservation) -> None:
    await _finish_reservation(reservation, status="released", actual_tokens=None)


async def _finish_reservation(
    reservation: TokenReservation, *, status: str, actual_tokens: int | None
) -> None:
    try:
        dsn = os.environ.get("DATABASE_URL")
        if not dsn:
            raise TokenBudgetUnavailable("DATABASE_URL disappeared before reservation settlement")
        async with await psycopg.AsyncConnection.connect(dsn) as connection:
            async with connection.transaction():
                await connection.execute(
                    "SELECT pg_advisory_xact_lock(hashtext('llm-token-budget:global'))"
                )
                await connection.execute(
                    'UPDATE "llm_token_budget_events" SET "status" = %s, '
                    '"actualTokens" = %s, "settledAt" = now() '
                    'WHERE "id" = %s AND "status" IN (\'reserved\', \'released\')',
                    (status, actual_tokens, reservation.id),
                )
        if status == "settled" and actual_tokens is not None and actual_tokens > reservation.reserved_tokens:
            logger.warning(
                "llm.token_budget.actual_exceeded_reservation",
                extra={
                    "reservation_id": reservation.id,
                    "reserved_tokens": reservation.reserved_tokens,
                    "actual_tokens": actual_tokens,
                },
            )
    except TokenBudgetUnavailable:
        raise
    except Exception as exc:
        logger.exception("llm.token_budget.settlement_failed")
        raise TokenBudgetUnavailable("token budget reservation could not be settled") from exc
