"""Research engine adapter layer.

Exposes a single Protocol — `ResearchEngineAdapter` — that the worker
calls regardless of whether the underlying engine is `fake` or
`gpt_researcher`. Business code never depends on a vendor's data shape
(see IMPLEMENTATION_PLAN §一全局 DoD "业务层不直接依赖 gpt-researcher 数据结构").

Subpackages:
- ai_engine.adapters.base           — Protocol + Pydantic DTOs
- ai_engine.adapters.fake           — deterministic in-memory implementation
- ai_engine.adapters.gpt_researcher — GPT Researcher (primary engine, ADR 0004)

The factory `build_adapter()` reads `AI_ENGINE_ADAPTER` (default:
gpt_researcher) so tests and CI can opt into `fake` with zero API keys.
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

# Lazy re-export so tests that don't need gpt-researcher don't import it.
try:  # pragma: no cover — defensive
    from ai_engine.adapters.gpt_researcher import GptResearcherAdapter  # noqa: F401
except ImportError:  # pragma: no cover
    GptResearcherAdapter = None  # type: ignore[assignment,misc]

__all__ = [
    "AdapterCancelOutcome",
    "AdapterHealth",
    "AdapterSource",
    "AdapterStatus",
    "CostMetrics",
    "GptResearcherAdapter",
    "ResearchEngineAdapter",
    "ResearchRequest",
    "build_adapter",
]
