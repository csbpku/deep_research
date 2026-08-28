"""Repair literal JSON unicode escapes persisted in Zread page metadata.

Some remote Zread catalog values were extracted from escaped Next.js flight
data with the backslash sequence left as literal text, e.g. ``\\u0026``.
This repairs only the stored Zread object; it does not rewrite source article
content or infer any directory names.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any

from dotenv import load_dotenv

PACKAGE_ROOT = os.path.dirname(os.path.dirname(__file__))
load_dotenv(os.path.join(PACKAGE_ROOT, ".env"))

from ai_engine.job_runner.db_store import DbJobStore  # noqa: E402

_UNICODE_ESCAPE = re.compile(r"\\+u([0-9a-fA-F]{4})")


def _decode(value: str) -> str:
    # Zread metadata can be wrapped in more than one JSON/flight string
    # layer. Decode repeatedly so ``\\u0026`` becomes ``&`` rather than
    # remaining as the visible text ``\u0026``.
    decoded = value
    for _ in range(3):
        repaired = _UNICODE_ESCAPE.sub(lambda match: chr(int(match.group(1), 16)), decoded)
        if repaired == decoded:
            break
        decoded = repaired
    # PostgreSQL JSONB cannot store U+0000.  Some generated page bodies
    # contain it as either a literal NUL or an escaped ``\u0000`` sequence.
    return decoded.replace("\x00", "")


def _repair(value: Any) -> tuple[Any, int]:
    if isinstance(value, str):
        repaired = _decode(value)
        return repaired, int(repaired != value)
    if isinstance(value, list):
        repaired_items: list[Any] = []
        changes = 0
        for item in value:
            repaired_item, item_changes = _repair(item)
            repaired_items.append(repaired_item)
            changes += item_changes
        return repaired_items, changes
    if isinstance(value, dict):
        repaired_dict: dict[str, Any] = {}
        changes = 0
        for key, item in value.items():
            repaired_key = _decode(str(key))
            repaired_item, item_changes = _repair(item)
            repaired_dict[repaired_key] = repaired_item
            changes += int(repaired_key != key) + item_changes
        return repaired_dict, changes
    return value, 0


async def main() -> int:
    store = DbJobStore(dsn=os.environ["DATABASE_URL"])
    await store.open()
    rows_changed = 0
    pages_changed = 0
    fields_changed = 0
    try:
        async with store.pool.connection() as conn:
            rows = await (
                await conn.execute(
                    'SELECT "id", "originalMeta" FROM "summaries" '
                    'WHERE "originalMeta"->\'zread\'->\'pages\' IS NOT NULL',
                )
            ).fetchall()
            for row in rows:
                raw_meta = row["originalMeta"]
                if isinstance(raw_meta, str):
                    raw_meta = json.loads(raw_meta)
                if not isinstance(raw_meta, dict):
                    continue
                zread = raw_meta.get("zread")
                if not isinstance(zread, dict):
                    continue
                pages = zread.get("pages")
                if not isinstance(pages, list):
                    continue
                repaired_zread, changes = _repair(zread)
                if not changes or not isinstance(repaired_zread, dict):
                    continue
                repaired_pages = repaired_zread.get("pages")
                pages_changed += sum(
                    1
                    for before, after in zip(pages, repaired_pages or [])
                    if before != after
                )
                fields_changed += changes
                raw_meta["zread"] = repaired_zread
                await conn.execute(
                    'UPDATE "summaries" SET "originalMeta" = %s::jsonb, '
                    '"updatedAt" = now() WHERE "id" = %s',
                    (json.dumps(raw_meta, ensure_ascii=False), str(row["id"])),
                )
                rows_changed += 1
            await conn.commit()
    finally:
        await store.close()
    print(
        f"rows_changed={rows_changed} pages_changed={pages_changed} "
        f"fields_changed={fields_changed}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
