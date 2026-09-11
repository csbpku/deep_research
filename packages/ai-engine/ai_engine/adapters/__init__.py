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

from __future__ import annotations

from typing import TYPE_CHECKING

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

# Keep the vendor adapter genuinely lazy. Importing ``ai_engine.adapters`` is
# part of the FastAPI startup path, while radar-only workers do not need the
# gpt-researcher dependency tree until a research job is actually executed.
if TYPE_CHECKING:
    from ai_engine.adapters.gpt_researcher import GptResearcherAdapter


def __getattr__(name: str) -> object:
    if name == "GptResearcherAdapter":
        from ai_engine.adapters.gpt_researcher import GptResearcherAdapter

        return GptResearcherAdapter
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

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
