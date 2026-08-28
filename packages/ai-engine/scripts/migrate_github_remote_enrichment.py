"""Re-enrich collection/deep_read GitHub repos from public Zread only.

The source order for this bounded migration is deliberately:

    public Zread pages -> GitHub README fallback

It never invokes ``zread generate``.  The existing migration runner still
does the normal GitHub metadata enrichment and scoring; this wrapper only
locks the Zread provider policy for the run.

Usage::

    cd packages/ai-engine
    uv run python scripts/migrate_github_remote_enrichment.py \
        --limit 200 --batch-size 4 --concurrency 2
"""

from __future__ import annotations

import asyncio
import os
import sys


def main() -> int:
    # The worker checks this flag before attempting the optional local CLI.
    # Keep it in the wrapper rather than relying on a caller's .env, because
    # this migration must remain remote-only even when the CLI is configured.
    os.environ["ZREAD_REMOTE_ENABLED"] = "1"
    os.environ["ZREAD_CLI_ENABLED"] = "0"

    forwarded = sys.argv[1:]
    if "--kind" in forwarded or "--repo" in forwarded:
        raise SystemExit("This migration always targets all GitHub repos in collection/deep_read")

    sys.argv = [
        sys.argv[0],
        "--kind",
        "github_repo",
        "--force-all-quality",
        *forwarded,
    ]

    # Import after setting the environment so dotenv loading and provider
    # selection cannot accidentally re-enable the CLI path.
    from migrate_existing_radar import main as migrate_main

    return asyncio.run(migrate_main())


if __name__ == "__main__":
    raise SystemExit(main())
