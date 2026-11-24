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
    """Keep one table row per option inside the comparison matrix section.

    Only the first contiguous table under the heading is the matrix; prose and
    any later table (e.g. the 未知与冲突 note table) are preserved verbatim.
    """
    lines = text.splitlines()
    try:
        start = next(index for index, line in enumerate(lines) if line.strip() == _HEADING)
    except StopIteration:
        return text

    # Locate the first table block: header, separator, rows.
    index = start + 1
    while index < len(lines) and not _TABLE_ROW.match(lines[index].strip()):
        if lines[index].startswith("## "):
            return text
        index += 1
    if index >= len(lines):
        return text
    table_start = index
    if table_start + 1 >= len(lines) or not _is_separator(_cells(lines[table_start + 1])):
        return text

    header = lines[table_start]
    separator = lines[table_start + 1]
    row_start = table_start + 2
    row_end = row_start
    while row_end < len(lines) and _TABLE_ROW.match(lines[row_end].strip()):
        row_end += 1
    rows = lines[row_start:row_end]

    seen: set[str] = set()
    kept: list[str] = []
    for line in rows:
        cells = _cells(line)
        key = re.sub(r"[`*\s]", "", cells[0]).casefold() if cells else ""
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        kept.append(line)

    if len(kept) == len(rows):
        return text

    rebuilt = [
        *lines[:table_start],
        header,
        separator,
        *kept,
        *lines[row_end:],
    ]
    return "\n".join(rebuilt).rstrip() + "\n"
