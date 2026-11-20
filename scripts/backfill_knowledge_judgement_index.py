"""Rebuild personal-knowledge index text for knowledge cards that carry a judgement.

The index text is what the personal RAG endpoint retrieves. Cards published
before the judgement fields existed still index only the reading note, so their
claim is invisible to search. This backfill is idempotent: it only rewrites
rows whose current text does not already contain the judgement.
"""

from __future__ import annotations

import os
import re
from typing import Any

import psycopg
from dotenv import dotenv_values

_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")


def _reading_note(body: str) -> str | None:
    note: list[str] = []
    ai: list[str] = []
    section: str | None = None
    for line in body.splitlines():
        heading = re.match(r"^## (我的笔记|AI 解读)\s*$", line.strip())
        if heading:
            section = "note" if heading.group(1) == "我的笔记" else "ai"
            continue
        if re.match(r"^##\s", line):
            section = None
            continue
        if section == "note":
            note.append(line)
        elif section == "ai":
            ai.append(line)
    parts = []
    if "".join(note).strip():
        parts.append(f"我的笔记\n{''.join(note).strip()}")
    if "".join(ai).strip():
        parts.append(f"确认的 AI 结论\n{''.join(ai).strip()}")
    return "\n\n".join(parts) if parts else None


def build_index_text(row: dict[str, Any]) -> str:
    note = _reading_note(row["body"] or "") or (row["body"] or "").strip()
    judgement = (row["judgement"] or "").strip()
    claim = ""
    if judgement:
        scope = (row["judgementScope"] or "").strip()
        claim = "\n".join(part for part in (
            f"判断（置信度 {row['judgementConfidence'] or 'unknown'}）",
            judgement,
            f"适用边界：{scope}" if scope else "",
        ) if part)
    return "\n\n".join(part for part in (
        (row["title"] or "").strip(),
        claim,
        (row["conclusion"] or "").strip(),
        note,
    ) if part)


def main() -> None:
    env = {**dotenv_values(".env"), **dotenv_values("apps/web/.env")}
    database_url = os.environ.get("DATABASE_URL") or env.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required")

    with psycopg.connect(database_url) as conn:
        rows = conn.execute(
            'SELECT "id", "title", "body", "conclusion", "judgement", '
            '"judgementConfidence", "judgementScope", "knowledgeIndexText" '
            'FROM "researches" '
            'WHERE "type" = \'knowledge\' AND "judgement" IS NOT NULL'
        ).fetchall()

        updated = 0
        for row_id, title, body, conclusion, judgement, confidence, scope, current in rows:
            text = build_index_text({
                "title": title, "body": body, "conclusion": conclusion,
                "judgement": judgement, "judgementConfidence": confidence, "judgementScope": scope,
            })
            if current and judgement in current:
                continue
            conn.execute(
                'UPDATE "researches" SET "knowledgeIndexText" = %s, "updatedAt" = now() WHERE "id" = %s',
                (text, row_id),
            )
            updated += 1
        print(f"knowledge cards scanned={len(rows)} updated={updated}")


if __name__ == "__main__":
    main()
