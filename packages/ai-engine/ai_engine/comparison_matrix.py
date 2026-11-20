"""Deterministic cleanup for the comparison-matrix artifact.

The writer occasionally emits one table row per (option, dimension) pair instead
of one row per option. That renders as duplicate options and makes the matrix
unreadable, so keep the first row for each option and leave the rest untouched.
"""

from __future__ import annotations

import re

_HEADING = "## 对比矩阵"
_TABLE_ROW = re.compile(r"^\|(.+)\|\s*$")


def _cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _is_separator(cells: list[str]) -> bool:
    return all(set(cell) <= {"-", ":", " "} and cell for cell in cells)


def dedupe_option_rows(text: str) -> str:
    """Keep one table row per option inside the comparison matrix section."""
    lines = text.splitlines()
    try:
        start = next(index for index, line in enumerate(lines) if line.strip() == _HEADING)
    except StopIteration:
        return text

    seen: set[str] = set()
    kept: list[str] = []
    removed = 0
    in_table = False
    for line in lines[start + 1 :]:
        if line.startswith("## "):
            kept.extend(lines[start + 1 + len(kept) : start + 1 + len(kept) + 1][:0])
            break
        match = _TABLE_ROW.match(line)
        if not match:
            if in_table and kept and line.strip():
                in_table = False
            continue
        cells = _cells(line)
        if _is_separator(cells):
            continue
        key = re.sub(r"[`*\s]", "", cells[0]).casefold() if cells else ""
        if key in seen:
            removed += 1
            continue
        seen.add(key)
        kept.append(line)
        in_table = True
    if not removed:
        return text

    # Rebuild the section: heading, blank line, table, then the original tail.
    tail_start = start + 1
    while tail_start < len(lines) and (lines[tail_start].strip() == "" or lines[tail_start].startswith("|")):
        tail_start += 1
    prefix = lines[: start + 1]
    suffix = lines[tail_start:]
    rebuilt = prefix + [""] + kept + [""] + suffix
    return "\n".join(rebuilt).rstrip() + "\n"
