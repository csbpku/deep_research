"""Conservative, concurrency-safe limits for one multi-call unit of work.

Context variables propagate to adapter/chunk tasks. Each wire attempt reserves
its full prompt plus maximum output against every enclosing scope before send.
Unknown failures consume that reservation; retries cannot reset the allowance.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from functools import wraps
import os
from collections.abc import Awaitable, Callable, Iterator
from typing import ParamSpec, TypeVar

P = ParamSpec("P")
R = TypeVar("R")


class WorkBudgetExceeded(RuntimeError):
    error_code = "MODEL_WORK_BUDGET_EXCEEDED"

    def __init__(self, scope: str, message: str | None = None) -> None:
        self.scope = scope
        super().__init__(
            message or f"model work budget exhausted ({scope}); preserve evidence for explicit retry"
        )


@dataclass
class WorkBudget:
    scope: str
    max_calls: int
    max_tokens: int
    calls: int = 0
    charged_tokens: int = 0
    pending_tokens: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    exhausted: bool = False


_budgets: ContextVar[tuple[WorkBudget, ...]] = ContextVar("llm_work_budgets", default=())
_DEFAULTS = {"radar_article": (8, 48_000), "radar_source": (100, 160_000), "radar_run": (160, 250_000)}


def current_work_budget(scope: str) -> WorkBudget | None:
    return next((b for b in reversed(_budgets.get()) if b.scope == scope), None)


@contextmanager
def bind_work_budget(budget: WorkBudget) -> Iterator[WorkBudget]:
    token = _budgets.set((*_budgets.get(), budget))
    try:
        yield budget
    finally:
        _budgets.reset(token)


def budgeted(scope: str) -> Callable[[Callable[P, Awaitable[R]]], Callable[P, Awaitable[R]]]:
    def decorate(fn: Callable[P, Awaitable[R]]) -> Callable[P, Awaitable[R]]:
        @wraps(fn)
        async def wrapped(*args: P.args, **kwargs: P.kwargs) -> R:
            # Pipeline -> sync -> source retries share the enclosing run limit.
            if current_work_budget(scope) is not None:
                return await fn(*args, **kwargs)
            calls, tokens = _DEFAULTS[scope]
            calls = int(os.environ.get(f"{scope.upper()}_MAX_CALLS", calls))
            tokens = int(os.environ.get(f"{scope.upper()}_MAX_TOKENS", tokens))
            if calls < 1 or tokens < 1:
                raise ValueError(f"{scope} budgets must be positive")
            with bind_work_budget(WorkBudget(scope, calls, tokens)):
                return await fn(*args, **kwargs)

        return wrapped

    return decorate


@dataclass
class Attempt:
    budgets: tuple[WorkBudget, ...]
    estimated_tokens: int
    actual: tuple[int, int] | None = None

    def record(self, input_tokens: int, output_tokens: int) -> None:
        self.actual = (max(0, input_tokens), max(0, output_tokens))


@contextmanager
def reserve_attempt(estimated_tokens: int) -> Iterator[Attempt]:
    budgets = _budgets.get()
    estimate = max(1, estimated_tokens)
    # No await between checking and reserving: sibling asyncio tasks cannot
    # oversubscribe a shared run/source allowance.
    for b in budgets:
        if (
            b.exhausted
            or b.calls + 1 > b.max_calls
            or b.charged_tokens + b.pending_tokens + estimate > b.max_tokens
        ):
            b.exhausted = True
            raise WorkBudgetExceeded(b.scope)
    for b in budgets:
        b.calls += 1
        b.pending_tokens += estimate
    attempt = Attempt(budgets, estimate)
    try:
        yield attempt
    finally:
        for b in budgets:
            b.pending_tokens -= estimate
            if attempt.actual is None:
                b.charged_tokens += estimate
            else:
                inp, out = attempt.actual
                b.input_tokens += inp
                b.output_tokens += out
                b.charged_tokens += inp + out if inp + out else estimate
