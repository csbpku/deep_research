"""Research engine adapter layer.

Exposes a single Protocol — `ResearchEngineAdapter` — that the worker
calls regardless of whether the underlying engine is `fake`, `claude`, or
`gpt_researcher`. Business code never depends on a vendor's data shape
(see IMPLEMENTATION_PLAN §一全局 DoD "业务层不直接依赖 gpt-researcher 数据结构").

Subpackages:
- ai_engine.adapters.base   — Protocol + Pydantic DTOs
- ai_engine.adapters.fake   — deterministic in-memory implementation
- ai_engine.adapters.claude — Anthropic SDK (Week 2 ships; ADR 0004 #5)
- ai_engine.adapters.gpt_researcher — REJECTED by ADR 0004

The factory `build_adapter()` reads `AI_ENGINE_ADAPTER` (default: fake) so
tests and the local skeleton run with zero API keys.
"""

from ai_engine.adapters.base import (
    AdapterCancelOutcome,
    AdapterHealth,
    AdapterSource,
    AdapterStatus,
    CostMetrics,
    ResearchEngineAdapter,
    ResearchRequest,
    build_adapter,
)

# Lazy re-export so tests that don't need anthropic don't import the SDK.
try:  # pragma: no cover — defensive
    from ai_engine.adapters.claude import ClaudeAdapter  # noqa: F401
except ImportError:  # pragma: no cover
    ClaudeAdapter = None  # type: ignore[assignment,misc]

__all__ = [
    "AdapterCancelOutcome",
    "AdapterHealth",
    "AdapterSource",
    "AdapterStatus",
    "ClaudeAdapter",
    "CostMetrics",
    "ResearchEngineAdapter",
    "ResearchRequest",
    "build_adapter",
]