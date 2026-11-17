"""Refresh knowledge cards' search_docs snippets to include their judgement.

The 2026-11-17 trigger only applies on the next write, so already-published
cards keep an article-quote snippet. This backfill recomputes the snippet from
the current row without touching content fields.

Usage:
  python scripts/backfill_knowledge_search_docs.py            # dry run
  python scripts/backfill_knowledge_search_docs.py --apply    # write
"""

from __future__ import annotations

import argparse
import os
import sys

import psycopg
from dotenv import dotenv_values

SNIPPET_SQL = r"""
UPDATE search_docs sd
SET snippet = left(
      regexp_replace(
        coalesce(r.judgement, '') || E'\n'
          || coalesce(r."judgementScope", '') || E'\n'
          || coalesce(r.background, '') || E'\n'
          || coalesce(r.body, ''),
        E'<[^>]+>|[-*#>_\[\]]+|\x60+', ' ', 'g'
      ),
      1000
    ),
    "indexedAt" = now(),
    doc_tsv = setweight(to_tsvector('simple', coalesce(sd.title, '')), 'A')
      || setweight(
        to_tsvector(
          'simple',
          left(
            regexp_replace(
              coalesce(r.judgement, '') || E'\n'
                || coalesce(r."judgementScope", '') || E'\n'
                || coalesce(r.background, '') || E'\n'
                || coalesce(r.body, ''),
              E'<[^>]+>|[-*#>_\[\]]+|\x60+', ' ', 'g'
            ),
            1000
          )
        ),
        'B'
      )
FROM researches r
WHERE sd.type = 'knowledge'
  AND sd."refId" = r.id
  AND r.judgement IS NOT NULL
  AND NOT (sd.snippet LIKE '%' || r.judgement || '%')
"""


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    env = {**dotenv_values(".env"), **dotenv_values("apps/web/.env")}
    database_url = os.environ.get("DATABASE_URL") or env.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required")

    with psycopg.connect(database_url) as conn:
        rows = conn.execute(
            "SELECT count(*) FROM search_docs sd JOIN researches r ON r.id = sd.\"refId\" "
            "WHERE sd.type = 'knowledge' AND r.judgement IS NOT NULL "
            "AND NOT (sd.snippet LIKE '%' || r.judgement || '%')"
        ).fetchone()
        pending = int(rows[0])
        print(f"knowledge docs missing judgement: {pending}")
        if not args.apply or pending == 0:
            if not args.apply:
                print("dry run; pass --apply to write")
            return
        conn.execute(SNIPPET_SQL)
        conn.commit()
        print(f"updated {pending}")


if __name__ == "__main__":
    sys.exit(main())
