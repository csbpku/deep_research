"""Read a bounded set of source sections once for both brief and scoring."""

from __future__ import annotations

from dataclasses import dataclass, replace
import json

from ai_engine.llm.input_text import model_readable_text
from ai_engine.text_chunking import count_text_tokens, split_text_by_token_budget


@dataclass(frozen=True)
class SharedEvidence:
    text: str
    is_excerpt: bool
    source_chunks: int
    selected_chunks: int


async def prepare_shared_evidence(title: str, content: str, *, is_excerpt: bool = False) -> SharedEvidence:
    from ai_engine.llm.client import generate_text
    from ai_engine.llm.config import resolve_spec
    from ai_engine.radar.distilled_scorer import _extract_scoring_evidence

    readable = model_readable_text(content)
    chunks = split_text_by_token_budget(readable, 6000)
    if len(chunks) <= 1:
        return SharedEvidence(readable, is_excerpt, len(chunks), len(chunks))
    # Bound source reads before dispatch. Spread samples across a long source
    # rather than presenting its introduction as a full-document assessment.
    selected = chunks if len(chunks) <= 3 else [chunks[0], chunks[len(chunks) // 2], chunks[-1]]
    limited = is_excerpt or len(selected) < len(chunks)
    selected = [
        replace(c, index=i, section=f"原文分块{c.index}/{len(chunks)} {c.section}"[:160])
        for i, c in enumerate(selected, 1)
    ]
    packets = await _extract_scoring_evidence(
        generate_text,
        llm_spec=resolve_spec("utility"),
        title=title,
        chunks=selected,
        original_content=readable,
        content_is_source_excerpt=limited,
    )
    # Deterministic compression avoids a second map/reduce tree. Always retain
    # bounded source quotes and risks; no extra model call to merge packets.
    compact = []
    for packet in packets:
        compact.append(
            {
                "section": str(packet.get("section") or "")[:80],
                "coverage": str(packet.get("coverage") or "")[:80],
                "evidence": [
                    {
                        "aspect": str(e.get("aspect") or "")[:30],
                        "quote": str(e.get("quote") or "")[:64],
                        "observation": str(e.get("observation") or "")[:64],
                    }
                    for e in packet.get("evidence", [])[:1]
                ],
                "repost_signal": str(packet.get("repost_signal") or "")[:60],
                "risk_signals": [
                    {
                        "quote": str(e.get("quote") or "")[:64],
                        "observation": str(e.get("observation") or "")[:64],
                    }
                    for e in packet.get("risk_signals", [])[:2]
                ],
            }
        )
    text = json.dumps(compact, ensure_ascii=False, separators=(",", ":"))
    if count_text_tokens(text) > 4500:
        # Do not silently cut JSON or discard risk evidence. Defer instead.
        from ai_engine.llm.work_budget import WorkBudgetExceeded

        raise WorkBudgetExceeded("radar_evidence")
    return SharedEvidence(text, limited, len(chunks), len(selected))
