"""Repair the five historical Zread page gaps with commit-pinned CLI resumes.

The workflow is intentionally source-specific and bounded:

1. Reuse a persistent catalog, recover a corroborated historical catalog,
   or run Zread once to write a new catalog for the historical commit.
2. Inject database pages whose exact paths belong to that catalog.
3. Resume with ``--draft resume`` so Zread spends work on missing pages.
4. Persist the merged page set and re-enter the normal quality/review handoff.

Backups and resumable checkouts live under reports/zread-page-repair by default.
The script never replaces a complete snapshot with a partial one.
"""
# ruff: noqa: E402

from __future__ import annotations

import argparse
import asyncio
import fcntl
import hashlib
import json
import os
import re
import sys
import time
from collections import Counter
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import unquote, urlsplit

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

from ai_engine.job_runner.db_store import DbJobStore
from ai_engine.radar.enrichment_contract import enrichment_review_reset_assignments
from ai_engine.radar.enrichment_worker import (
    _merge_zread_pages,
    _scrub_zread_payload,
    _zread_pages_complete,
    _zread_scoring_markdown,
)
from ai_engine.radar.reader_quality import load_and_persist_reader_quality
from ai_engine.radar.review_reconciliation import finalize_enrichment
from ai_engine.radar.zread_cli import (
    _read_generated_wiki,
    _read_wiki_catalog,
    generate_zread_wiki,
    prepare_zread_checkout,
)


TARGET_IDS = (
    "71bdbe2d-9e8f-4845-9316-0a2d0d92a1d6",
    "d0c584b7-3e61-41a0-b658-195b6eb863b8",
    "4be04c25-982e-4ff2-a55a-c20878e63e26",
    "25bdff5b-c7ed-46f8-88df-2af7a8555a06",
    "5ef755dd-7da9-4070-9ffb-12997b3ddc9b",
)


def _as_dict(value: object) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _repo_parts(url: str) -> tuple[str, str]:
    parsed = urlsplit(url)
    parts = [unquote(part) for part in parsed.path.split("/") if part]
    if parsed.netloc.lower() not in {"github.com", "www.github.com"} or len(parts) < 2:
        raise ValueError(f"not a GitHub repository URL: {url}")
    return parts[0], parts[1].removesuffix(".git")


def _safe_page_path(raw_path: object) -> PurePosixPath | None:
    value = str(raw_path or "").replace("\\", "/").strip()
    if not value:
        return None
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        return None
    return path


def _seed_db_pages(checkout: Path, zread: dict[str, Any]) -> int:
    """Write existing pages into the current CLI draft without overwriting new pages."""
    pages = zread.get("pages")
    if not isinstance(pages, list):
        return 0
    drafts = checkout / ".zread" / "wiki" / "drafts"
    catalog = _read_wiki_catalog(drafts, drafts)
    allowed_paths = {
        entry.get("file") or f"{entry['slug']}.md"
        for entry in catalog.values()
        if entry.get("file") or entry.get("slug")
    }
    if not allowed_paths:
        return 0
    drafts.mkdir(parents=True, exist_ok=True)
    written = 0
    for page in pages:
        if not isinstance(page, dict):
            continue
        path = _safe_page_path(page.get("path"))
        content = str(page.get("content") or "")
        if path is None or str(path) not in allowed_paths or not content.strip():
            continue
        target = drafts.joinpath(*path.parts)
        if not target.resolve().is_relative_to(drafts.resolve()):
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and target.read_text(encoding="utf-8", errors="replace").strip():
            continue
        target.write_text(content, encoding="utf-8")
        written += 1
    return written


def _catalog_page_count(checkout: Path) -> int:
    _, completeness, _ = _read_generated_wiki(checkout / ".zread" / "wiki")
    return len(completeness.get("catalogPaths") or [])


def _recover_catalog_from_links(zread: dict[str, Any]) -> dict[str, Any] | None:
    pages = zread.get("pages")
    expected = int(zread.get("expectedPageCount") or 0)
    if not isinstance(pages, list) or not expected or zread.get("mixedCommits"):
        return None
    by_number: dict[int, dict[str, Any]] = {}
    references: dict[int, dict[str, dict[str, Any]]] = {}
    for page in pages:
        path = str(page.get("path") or "")
        match = re.fullmatch(r"([1-9][0-9]*)-[a-z0-9_-]+\.md", path)
        if not match or not str(page.get("content") or "").strip():
            return None
        number = int(match.group(1))
        if number > expected or number in by_number:
            return None
        by_number[number] = {
            "slug": path.removesuffix(".md"), "file": path,
            **{key: page[key] for key in ("title", "section", "group", "level") if page.get(key)},
        }
        for title, link in re.findall(r"\[([^\]]+)\]\(([^)]+)\)", page["content"]):
            target = re.fullmatch(r"([1-9][0-9]*)-[a-z0-9_-]+(?:\.md)?", link)
            if target is None:
                continue
            slug = link.removesuffix(".md")
            evidence = references.setdefault(int(target.group(1)), {}).setdefault(
                slug, {"sources": set(), "titles": Counter()}
            )
            evidence["sources"].add(path)
            evidence["titles"][title] += 1
    recovered = []
    for number in range(1, expected + 1):
        if number in by_number:
            continue
        candidates = [
            (slug, evidence) for slug, evidence in references.get(number, {}).items()
            if len(evidence["sources"]) >= 2
        ]
        if len(candidates) != 1:
            return None
        slug, evidence = candidates[0]
        by_number[number] = {
            "slug": slug, "file": f"{slug}.md",
            "title": evidence["titles"].most_common(1)[0][0],
        }
        recovered.append({"file": f"{slug}.md", "referencedBy": sorted(evidence["sources"])})
    return {
        "id": f"recovered-{zread.get('commitSha')}",
        "language": "en", "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "pages": [by_number[number] for number in sorted(by_number)],
        "recovery": {"source": "stored-page-cross-references", "missingPages": recovered},
    }


async def _fetch_row(pool: Any, summary_id: str) -> dict[str, Any] | None:
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT "id", "canonicalUrl", "originalMeta", "originalMarkdown", '
                '"enrichmentStatus", "originalSha256" FROM "summaries" WHERE "id" = %s',
                (summary_id,),
            )
        ).fetchone()
    return dict(row) if row else None


def _with_catalog_coverage(zread: dict[str, Any]) -> dict[str, Any]:
    catalog = zread.get("catalogPaths")
    if not isinstance(catalog, list) or not catalog:
        return zread
    result = dict(zread)
    catalog_paths = set(catalog)
    pages = result.get("pages") or []
    if result.get("mixedCommits"):
        missing = set(result.get("missingPages") or catalog)
    else:
        present = {page["path"] for page in pages if page.get("content", "").strip()}
        missing = catalog_paths - present
    covered = len(catalog_paths) - len(missing)
    result.update({
        "catalogPageCount": len(catalog_paths),
        "coveredPageCount": covered,
        "missingPages": sorted(missing),
        "retainedPageCount": len(pages) - covered,
        "pageCount": len(pages),
        "expectedPageCount": len(pages) + len(missing),
    })
    if missing:
        result["status"] = "partial"
    return result


async def _persist_snapshot(
    pool: Any,
    *,
    row: dict[str, Any],
    zread: dict[str, Any],
) -> dict[str, Any]:
    summary_id = str(row["id"])
    old_meta = _as_dict(row.get("originalMeta"))
    merged = _merge_zread_pages(_as_dict(old_meta.get("zread")), zread) or zread
    merged = _scrub_zread_payload(merged)
    merged = _with_catalog_coverage(merged)
    meta = dict(old_meta)
    meta["zread"] = merged
    meta["enrichmentVersion"] = "2.0"
    markdown = _zread_scoring_markdown(merged, None).strip()
    markdown_bytes = markdown.encode("utf-8")
    meta["readerMarkdownComplete"] = bool(markdown)
    meta["readerMarkdownBytes"] = len(markdown_bytes)

    async with pool.connection() as conn:
        cursor = await conn.execute(
            'UPDATE "summaries" SET '
            '"originalMeta" = %s::jsonb, '
            '"originalMarkdown" = %s, '
            '"originalSha256" = %s, '
            '"originalBytes" = %s, '
            '"originalFetchedAt" = now(), '
            f'{enrichment_review_reset_assignments()}, '
            '"updatedAt" = now() '
            'WHERE "id" = %s AND "enrichmentStatus" IN (\'manual\', \'retryable\') '
            'AND "originalMeta" IS NOT DISTINCT FROM %s::jsonb '
            'AND "originalSha256" IS NOT DISTINCT FROM %s',
            (
                json.dumps(meta, ensure_ascii=False),
                markdown or None,
                hashlib.sha256(markdown_bytes).hexdigest() if markdown else None,
                len(markdown_bytes) or None,
                summary_id,
                json.dumps(row.get("originalMeta"), ensure_ascii=False),
                row.get("originalSha256"),
            ),
        )
    if getattr(cursor, "rowcount", 1) == 0:
        raise RuntimeError(f"summary {summary_id} was not in a repairable state")

    quality = await load_and_persist_reader_quality(pool, summary_id=summary_id)
    complete = _zread_pages_complete(merged) and quality.ready
    status = "ready" if complete else "manual"
    error_code = None if complete else "ZREAD_INCOMPLETE"
    error_message = None if complete else "Zread page-level repair is still incomplete"

    async with pool.connection() as conn:
        cursor = await conn.execute(
            'UPDATE "summaries" SET '
            '"enrichmentStatus" = %s, '
            '"enrichmentLockedBy" = NULL, '
            '"enrichmentLeaseExpiresAt" = NULL, '
            '"enrichmentHeartbeatAt" = NULL, '
            '"enrichmentClaimId" = NULL, '
            '"enrichmentNextRetryAt" = NULL, '
            '"enrichmentErrorCode" = %s, '
            '"enrichmentErrorMessage" = %s, '
            '"updatedAt" = now() '
            'WHERE "id" = %s AND "enrichmentStatus" IN (\'manual\', \'retryable\') '
            'AND "originalSha256" IS NOT DISTINCT FROM %s '
            'AND "originalMeta" IS NOT DISTINCT FROM %s::jsonb',
            (
                status, error_code, (error_message or "")[:500] or None, summary_id,
                hashlib.sha256(markdown_bytes).hexdigest() if markdown else None,
                json.dumps(meta, ensure_ascii=False),
            ),
        )
    if getattr(cursor, "rowcount", 1) == 0:
        raise RuntimeError(f"summary {summary_id} changed before source finalization")
    review_error = None
    try:
        await finalize_enrichment(pool, summary_id=summary_id, force_review=True)
    except Exception as exc:  # noqa: BLE001 - source repair must remain durable
        review_error = f"{type(exc).__name__}: {exc}"
    return {
        "status": status,
        "quality": quality.status,
        "pageCount": merged.get("pageCount"),
        "expectedPageCount": merged.get("expectedPageCount"),
        "zreadStatus": merged.get("status"),
        "commitSha": merged.get("commitSha"),
        "coveredPageCount": merged.get("coveredPageCount"),
        "catalogPageCount": merged.get("catalogPageCount"),
        "retainedPageCount": merged.get("retainedPageCount"),
        "missingPages": merged.get("missingPages"),
        "reviewError": review_error,
    }


async def _repair_one(
    pool: Any,
    *,
    summary_id: str,
    work_dir: Path,
    warmup_timeout: float,
    resume_timeout: float,
    recover_catalog: bool = False,
) -> dict[str, Any]:
    row = await _fetch_row(pool, summary_id)
    if not row:
        raise RuntimeError(f"summary not found: {summary_id}")
    if row.get("enrichmentStatus") not in {"manual", "retryable"}:
        raise RuntimeError(f"summary is not repairable: {row.get('enrichmentStatus')}")
    audit_dir = work_dir / "audit" / summary_id
    audit_dir.mkdir(parents=True, exist_ok=True)
    backup = audit_dir / f"before-{hashlib.sha256(json.dumps(row, default=str, sort_keys=True).encode()).hexdigest()}.json"
    if not backup.exists():
        backup.write_text(json.dumps(row, ensure_ascii=False, default=str), encoding="utf-8")
    meta = _as_dict(row.get("originalMeta"))
    old_zread = _as_dict(meta.get("zread"))
    commit_sha = str(old_zread.get("commitSha") or "").strip()
    if not commit_sha:
        raise RuntimeError(f"{summary_id} has no historical Zread commit")
    owner, repo = _repo_parts(str(row["canonicalUrl"]))
    branch = str(old_zread.get("branch") or "main")
    os.environ["ZREAD_CLI_WORK_DIR"] = str(work_dir)

    os.environ["ZREAD_CLI_TIMEOUT_SECONDS"] = str(warmup_timeout)
    checkout = await prepare_zread_checkout(
        owner=owner,
        repo=repo,
        branch=branch,
        commit_sha=commit_sha,
        work_dir=work_dir,
    )
    local_pages, local_completeness, _ = _read_generated_wiki(
        checkout / ".zread" / "wiki"
    )
    local_catalog_count = len(local_completeness.get("catalogPaths") or [])
    local_complete = bool(
        local_pages
        and local_catalog_count
        and not local_completeness.get("truncated")
        and not local_completeness.get("missingPages")
        and len(local_pages) >= int(local_completeness.get("expectedPageCount") or 0)
    )
    if recover_catalog and not local_catalog_count:
        recovered_catalog = _recover_catalog_from_links(old_zread)
        if recovered_catalog is None:
            raise RuntimeError("historical catalog cannot be unambiguously recovered from stored links")
        drafts = checkout / ".zread" / "wiki" / "drafts"
        drafts.mkdir(parents=True, exist_ok=True)
        catalog_path = drafts / "wiki.json"
        with catalog_path.open("x", encoding="utf-8") as catalog_file:
            json.dump(recovered_catalog, catalog_file, ensure_ascii=False)
        (audit_dir / "recovered-catalog.json").write_text(
            json.dumps(recovered_catalog, ensure_ascii=False), encoding="utf-8"
        )
        local_pages, local_completeness, _ = _read_generated_wiki(
            checkout / ".zread" / "wiki"
        )
        local_catalog_count = len(local_completeness.get("catalogPaths") or [])
        local_complete = bool(
            local_pages
            and local_catalog_count
            and not local_completeness.get("truncated")
            and not local_completeness.get("missingPages")
            and len(local_pages) >= int(local_completeness.get("expectedPageCount") or 0)
        )
    warmup_error = None
    first = None
    second = None
    seeded = 0
    catalog_count = local_catalog_count
    candidate: dict[str, Any] | None = None
    if local_complete:
        candidate = {
            "provider": "zread-cli",
            "status": "complete",
            "repository": f"{owner}/{repo}",
            "commitSha": commit_sha,
            "branch": branch,
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "pageCount": len(local_pages),
            **local_completeness,
            "pages": local_pages,
        }
    else:
        try:
            if not local_catalog_count:
                first = await generate_zread_wiki(
                    owner=owner,
                    repo=repo,
                    branch=branch,
                    commit_sha=commit_sha,
                )
        except Exception as exc:  # noqa: BLE001 - resume can continue from catalog
            first = None
            warmup_error = f"{type(exc).__name__}: {exc}"
        catalog_count = _catalog_page_count(checkout)
        if isinstance(first, dict) and _zread_pages_complete(first):
            seeded = 0
        else:
            seeded = _seed_db_pages(checkout, old_zread)
            os.environ["ZREAD_CLI_TIMEOUT_SECONDS"] = str(resume_timeout)
            second = await generate_zread_wiki(
                owner=owner,
                repo=repo,
                branch=branch,
                commit_sha=commit_sha,
            )
        candidate = second or first
    if not isinstance(candidate, dict):
        raise RuntimeError(f"{owner}/{repo}: Zread returned no payload")
    if second and second.get("status") == "complete":
        candidate["expectedPageCount"] = max(
            int(candidate.get("expectedPageCount") or 0),
            catalog_count,
        )
    if recover_catalog:
        candidate["catalogSource"] = "stored-page-cross-references"
    (audit_dir / "latest-candidate.json").write_text(
        json.dumps(candidate, ensure_ascii=False), encoding="utf-8"
    )
    if second and second.get("status") == "complete":
        candidate["expectedPageCount"] = max(
            int(candidate.get("expectedPageCount") or 0),
            catalog_count,
        )
    result = await _persist_snapshot(pool, row=row, zread=candidate)
    return {
        "repo": f"{owner}/{repo}",
        "seeded": seeded,
        "catalogPages": local_catalog_count if local_complete else catalog_count,
        "first": {
            "status": first.get("status") if isinstance(first, dict) else None,
            "pages": first.get("pageCount") if isinstance(first, dict) else None,
            "error": warmup_error,
        },
        "resume": {
            "status": second.get("status") if isinstance(second, dict) else None,
            "pages": second.get("pageCount") if isinstance(second, dict) else None,
        },
        "persisted": result,
    }


async def main() -> int:
    parser = argparse.ArgumentParser(description="Repair historical Zread page gaps")
    parser.add_argument("--summary-id", action="append", dest="summary_ids")
    parser.add_argument(
        "--work-dir",
        default=str(Path(__file__).resolve().parents[1] / "reports" / "zread-page-repair"),
    )
    parser.add_argument("--warmup-timeout", type=float, default=180.0)
    parser.add_argument("--resume-timeout", type=float, default=7200.0)
    parser.add_argument("--recover-catalog", action="store_true")
    args = parser.parse_args()

    selected = tuple(args.summary_ids or TARGET_IDS)
    store = DbJobStore(
        dsn=os.environ.get(
            "DATABASE_URL",
            "postgresql://postgres:postgres@localhost:5432/deep_research",
        ),
    )
    await store.open()
    failures = 0
    try:
        for summary_id in selected:
            try:
                work_dir = Path(args.work_dir).expanduser().resolve()
                work_dir.mkdir(parents=True, exist_ok=True)
                with (work_dir / f"{summary_id}.lock").open("a") as lock_file:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    print(json.dumps({"summaryId": summary_id, "phase": "started"}), flush=True)
                    result = await _repair_one(
                        store.pool,
                        summary_id=summary_id,
                        work_dir=work_dir,
                        warmup_timeout=max(30.0, args.warmup_timeout),
                        resume_timeout=max(30.0, args.resume_timeout),
                        recover_catalog=args.recover_catalog,
                    )
                print(json.dumps(result, ensure_ascii=False, sort_keys=True), flush=True)
            except Exception as exc:  # noqa: BLE001 - continue the bounded batch
                failures += 1
                print(
                    json.dumps(
                        {
                            "summaryId": summary_id,
                            "error": f"{type(exc).__name__}: {exc}",
                        },
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                    flush=True,
                )
    finally:
        await store.close()
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
