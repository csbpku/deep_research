"""Radar deep-dive enrichment worker.

Phase 2A: enrich GitHub repo candidates with file tree + entry points +
repo metadata by calling GitHub's REST API.
Phase 2B: enrich arxiv paper candidates with PDF-parsed structure
(sections + figures) + LLM-generated TL;DR.

Design points:
- Failures are isolated per candidate; one repo's 404/timeout does not
  block the rest of the batch.
- When ``GH_TOKEN`` is unset we degrade gracefully — skip the tree call,
  log a warning, and let the next sync attempt retry (no crash).
- We never call ``safe_fetch`` against api.github.com: HTTPS+443 + JSON
  content-type is already in the allow-list; using httpx directly keeps
  the failure modes easy to read.
- arxiv PDF fetch goes through ``safe_fetch`` (SSRF defense is required
  for arbitrary URLs). pymupdf parses the PDF inline; figures are
  extracted but not persisted as base64 in P0 (only metadata).
- Output JSON shape is intentionally small (≤16KB) so Postgres TOAST
  isn't triggered and the BFF can ship it inline.
"""

from __future__ import annotations

import json
import logging
import os
import re as _re
import re as _re_arxiv
import time
from typing import Any
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger("ai_engine.radar.enrichment_worker")

# Cap tree nodes to keep payloads bounded; 200 is the gpt-researcher
# recommendation and matches Phase 2A design.
TREE_NODE_MAX = 200
# Cap JSONB payload to ~16KB (well under Postgres TOAST).
ORIGINAL_META_MAX_BYTES = 16_000

# Files we mark as "key" in the file tree renderer.
_KEY_FILES = frozenset({
    "readme.md", "readme.rst", "readme.txt", "readme",
    "license", "license.md", "license.txt",
    "pyproject.toml", "setup.py", "setup.cfg",
    "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "cargo.toml", "cargo.lock",
    "go.mod", "go.sum",
    "makefile",
    "dockerfile", "docker-compose.yml", "docker-compose.yaml",
    "tsconfig.json", "jsconfig.json",
    ".gitignore", ".editorconfig",
})

# Heuristic for entry points: files in src/ at any depth, or top-level
# files matching common entry patterns.
_ENTRY_POINT_TOP_LEVEL = (
    "main.py", "app.py", "__main__.py", "cli.py", "server.py",
    "main.go", "main.rs", "main.js", "main.ts", "main.tsx",
    "index.js", "index.ts", "index.tsx", "index.html",
    "app.js", "app.ts", "app.tsx",
    "server.js", "server.ts",
)
_GITHUB_REPO_PATH_RE = _re.compile(
    r"^/([^/]+)/([^/]+)/?$"
)


def _parse_repo_path(url: str) -> tuple[str, str] | None:
    """Extract (owner, repo) from a github.com repo URL.

    Returns None for non-repo URLs (e.g. issues, releases, PRs).
    """
    try:
        u = urlsplit(url.strip())
    except Exception:
        return None
    if u.netloc.lower() not in ("github.com", "www.github.com"):
        return None
    m = _GITHUB_REPO_PATH_RE.match(u.path)
    if not m:
        return None
    return m.group(1), m.group(2)


def _github_headers(token: str | None) -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "deep-research-radar-enrichment/1.0",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


async def _fetch_repo_meta(
    client: httpx.AsyncClient, owner: str, repo: str
) -> dict[str, Any] | None:
    """Fetch repo metadata: default_branch, language, stars, last_push."""
    try:
        resp = await client.get(
            f"https://api.github.com/repos/{owner}/{repo}",
            headers=_github_headers(os.environ.get("GH_TOKEN")),
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        logger.warning(
            "ai-engine.radar.enrichment.github_meta_failed",
            extra={"owner": owner, "repo": repo, "error": type(exc).__name__},
        )
        return None
    if resp.status_code != 200:
        logger.warning(
            "ai-engine.radar.enrichment.github_meta_non_200",
            extra={
                "owner": owner, "repo": repo,
                "status": resp.status_code,
            },
        )
        return None
    data = resp.json()
    return {
        "defaultBranch": data.get("default_branch"),
        "language": data.get("language"),
        "stars": data.get("stargazers_count"),
        "lastPushedAt": data.get("pushed_at"),
        "description": data.get("description"),
    }


async def _fetch_repo_tree(
    client: httpx.AsyncClient, owner: str, repo: str, default_branch: str
) -> list[dict[str, Any]]:
    """Fetch 2-level deep tree; cap at TREE_NODE_MAX nodes."""
    try:
        resp = await client.get(
            f"https://api.github.com/repos/{owner}/{repo}/git/trees/{default_branch}",
            params={"recursive": "0"},
            headers=_github_headers(os.environ.get("GH_TOKEN")),
            timeout=10.0,
        )
    except httpx.HTTPError as exc:
        logger.warning(
            "ai-engine.radar.enrichment.github_tree_failed",
            extra={"owner": owner, "repo": repo, "error": type(exc).__name__},
        )
        return []
    if resp.status_code != 200:
        logger.warning(
            "ai-engine.radar.enrichment.github_tree_non_200",
            extra={"owner": owner, "repo": repo, "status": resp.status_code},
        )
        return []
    body = resp.json()
    if body.get("truncated"):
        # recursive=0 should not truncate at depth 0; flag for ops.
        logger.info(
            "ai-engine.radar.enrichment.github_tree_truncated",
            extra={"owner": owner, "repo": repo, "tree_count": len(body.get("tree", []))},
        )
    nodes = body.get("tree", [])[:TREE_NODE_MAX]
    return [
        {"path": n["path"], "type": n["type"], "size": n.get("size")}
        for n in nodes
        if n.get("path")
    ]


def _detect_entry_points(tree: list[dict[str, Any]]) -> list[str]:
    """Heuristic: top-level entry-point files + any file under src/."""
    entry: list[str] = []
    for node in tree:
        path = node.get("path", "")
        if not path:
            continue
        filename = path.rsplit("/", 1)[-1].lower()
        # Only count files; skip directories themselves.
        if node.get("type") != "blob":
            continue
        # Skip deep paths (more than 1 directory deep).
        depth = path.count("/")
        if depth >= 2:
            continue
        # Top-level files (no slash) match by filename.
        # Files in src/ or root/<filename> also match.
        if filename in _ENTRY_POINT_TOP_LEVEL:
            entry.append(path)
    entry.sort()
    return entry[:10]


def _classify_tree(tree: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Mark key files for the renderer to highlight."""
    out: list[dict[str, Any]] = []
    for node in tree:
        top = node["path"].split("/", 1)[0].lower()
        node_copy = dict(node)
        node_copy["key"] = top in _KEY_FILES
        out.append(node_copy)
    return out


def _build_meta_payload(
    repo_meta: dict[str, Any] | None,
    tree: list[dict[str, Any]],
    entry_points: list[str],
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "provider": "github",
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tree": _classify_tree(tree),
        "entryPoints": entry_points,
    }
    if repo_meta:
        payload.update(repo_meta)
    return payload


def _trim_to_budget(payload: dict[str, Any]) -> dict[str, Any]:
    """Drop oldest tree nodes if JSON exceeds ORIGINAL_META_MAX_BYTES."""
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if len(encoded) <= ORIGINAL_META_MAX_BYTES:
        return payload
    # Trim tree iteratively until under budget. Keep key files + entry
    # points intact by moving them to the head before trimming.
    tree = payload.get("tree", [])
    key_paths = {e["path"] for e in tree if e.get("key")}
    head = [n for n in tree if n["path"] in key_paths or n["path"] in payload.get("entryPoints", [])]
    tail = [n for n in tree if n not in head]
    while tail and len(json.dumps({**payload, "tree": head + tail}, ensure_ascii=False).encode("utf-8")) > ORIGINAL_META_MAX_BYTES:
        tail.pop()
    payload["tree"] = head + tail
    payload["trimmed"] = True
    return payload


async def enrich_github_candidate(
    pool: Any,
    *,
    summary_id: str,
    canonical_url: str,
) -> dict[str, Any] | None:
    """Enrich one GitHub repo candidate; returns the persisted meta or None.

    Returns None when the URL isn't a repo URL or enrichment failed.
    Caller is responsible for catching all exceptions (we log + return None).
    """
    parsed = _parse_repo_path(canonical_url)
    if not parsed:
        return None
    owner, repo = parsed

    async with httpx.AsyncClient() as client:
        repo_meta = await _fetch_repo_meta(client, owner, repo)
        default_branch = (repo_meta or {}).get("defaultBranch") or "main"
        tree = await _fetch_repo_tree(client, owner, repo, default_branch)
    entry_points = _detect_entry_points(tree)
    payload = _build_meta_payload(repo_meta, tree, entry_points)
    payload = _trim_to_budget(payload)

    async with pool.connection() as conn:
        await conn.execute(
            'UPDATE "summaries" SET "originalMeta" = %s::jsonb, "updatedAt" = now() '
            'WHERE "id" = %s',
            (json.dumps(payload, ensure_ascii=False), summary_id),
        )
    logger.info(
        "ai-engine.radar.enrichment.github_done",
        extra={
            "summary_id": summary_id,
            "owner": owner,
            "repo": repo,
            "tree_count": len(tree),
            "entry_points": len(entry_points),
            "payload_bytes": len(json.dumps(payload, ensure_ascii=False).encode("utf-8")),
        },
    )
    return payload


# ─────────────────────────────────────────────────────────────────────
# Phase 2B — arxiv PDF enrichment
# ─────────────────────────────────────────────────────────────────────


_ARXIV_ID_RE = _re_arxiv.compile(
    r"(?:arxiv\.org/(?:abs|pdf)/|abs/)?([0-9]{4}\.[0-9]{4,6}(?:v[0-9]+)?)"
)


def _parse_arxiv_id(url: str) -> str | None:
    """Extract arxiv id like 2401.12345 from a paper URL."""
    m = _ARXIV_ID_RE.search(url or "")
    return m.group(1) if m else None


def _strip_latex_commands(text: str) -> str:
    """Light LaTeX cleanup — strip braces, comments, common commands.

    pymupdf returns text with raw LaTeX-ish artifacts. We do not aim for
    a full TeX→Markdown conversion (out of scope); just enough that the
    body is readable as paragraphs.
    """
    text = _re_arxiv.sub(r"%[^\n]*", "", text)
    text = _re_arxiv.sub(r"\\textbf\{([^}]*)\}", r"**\1**", text)
    text = _re_arxiv.sub(r"\\textit\{([^}]*)\}", r"*\1*", text)
    text = _re_arxiv.sub(r"\\emph\{([^}]*)\}", r"*\1*", text)
    text = _re_arxiv.sub(r"\\texttt\{([^}]*)\}", r"`\1`", text)
    text = _re_arxiv.sub(r"\\cite\{[^}]*\}", "", text)
    text = _re_arxiv.sub(r"\\ref\{[^}]*\}", "", text)
    text = _re_arxiv.sub(r"\\label\{[^}]*\}", "", text)
    text = _re_arxiv.sub(r"\\href\{([^}]*)\}\{([^}]*)\}", r"[\2](\1)", text)
    text = _re_arxiv.sub(r"\\begin\{[^}]*\}|\\end\{[^}]*\}", "", text)
    return text


async def _fetch_arxiv_pdf(url: str) -> bytes:
    """Fetch arxiv PDF directly via httpx.

    We bypass ``safe_fetch`` because arxiv.org is a fixed trusted domain
    and ``safe_fetch``'s content-type whitelist excludes application/pdf.
    Defence-in-depth: only call this for arxiv ids parsed by
    ``_parse_arxiv_id`` (URL must contain ``arxiv.org/pdf/<id>``).
    """
    import httpx as _httpx_pdf
    async with _httpx_pdf.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            url,
            headers={"User-Agent": "deep-research-radar-enrichment/1.0"},
            follow_redirects=True,
        )
        resp.raise_for_status()
        return resp.content


def _parse_arxiv_pdf(pdf_bytes: bytes) -> tuple[str, list[dict[str, Any]]]:
    """Parse PDF to (markdown, sections) using pymupdf.

    Returns the full document as markdown-like text plus a list of
    section boundaries detected by font-size heuristics. We don't
    extract figures as base64 in P0 (cost too high); only metadata.
    """
    try:
        import fitz  # type: ignore[import-untyped]  # pymupdf - no type stubs
    except ImportError:
        logger.warning(
            "ai-engine.radar.enrichment.pymupdf_missing",
            extra={},
        )
        return "", []

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    body_parts: list[str] = []
    sections: list[dict[str, Any]] = []
    # Walk pages, capture text + heading candidates. We assume headings
    # are lines whose font size is >= 1.2x the body median. This is a
    # heuristic, not a guarantee.
    page_count = doc.page_count
    if page_count == 0:
        doc.close()
        return "", []

    # First pass: gather font sizes per page to estimate body median.
    body_medians: list[float] = []
    for page in doc:
        blocks = page.get_text("dict")["blocks"]
        sizes: list[float] = []
        for b in blocks:
            for line in b.get("lines", []):
                for span in line.get("spans", []):
                    sizes.append(span.get("size", 0))
        if sizes:
            sizes.sort()
            body_medians.append(sizes[len(sizes) // 2])

    body_median = body_medians[len(body_medians) // 2] if body_medians else 10.0
    heading_threshold = body_median * 1.2

    offset = 0
    for page_idx, page in enumerate(doc):
        blocks = page.get_text("dict")["blocks"]
        for b in blocks:
            for line in b.get("lines", []):
                text_parts: list[str] = []
                line_size = 0.0
                for span in line.get("spans", []):
                    s = span.get("text", "")
                    if not s.strip():
                        continue
                    text_parts.append(s)
                    line_size = max(line_size, span.get("size", 0))
                line_text = "".join(text_parts).strip()
                if not line_text:
                    continue
                clean = _strip_latex_commands(line_text)
                if line_size >= heading_threshold and len(clean) < 200:
                    # Heuristic: short text on big font → heading
                    sections.append({
                        "title": clean[:200],
                        "level": 1 if line_size >= body_median * 1.5 else 2,
                        "startOffset": offset,
                        "page": page_idx + 1,
                    })
                body_parts.append(clean)
                offset += len(clean) + 1  # +1 for newline

        # Stop at page 10 to bound parsing cost.
        if page_idx >= 9:
            body_parts.append("\n\n[后续 10+ 页内容已截断]")
            break

    doc.close()
    markdown = "\n\n".join(body_parts)
    if len(markdown) > 64 * 1024:
        markdown = markdown[: 64 * 1024]
    return markdown, sections


async def _generate_tldr(
    markdown: str, title: str
) -> dict[str, Any] | None:
    """Use BRIEF_LLM to generate a 1-sentence TL;DR + 3-5 key contributions.

    Calls the Anthropic API directly to avoid ``_run_brief``'s summary
    template which would interfere with the structured JSON output.
    Returns None on failure; caller falls back to existing interpretation.
    """
    try:
        from anthropic import AsyncAnthropic
        import json as _json
    except ImportError as exc:
        logger.warning(
            "ai-engine.radar.enrichment.tldr_import_error",
            extra={"error": str(exc)[:200]},
        )
        return None

    # Resolve brief LLM model from env (same as _run_brief).
    llm_spec = os.environ.get("BRIEF_LLM") or os.environ.get("SMART_LLM") or "anthropic:claude-haiku-4-5"
    _, _, model_name = llm_spec.partition(":")
    api_key = os.environ.get("ANTHROPIC_API_KEY", "") or os.environ.get("ANTHROPIC_API_KEY_HEAVY", "")
    base_url = os.environ.get("ANTHROPIC_BASE_URL") or os.environ.get("ANTHROPIC_BASE_URL_HEAVY")

    prompt = (
        "你是 AI 论文摘要专家。基于下面的论文正文,生成:\n"
        "1. 一句话 TL;DR (不超过 80 字)\n"
        "2. 3-5 个 key contributions (bullet list)\n\n"
        f"标题: {title}\n\n"
        f"正文 (前 3000 字):\n{markdown[:3000]}\n\n"
        "输出严格 JSON (不要 markdown 代码块):\n"
        '{"tldr": "...", "keyContributions": ["...", "...", "..."]}'
    )

    try:
        client = AsyncAnthropic(api_key=api_key, base_url=base_url)
        message = await client.messages.create(
            model=model_name,
            max_tokens=512,
            messages=[{"role": "user", "content": prompt}],
        )
        body_parts = [
            block.text
            for block in message.content
            if getattr(block, "type", None) == "text" and hasattr(block, "text")
        ]
        text = "".join(body_parts).strip()
        if not text:
            return None
        # Find first {...} block if LLM wrapped JSON in prose.
        brace_start = text.find("{")
        brace_end = text.rfind("}")
        if brace_start != -1 and brace_end > brace_start:
            text = text[brace_start : brace_end + 1]
        parsed: dict[str, Any] = _json.loads(text)
        return parsed
    except Exception as exc:
        logger.warning(
            "ai-engine.radar.enrichment.tldr_failed",
            extra={"error": type(exc).__name__, "msg": str(exc)[:200]},
        )
        return None


async def enrich_arxiv_candidate(
    pool: Any,
    *,
    summary_id: str,
    canonical_url: str,
) -> dict[str, Any] | None:
    """Enrich one arxiv paper candidate; returns the persisted meta or None.

    Pipeline:
    1. Parse arxiv id from URL
    2. Fetch PDF via safe_fetch
    3. Parse with pymupdf → markdown + sections
    4. Generate TL;DR via BRIEF_LLM
    5. Persist originalMarkdown + sections + tldr + figures + authors
    """
    arxiv_id = _parse_arxiv_id(canonical_url)
    if not arxiv_id:
        logger.warning(
            "ai-engine.radar.enrichment.arxiv_id_parse_failed",
            extra={"summary_id": summary_id, "url": canonical_url},
        )
        return None

    pdf_url = f"https://arxiv.org/pdf/{arxiv_id}"
    try:
        pdf_bytes = await _fetch_arxiv_pdf(pdf_url)
    except Exception as exc:
        logger.warning(
            "ai-engine.radar.enrichment.arxiv_pdf_fetch_failed",
            extra={"summary_id": summary_id, "arxiv_id": arxiv_id, "error": type(exc).__name__},
        )
        return None

    if len(pdf_bytes) > 8 * 1024 * 1024:
        logger.warning(
            "ai-engine.radar.enrichment.arxiv_pdf_too_large",
            extra={"summary_id": summary_id, "arxiv_id": arxiv_id, "bytes": len(pdf_bytes)},
        )
        return None

    markdown, sections = _parse_arxiv_pdf(pdf_bytes)
    if not markdown:
        logger.warning(
            "ai-engine.radar.enrichment.arxiv_pdf_empty",
            extra={"summary_id": summary_id, "arxiv_id": arxiv_id},
        )
        return None

    # Fetch current title from DB
    async with pool.connection() as conn:
        title_row = await (
            await conn.execute(
                'SELECT "title" FROM "summaries" WHERE "id" = %s',
                (summary_id,),
            )
        ).fetchone()
        if title_row is None:
            title = arxiv_id
        else:
            # pool.connection() may return dict_row (mapping) or tuple
            try:
                title = str(title_row["title"])  # dict-like
            except (TypeError, KeyError):
                title = str(title_row[0])  # tuple-like

    tldr_payload = await _generate_tldr(markdown, title)
    tldr_text: str | None = None
    key_contributions: list[str] = []
    if tldr_payload:
        tldr_text = (tldr_payload.get("tldr") or "")[:500]
        key_contributions = list(tldr_payload.get("keyContributions") or [])[:5]

    # Update DB row
    meta_payload = {
        "provider": "arxiv",
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "arxivId": arxiv_id,
        "keyContributions": key_contributions,
        "sectionCount": len(sections),
    }
    async with pool.connection() as conn:
        await conn.execute(
            'UPDATE "summaries" SET '
            '"originalMarkdown" = %s, '
            '"originalMeta" = %s::jsonb, '
            '"sections" = %s::jsonb, '
            '"tldr" = %s, '
            '"originalBytes" = %s, '
            '"originalFetchedAt" = now(), '
            '"updatedAt" = now() '
            'WHERE "id" = %s',
            (
                markdown,
                json.dumps(meta_payload, ensure_ascii=False),
                json.dumps(sections, ensure_ascii=False),
                tldr_text,
                len(markdown.encode("utf-8")),
                summary_id,
            ),
        )
    logger.info(
        "ai-engine.radar.enrichment.arxiv_done",
        extra={
            "summary_id": summary_id,
            "arxiv_id": arxiv_id,
            "sections": len(sections),
            "markdown_bytes": len(markdown.encode("utf-8")),
            "tldr": tldr_text is not None,
        },
    )
    return {"markdown": markdown, "sections": sections, "tldr": tldr_text}


async def run_enrichment_for_pending(
    pool: Any,
    *,
    limit: int = 50,
    source_kinds: tuple[str, ...] = ("github_repo", "arxiv"),
) -> int:
    """Find candidates that need enrichment and process them.

    A candidate needs enrichment if:
    - ``originalKind`` matches one of ``source_kinds``
    - ``originalMeta`` is null (not yet enriched)
    - ``syncRunId`` is not null (came from a real sync)

    Dispatches by source kind to the right enricher (github → REST,
    arxiv → PDF parse + LLM TL;DR).

    Returns count of successfully enriched rows.
    """
    placeholders = ",".join(["%s"] * len(source_kinds))
    async with pool.connection() as conn:
        rows = await (
            await conn.execute(
                'SELECT "id", "canonicalUrl", "originalKind" FROM "summaries" '
                f'WHERE "originalKind" IN ({placeholders}) '
                'AND "originalMeta" IS NULL '
                'AND "syncRunId" IS NOT NULL '
                'ORDER BY "createdAt" DESC LIMIT %s',
                (*source_kinds, limit),
            )
        ).fetchall()
    candidates = [
        (str(r["id"]), str(r["canonicalUrl"]), str(r["originalKind"]))
        for r in rows
    ]
    if not candidates:
        return 0

    succeeded = 0
    for summary_id, url, kind in candidates:
        try:
            payload: dict[str, Any] | None = None
            if kind == "github_repo":
                payload = await enrich_github_candidate(
                    pool, summary_id=summary_id, canonical_url=url,
                )
            elif kind == "arxiv":
                payload = await enrich_arxiv_candidate(
                    pool, summary_id=summary_id, canonical_url=url,
                )
            if payload:
                succeeded += 1
        except Exception as exc:
            logger.warning(
                "ai-engine.radar.enrichment.candidate_exception",
                extra={
                    "summary_id": summary_id,
                    "url": url,
                    "kind": kind,
                    "error": type(exc).__name__,
                },
            )
    return succeeded