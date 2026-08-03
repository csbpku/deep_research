"""Seed the `github_tracked` radar source from configs/radar_tracked_repos.yml.

Reads the YAML, flattens all category entries to a list of `owner/repo`
strings, and creates (or updates) one row in `radar_sources` with
`sourceType='github_tracked'`. Re-runnable: subsequent runs refresh the
config JSON in place.

Usage:
  cd packages/ai-engine
  uv run python scripts/seed_tracked_repos.py
  uv run python scripts/seed_tracked_repos.py --yaml configs/radar_tracked_repos.yml

Why one row for all repos (not N rows): keeps the per-source run history
(`lastSyncAt`, run counts) sane. The fetcher fans out across all `repos`
internally with asyncio.gather.
"""
# ruff: noqa: E402
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

import yaml
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))


def _load_entries(yaml_path: Path) -> tuple[list[str], list[str]]:
    """Flatten YAML entries into (repos, paginated_repos)."""
    with open(yaml_path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    repos: list[str] = []
    paginated_repos: list[str] = []
    if not isinstance(data, dict):
        raise ValueError(f"Expected dict at top-level, got {type(data).__name__}")
    for category, entries in data.items():
        if category.startswith("#") or category in ("lookback_days", "max_items_per_repo"):
            continue
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if isinstance(entry, dict) and "repo" in entry:
                repos.append(str(entry["repo"]))
                if entry.get("paginated"):
                    paginated_repos.append(str(entry["repo"]))
    # Dedup while preserving order
    seen: set[str] = set()
    unique: list[str] = []
    for r in repos:
        if r not in seen:
            seen.add(r)
            unique.append(r)
    paginated_seen: set[str] = set()
    unique_paginated: list[str] = []
    for r in paginated_repos:
        if r not in paginated_seen:
            paginated_seen.add(r)
            unique_paginated.append(r)
    return unique, unique_paginated


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--yaml",
        default=str(Path(__file__).parent.parent / "configs" / "radar_tracked_repos.yml"),
        help="Path to radar_tracked_repos.yml",
    )
    parser.add_argument(
        "--name",
        default="GitHub Tracked Repos (curated)",
        help="Display name for the radar_sources row",
    )
    args = parser.parse_args()

    yaml_path = Path(args.yaml)
    if not yaml_path.exists():
        print(f"[ERROR] YAML not found: {yaml_path}", file=sys.stderr)
        return 1

    repos, paginated_repos = _load_entries(yaml_path)
    if not repos:
        print("[ERROR] No repos found in YAML.", file=sys.stderr)
        return 1

    config = {
        "repos": repos,
        # 24h window + total per-repo cap keeps one sync batch bounded; both
        # values are overridable in the radar_sources config JSON.
        "lookback_days": 1,
        "max_items_per_repo": 20,
        "include_issues": True,
        "include_prs": True,
        "include_releases": True,
        "paginated_repos": paginated_repos,
    }

    dsn = os.environ.get("DATABASE_URL", "postgresql://localhost:5432/deep_research")
    pool = AsyncConnectionPool(dsn, min_size=1, max_size=2, open=False)
    await pool.open()

    try:
        async with pool.connection() as conn:
            conn.row_factory = dict_row

            existing = await (
                await conn.execute(
                    'SELECT id, config FROM "radar_sources" WHERE "sourceType" = %s LIMIT 1',
                    ("github_tracked",),
                )
            ).fetchone()

            if existing:
                # Update config in place; preserve id and any operator overrides.
                await conn.execute(
                    'UPDATE "radar_sources" SET "config" = %s::jsonb, "name" = %s, '
                    '"updatedAt" = now() WHERE "id" = %s',
                    (json.dumps(config), args.name, existing["id"]),
                )
                print(f"[OK] Updated github_tracked source {existing['id']} with {len(repos)} repos.")
            else:
                await conn.execute(
                    'INSERT INTO "radar_sources" '
                    '("id", "name", "sourceType", "config", "enabled", '
                    '"createdAt", "updatedAt") '
                    "VALUES (gen_random_uuid(), %s, 'github_tracked', %s::jsonb, true, now(), now())",
                    (args.name, json.dumps(config)),
                )
                print(f"[OK] Created github_tracked source with {len(repos)} repos.")
            await conn.commit()
    finally:
        await pool.close()

    return 0


if __name__ == "__main__":
    exit(asyncio.run(main()))
