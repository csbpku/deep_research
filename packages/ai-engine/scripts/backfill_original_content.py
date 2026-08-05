"""Refresh stored radar article content with the structured extractor.

This is intentionally an explicit, bounded backfill rather than part of the
normal sync path: existing summaries are normally skipped as duplicates.
Usage examples::

    uv run python scripts/backfill_original_content.py --id <summary-id>
    uv run python scripts/backfill_original_content.py --kind arxiv --limit 20
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import base64
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psycopg

from ai_engine.fetcher.safe_fetch import safe_fetch
from ai_engine.radar.sync_runner import ORIGINAL_MARKDOWN_MAX_BYTES, _extract_article_content


def _source_type(original_kind: str | None, url: str) -> str:
    kind = (original_kind or "").lower()
    if kind == "arxiv" or "arxiv.org/abs/" in url.lower():
        return "arxiv"
    if kind.startswith("github") or "github.com/" in url.lower():
        return "github"
    return "rss"


def _github_api_url(url: str) -> str | None:
    match = re.match(r"https?://github\.com/([^/]+/[^/#?]+)(?:/.*)?$", url.rstrip("/"))
    if not match:
        return None
    repo = match.group(1).removesuffix(".git")
    return f"https://api.github.com/repos/{repo}/readme"


def _arxiv_html_url(url: str) -> str | None:
    match = re.search(r"arxiv\.org/(?:abs|pdf)/([^/?#]+)", url, re.IGNORECASE)
    if not match:
        return None
    paper_id = match.group(1).removesuffix(".pdf")
    return f"https://arxiv.org/html/{paper_id}"


async def _fetch_preferred_content(url: str, kind: str | None) -> tuple[str, str]:
    """Return (content, source_url), preferring structured source endpoints."""
    source = _source_type(kind, url)
    if source == "github":
        api_url = _github_api_url(url)
        if api_url:
            try:
                response = await safe_fetch(api_url)
                payload = json.loads(response.content.decode("utf-8", errors="replace"))
                encoded = payload.get("content")
                if isinstance(encoded, str):
                    decoded = base64.b64decode(encoded.replace("\n", "")).decode("utf-8", errors="replace")
                    if decoded.strip():
                        return decoded.strip(), api_url
            except Exception:
                pass
    if source == "arxiv":
        html_url = _arxiv_html_url(url)
        if html_url:
            try:
                response = await safe_fetch(html_url)
                return response.content.decode("utf-8", errors="replace"), html_url
            except Exception:
                pass
    response = await safe_fetch(url)
    return response.content.decode("utf-8", errors="replace"), url


def _clean_arxiv_markdown(markdown: str) -> str:
    """Remove artifacts left when arXiv math/navigation is converted to Markdown."""
    # HTML-to-Markdown extractors cannot preserve some MathJax formulas and
    # emit empty table rows / empty list markers in their place.
    markdown = re.sub(
        r"(?ms)^### Current browse context:.*?(?=^## \d+\s)####?\s*",
        "",
        markdown,
    )
    markdown = re.sub(r"(?m)^\s*\d+\.\s*$\n?", "", markdown)
    markdown = re.sub(
        r"(?m)^\|(?:\s*\|\s*)+(?:\(\d+\))?\s*$\n?", "", markdown
    )
    cleaned_lines: list[str] = []
    for line in markdown.splitlines():
        if line.strip().startswith("|") and line.strip().endswith("|"):
            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            if cells and all(not cell or re.fullmatch(r"\(?\d+\)?", cell) for cell in cells):
                continue
        cleaned_lines.append(line)
    markdown = "\n".join(cleaned_lines)
    markdown = re.sub(r"\s+\(\)(?=\s|[.,;:])", "", markdown)
    # Missing MathJax values leave doubled spaces in otherwise normal prose.
    markdown = re.sub(r"[ \t]{2,}", " ", markdown)
    replacements = {
        "An episode is a step sequence .": "An episode is a sequence of steps.",
        "at unknown step after which": "at an unknown onset after which",
        "Per channel ,": "For each channel,",
        "Because is frozen": "Because the reservoir state is frozen",
        "a causal score and\nan alarm time": "a causal score and an alarm time",
    }
    for source, target in replacements.items():
        markdown = markdown.replace(source, target)
    return markdown.strip()


async def run(ids: list[str], kind: str | None, limit: int) -> int:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        env_file = Path(__file__).resolve().parents[3] / "apps" / "web" / ".env"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if line.startswith("DATABASE_URL="):
                    database_url = line.split("=", 1)[1].strip()
                    break
    if not database_url:
        raise RuntimeError("DATABASE_URL is required")

    async with await psycopg.AsyncConnection.connect(database_url) as conn:
        clauses: list[str] = []
        params: list[Any] = []
        if ids:
            clauses.append('"id" = ANY(%s::uuid[])')
            params.append(ids)
        if kind:
            clauses.append('"originalKind" = %s')
            params.append(kind)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else "WHERE \"originalKind\" IS NOT NULL"
        rows = await (
            await conn.execute(
                f'SELECT "id", "url", "originalKind" FROM "summaries" {where} '
                'ORDER BY "updatedAt" ASC LIMIT %s',
                (*params, limit),
            )
        ).fetchall()

        updated = 0
        for row in rows:
            summary_id = str(row[0])
            url = str(row[1] or "")
            try:
                html, extraction_url = await _fetch_preferred_content(url, row[2])
                source = _source_type(row[2], url)
                if source == "github" and extraction_url.startswith("https://api.github.com/"):
                    markdown = html
                else:
                    markdown = _extract_article_content(html, extraction_url, source)
                if source == "arxiv":
                    markdown = _clean_arxiv_markdown(markdown)
                if not markdown.strip():
                    continue
                raw = markdown.encode("utf-8")[:ORIGINAL_MARKDOWN_MAX_BYTES]
                stored = raw.decode("utf-8", errors="replace")
                await conn.execute(
                    'UPDATE "summaries" SET "originalMarkdown" = %s, "originalBytes" = %s, '
                    '"originalSha256" = %s, "originalFetchedAt" = %s, "updatedAt" = now() '
                    'WHERE "id" = %s',
                    (stored, len(raw), hashlib.sha256(raw).hexdigest(), datetime.now(timezone.utc), summary_id),
                )
                updated += 1
                print(f"updated {summary_id} ({len(raw)} bytes)")
            except Exception as exc:  # one source must not block the rest of the batch
                print(f"skipped {summary_id}: {exc}")
        await conn.commit()
        return updated


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--id", dest="ids", action="append", default=[])
    parser.add_argument("--kind", choices=("arxiv", "github_repo", "github_release"))
    parser.add_argument("--limit", type=int, default=20)
    args = parser.parse_args()
    raise SystemExit(0 if asyncio.run(run(args.ids, args.kind, max(1, args.limit))) >= 0 else 1)


if __name__ == "__main__":
    main()
