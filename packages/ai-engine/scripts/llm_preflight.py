"""Verify the configured light LLM before starting a sync or deployment."""

# ruff: noqa: E402

from __future__ import annotations

import asyncio
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

from ai_engine.llm.client import generate_text


async def main() -> int:
    started = time.monotonic()
    result = await generate_text(
        system_prompt="Return strict JSON only.",
        user_prompt='Return exactly {"ok":true}.',
        max_tokens=128,
        timeout=30.0,
        disable_thinking=True,
    )
    elapsed_ms = int((time.monotonic() - started) * 1000)
    try:
        parsed = json.loads(result.text)
    except json.JSONDecodeError:
        parsed = None
    print(json.dumps({
        "ok": parsed == {"ok": True},
        "provider": result.provider,
        "requested_model": result.requested_model,
        "actual_model": result.actual_model,
        "input_tokens": result.input_tokens,
        "output_tokens": result.output_tokens,
        "elapsed_ms": elapsed_ms,
        "text": result.text[:200],
    }, ensure_ascii=False, indent=2))
    return 0 if parsed == {"ok": True} else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
