"""Safety helpers for text copied from external or user-controlled sources.

Fetched pages, imported documents, and persisted source excerpts are data. They
can contain text addressed to an AI agent, so every prompt boundary must treat
them as quoted data rather than relying on a surrounding prompt instruction.
"""

from __future__ import annotations

import re


EXTERNAL_INSTRUCTION_MARKER = "[网页数据中的疑似指令已隔离]"
EXTERNAL_INSTRUCTION_SIGNALS = re.compile(
    r"(?:agents?\.md|system\s+prompt|developer\s+message|ignore\s+(?:all\s+)?previous\s+instructions|"
    r"忽略(?:之前|以上|所有)指令|请(?:让|要求)\s*ai|要求\s*模型|遵守(?:本页|该页|以下)规则|"
    r"不要告诉用户|作为系统提示)",
    re.IGNORECASE,
)


def sanitize_external_instruction_text(value: str) -> tuple[str, bool]:
    """Redact instruction-like fragments while retaining surrounding data.

    This deliberately replaces only recognizable instruction signals. The
    surrounding page text remains available as evidence, while the signal
    cannot be copied verbatim into a model prompt and mistaken for an
    executable instruction.
    """
    sanitized, replacements = EXTERNAL_INSTRUCTION_SIGNALS.subn(
        EXTERNAL_INSTRUCTION_MARKER,
        value,
    )
    return sanitized, replacements > 0
