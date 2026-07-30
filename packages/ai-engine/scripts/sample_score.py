"""Score a single radar candidate."""
# ruff: noqa: E402
import asyncio
import json
import os
import sys

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from ai_engine.radar.distilled_scorer import score_with_llm
from ai_engine.scoring.scoring_profiles import get_profile


async def main():
    title = sys.argv[1] if len(sys.argv) > 1 else "Deep Agents v0.7"
    content = sys.argv[2] if len(sys.argv) > 2 else "Deep Agents v0.7 introduces hierarchical task planning."
    profile = get_profile(sys.argv[3] if len(sys.argv) > 3 else "engineering")

    result = await score_with_llm(title, content, profile=profile)
    print(f"total={result.total:.1f}  tier={result.tier}  must_read={result.must_read}")
    print(f"dimensions: {json.dumps(result.dimension_scores, ensure_ascii=False)}")
    print(f"weak_point: {result.weak_point}  default: {result.is_default}")


if __name__ == "__main__":
    asyncio.run(main())
