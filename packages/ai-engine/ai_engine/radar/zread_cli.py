"""Best-effort Zread CLI adapter for GitHub repository enrichment.

The CLI runs in a commit-keyed checkout. Generated wiki markdown is returned
as a bounded JSON-friendly payload so the existing ``originalMeta`` column can
remain the storage boundary. A missing CLI or a generation failure never
fails the radar sync.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

def _env_limit(name: str) -> int:
    """Read an optional positive resource limit; zero means unlimited."""
    try:
        return max(0, int(os.environ.get(name, "0") or "0"))
    except ValueError:
        return 0


# Zread already paginates its generated Wiki. Keep the complete generated
# document by default; deployments can set positive limits as an emergency
# resource guard without changing the persisted status semantics.
ZREAD_MAX_BYTES = _env_limit("ZREAD_MAX_BYTES")
ZREAD_MAX_PAGES = _env_limit("ZREAD_MAX_PAGES")
ZREAD_PAGE_MAX_BYTES = _env_limit("ZREAD_PAGE_MAX_BYTES")


def _work_dir() -> str:
    """Return a durable CLI workspace so interrupted drafts can resume."""
    configured = os.environ.get("ZREAD_CLI_WORK_DIR", "").strip()
    if configured:
        return configured
    return str(Path(tempfile.gettempdir()) / "deep-research-zread")


def _generate_command(binary: str) -> tuple[str, ...]:
    """Build a strict generation command.

    ``--skip-failed`` is intentionally not used here.  It lets Zread return a
    successful process exit even when individual pages failed (for example
    after an LLM 429), which makes an incomplete Wiki look complete to the
    caller.
    """
    return binary, "generate", "-y", "--stdio"


def _enabled() -> bool:
    return os.environ.get("ZREAD_CLI_ENABLED", "1").strip().lower() not in {
        "0", "false", "no", "off",
    }


def _binary() -> str | None:
    configured = os.environ.get("ZREAD_CLI_BIN", "").strip()
    if configured:
        return configured
    resolved = shutil.which("zread")
    if resolved:
        return resolved
    # launchd/uvicorn often have a narrower PATH than the interactive shell.
    # Ask npm for its global root so an npm-installed CLI is still discoverable.
    try:
        global_root = subprocess.check_output(
            ["npm", "root", "-g"], text=True, timeout=3,
        ).strip()
        candidate = Path(global_root) / "zread_cli" / "bin" / "zread.js"
        if candidate.is_file():
            return str(candidate)
    except (OSError, subprocess.SubprocessError):
        pass
    return None


async def _run(*args: str, cwd: Path, timeout: float | None) -> tuple[int, str, str]:
    command = list(args)
    if command and command[0].endswith(".js"):
        command.insert(0, shutil.which("node") or "node")
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        # Zread starts its own helper processes.  Put the whole invocation in
        # a process group so a timeout cannot leave descendants holding the
        # pipes open and making the parent wait forever.
        start_new_session=(os.name == "posix"),
    )
    try:
        if timeout is None:
            stdout, stderr = await process.communicate()
        else:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.CancelledError:
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            process.kill()
        try:
            await asyncio.wait_for(process.communicate(), timeout=5.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            # Do not turn a timeout into a second indefinite wait.  The
            # caller records this repo as failed and the batch continues.
            pass
        raise
    except asyncio.TimeoutError:
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            process.kill()
        try:
            await asyncio.wait_for(process.communicate(), timeout=5.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            pass
        raise
    return process.returncode or 0, stdout.decode("utf-8", errors="replace"), stderr.decode("utf-8", errors="replace")


def _page_title(content: str, fallback: str) -> str:
    match = re.search(r"^#\s+(.+?)\s*$", content, re.MULTILINE)
    return match.group(1).strip()[:200] if match else fallback


def _resolve_wiki_root(wiki_root: Path) -> Path | None:
    """Resolve Zread's ``wiki/current`` pointer to a generated version."""
    if not wiki_root.is_file():
        return wiki_root if wiki_root.exists() else None
    try:
        pointer = wiki_root.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None
    if not pointer or "\n" in pointer or pointer.startswith(("/", "\\")):
        return None
    pointed_root = (wiki_root.parent / pointer).resolve()
    try:
        pointed_root.relative_to(wiki_root.parent.resolve())
    except ValueError:
        return None
    return pointed_root if pointed_root.exists() else None


def _read_wiki_catalog(
    wiki_root: Path,
    resolved_root: Path | None,
) -> dict[str, dict[str, str]]:
    """Read Zread's catalog, which contains the actual document hierarchy."""
    candidates: list[Path] = []
    for root in (resolved_root, wiki_root, wiki_root.parent):
        if root is None:
            continue
        candidates.extend((root / "wiki.json", root.parent / "wiki.json"))

    seen: set[Path] = set()
    for candidate in candidates:
        candidate = candidate.resolve()
        if candidate in seen or not candidate.is_file():
            continue
        seen.add(candidate)
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            continue
        raw_pages = payload.get("pages") if isinstance(payload, dict) else None
        if not isinstance(raw_pages, list):
            continue

        catalog: dict[str, dict[str, str]] = {}
        for raw_page in raw_pages:
            if not isinstance(raw_page, dict):
                continue
            entry = {
                key: str(raw_page[key]).strip()
                for key in ("slug", "file", "title", "section", "group", "level")
                if raw_page.get(key) is not None and str(raw_page[key]).strip()
            }
            if not entry:
                continue
            for key in (entry.get("file"), entry.get("slug")):
                if not key:
                    continue
                normalized = key.replace("\\", "/")
                catalog[normalized] = entry
                catalog[Path(normalized).name] = entry
                if normalized.endswith(".md"):
                    catalog[Path(normalized).stem] = entry
        if catalog:
            return catalog
    return {}


def _read_wiki(wiki_root: Path) -> tuple[list[dict[str, str]], dict[str, Any]]:
    if not wiki_root.exists():
        return [], {"expectedPageCount": 0, "truncated": False, "truncatedPages": []}

    # Zread stores ``wiki/current`` as a small pointer file (for example
    # ``versions/2026-08-20-153736``), not as a Markdown page. Resolve that
    # pointer before walking the generated version. Treating the pointer as a
    # page makes a fake one-page "Wiki" whose content is only the version path.
    resolved_root = _resolve_wiki_root(wiki_root)
    if resolved_root is None:
        return [], {"expectedPageCount": 0, "truncated": False, "truncatedPages": []}
    catalog = _read_wiki_catalog(wiki_root, resolved_root)
    wiki_root = resolved_root
    files = [wiki_root] if wiki_root.is_file() else sorted(wiki_root.rglob("*.md"))
    catalog_page_count = len({
        (entry.get("slug"), entry.get("file"))
        for entry in catalog.values()
        if entry.get("slug") or entry.get("file")
    })
    catalog_paths = sorted({
        entry.get("file") or f"{entry['slug']}.md"
        for entry in catalog.values()
        if entry.get("file") or entry.get("slug")
    })
    expected_page_count = max(len(files), catalog_page_count)
    pages: list[dict[str, str]] = []
    total = 0
    truncated_pages: list[str] = []
    for path in files:
        if not path.is_file():
            continue
        relative = path.name if wiki_root.is_file() else str(path.relative_to(wiki_root))
        if ZREAD_MAX_PAGES > 0 and len(pages) >= ZREAD_MAX_PAGES:
            truncated_pages.append(relative)
            continue
        try:
            content = path.read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            continue
        if not content:
            continue
        remaining = ZREAD_MAX_BYTES - total if ZREAD_MAX_BYTES > 0 else None
        if remaining is not None and remaining <= 0:
            truncated_pages.append(relative)
            continue
        original_size = len(content.encode("utf-8"))
        page_limit = ZREAD_PAGE_MAX_BYTES if ZREAD_PAGE_MAX_BYTES > 0 else original_size
        if remaining is not None:
            page_limit = min(page_limit, remaining)
        content = content[:page_limit]
        if len(content.encode("utf-8")) < original_size:
            truncated_pages.append(relative)
        page: dict[str, str] = {
            "path": relative,
            "title": _page_title(content, path.stem.replace("-", " ").title()),
            "content": content,
        }
        catalog_entry = (
            catalog.get(relative.replace("\\", "/"))
            or catalog.get(path.name)
            or catalog.get(path.stem)
        )
        if catalog_entry:
            # ``section`` is the top-level Zread directory shown in the UI
            # (Get Started / Buzz / Deep Dive). ``group`` is an optional
            # nested bucket; ``level`` is difficulty metadata and is not the
            # radar score tier.
            for key in ("title", "section", "group", "level"):
                value = catalog_entry.get(key)
                if value:
                    page[key] = value
        else:
            # Older CLI versions may omit wiki.json but still preserve real
            # directory nesting. Keep those directory names as hierarchy;
            # never derive hierarchy from a page slug.
            path_parts = Path(relative).parts
            if len(path_parts) >= 2:
                page["section"] = path_parts[0]
            if len(path_parts) >= 3:
                page["group"] = path_parts[1]
        pages.append(page)
        total += len(content.encode("utf-8"))
    saved_paths = {page["path"].replace("\\", "/") for page in pages}
    return pages, {
        "expectedPageCount": expected_page_count,
        "truncated": bool(truncated_pages),
        "truncatedPages": truncated_pages[:100],
        "catalogPaths": catalog_paths,
        "coveredPageCount": len(saved_paths.intersection(catalog_paths)),
        "missingPages": sorted(set(catalog_paths) - saved_paths),
        "uncatalogedPages": sorted(saved_paths - set(catalog_paths)) if catalog_paths else [],
    }


def _read_generated_wiki(wiki_dir: Path) -> tuple[list[dict[str, str]], dict[str, Any], bool]:
    """Read the published Wiki, or drafts when generation failed mid-run.

    Zread only updates ``wiki/current`` after the page phase completes. With
    strict generation, a failed page therefore leaves useful pages under
    ``wiki/drafts`` but no current pointer. A durable checkout can also have
    an older ``current`` pointer beside a newer draft. Merge both snapshots so
    the stale pointer cannot hide newly generated pages; draft content wins on
    path conflicts.
    """
    current_pages, current_completeness = _read_wiki(wiki_dir / "current")
    draft_pages, draft_completeness = _read_wiki(wiki_dir / "drafts")
    if not current_pages:
        return (
            draft_pages,
            draft_completeness,
            _wiki_snapshot_complete(
                draft_pages,
                draft_completeness,
                require_catalog=True,
            ),
        )
    if not draft_pages:
        return current_pages, current_completeness, True

    # The draft is the active write set. Keep old current pages that the
    # draft has not touched yet, while letting the draft replace same-path
    # content. Prefer its catalog whenever it exists because it describes the
    # page set the current generation is trying to complete.
    merged_by_path = {
        str(page["path"]).replace("\\", "/"): page
        for page in current_pages
        if page.get("path")
    }
    merged_by_path.update(
        {
            str(page["path"]).replace("\\", "/"): page
            for page in draft_pages
            if page.get("path")
        }
    )
    pages = [merged_by_path[path] for path in sorted(merged_by_path)]
    catalog_paths = (
        draft_completeness.get("catalogPaths")
        or current_completeness.get("catalogPaths")
    )
    catalog_set = set(catalog_paths or [])
    page_paths = {str(page["path"]).replace("\\", "/") for page in pages}
    missing_pages = sorted(catalog_set - page_paths) if catalog_set else []
    completeness = {
        "expectedPageCount": max(len(pages), len(catalog_set)),
        "truncated": bool(
            current_completeness.get("truncated")
            or draft_completeness.get("truncated")
        ),
        "truncatedPages": sorted(
            set(current_completeness.get("truncatedPages") or [])
            | set(draft_completeness.get("truncatedPages") or [])
        )[:100],
        "catalogPaths": sorted(catalog_set),
        "coveredPageCount": len(catalog_set & page_paths),
        "missingPages": missing_pages,
        "uncatalogedPages": sorted(page_paths - catalog_set) if catalog_set else [],
    }
    # A complete draft is usable even when Zread has not advanced the current
    # pointer yet. This matters after a process interruption during publish.
    draft_complete = _wiki_snapshot_complete(
        draft_pages,
        draft_completeness,
        require_catalog=True,
    )
    return pages, completeness, bool(draft_complete or current_pages)


def _wiki_snapshot_complete(
    pages: list[dict[str, Any]],
    completeness: dict[str, Any],
    *,
    require_catalog: bool = False,
) -> bool:
    """Return whether the local files cover the generated catalog."""
    if not pages or completeness.get("truncated") or completeness.get("missingPages"):
        return False
    if require_catalog and not completeness.get("catalogPaths"):
        return False
    try:
        expected = int(completeness.get("expectedPageCount") or 0)
    except (TypeError, ValueError):
        return False
    return len(pages) >= expected


async def prepare_zread_checkout(
    *,
    owner: str,
    repo: str,
    branch: str,
    commit_sha: str | None,
    work_dir: Path,
) -> Path:
    """Create or validate a persistent checkout pinned to ``commit_sha``.

    Zread drafts are commit-specific. A branch clone followed by a later
    resume can otherwise combine pages generated from different repository
    revisions, especially when the branch moved between attempts.
    """
    repository_url = f"https://github.com/{owner}/{repo}.git"
    key = re.sub(
        r"[^A-Za-z0-9._-]+",
        "_",
        f"{owner}__{repo}__{commit_sha or branch}",
    )
    job_root = work_dir.expanduser().resolve() / key
    checkout = job_root / repo
    job_root.mkdir(parents=True, exist_ok=True)

    if not checkout.exists():
        clone_code, _, clone_err = await _run(
            "git",
            "clone",
            "--depth",
            "1",
            "--branch",
            branch,
            repository_url,
            str(checkout),
            cwd=job_root,
            timeout=60.0,
        )
        if clone_code != 0:
            raise RuntimeError(f"git clone failed: {clone_err[-400:]}")
    elif not (checkout / ".git").exists():
        raise RuntimeError(f"Zread work dir exists but is not a checkout: {checkout}")

    if not commit_sha:
        return checkout

    rev_code, rev_out, rev_err = await _run(
        "git",
        "rev-parse",
        "HEAD",
        cwd=checkout,
        timeout=30.0,
    )
    current_sha = rev_out.strip() if rev_code == 0 else ""
    if current_sha != commit_sha:
        # A non-empty Zread directory belongs to another revision. Refuse to
        # silently reuse it; the caller can choose a fresh commit-keyed work
        # directory instead of producing a mixed document.
        if (checkout / ".zread").exists():
            detail = (rev_err or current_sha or "unknown").strip()
            raise RuntimeError(
                f"Zread checkout revision mismatch for {checkout}: "
                f"expected {commit_sha}, found {detail}; existing draft not reused"
            )
        fetch_code, _, fetch_err = await _run(
            "git",
            "fetch",
            "--depth",
            "1",
            "origin",
            commit_sha,
            cwd=checkout,
            timeout=60.0,
        )
        if fetch_code != 0:
            raise RuntimeError(f"git fetch commit failed: {fetch_err[-400:]}")
        checkout_code, _, checkout_err = await _run(
            "git",
            "checkout",
            "--detach",
            commit_sha,
            cwd=checkout,
            timeout=30.0,
        )
        if checkout_code != 0:
            raise RuntimeError(f"git checkout commit failed: {checkout_err[-400:]}")
    verify_code, verify_out, verify_err = await _run(
        "git",
        "rev-parse",
        "HEAD",
        cwd=checkout,
        timeout=30.0,
    )
    if verify_code != 0 or verify_out.strip() != commit_sha:
        raise RuntimeError(
            f"Zread checkout could not be pinned to {commit_sha}: "
            f"{(verify_err or verify_out).strip()[-300:]}"
        )
    return checkout


async def generate_zread_wiki(
    *,
    owner: str,
    repo: str,
    branch: str,
    commit_sha: str | None,
) -> dict[str, Any] | None:
    """Clone a repo, run ``zread generate``, and return cached wiki pages.

    ``ZREAD_CLI_WORK_DIR`` enables a durable per-repository checkout. Durable
    checkouts are resumed with ``--draft resume`` after a timeout, so a later
    attempt continues from the pages already written by Zread instead of
    regenerating the whole Wiki.
    """
    if not _enabled():
        return None
    binary = _binary()
    if not binary:
        return None

    # A repository wiki is a multi-step generation job (catalog + one page at
    # a time).  Three minutes is not enough for a medium repo and turns a
    # healthy, slow generation into a misleading failure.  Deployments can
    # still lower this explicitly through the environment.
    # A content-size limit would silently hide valid Zread pages, but an
    # unbounded subprocess can hold the enrichment queue forever when the
    # local generator loses network/LLM connectivity.  Keep the generated
    # pages already written to drafts and let the caller persist them as
    # partial when this operational timeout is reached.
    timeout_raw = os.environ.get("ZREAD_CLI_TIMEOUT_SECONDS", "7200").strip()
    try:
        timeout_value = float(timeout_raw)
    except ValueError:
        timeout_value = 0.0
    timeout = timeout_value if timeout_value > 0 else None
    async def run_generation(checkout: Path, *, resume: bool) -> dict[str, Any]:
        command = _generate_command(binary)
        if resume:
            command += ("--draft", "resume")
        try:
            generate_code, generate_out, generate_err = await _run(
                *command,
                cwd=checkout,
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            # Zread writes pages incrementally. Read the draft before returning
            # so the caller can persist progress and a durable work dir can
            # resume from the same checkout on the next attempt.
            pages, completeness, _ = _read_generated_wiki(
                checkout / ".zread" / "wiki"
            )
            if pages:
                return {
                    "provider": "zread-cli",
                    "status": "complete" if _wiki_snapshot_complete(
                        pages, completeness, require_catalog=True,
                    ) else "partial",
                    "repository": f"{owner}/{repo}",
                    "commitSha": commit_sha,
                    "branch": branch,
                    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "error": "Zread generation stopped after a timeout; showing generated pages",
                    "pageCount": len(pages),
                    **completeness,
                    "truncated": True,
                    "truncatedPages": completeness["truncatedPages"],
                    "pages": pages,
                }
            raise
        except asyncio.CancelledError:
            # ``run_enrichment_for_pending`` wraps each candidate in an outer
            # timeout. ``_run`` kills the process group first; read the draft
            # after that so durable mode can resume the generated pages later.
            pages, completeness, _ = _read_generated_wiki(
                checkout / ".zread" / "wiki"
            )
            if pages:
                return {
                    "provider": "zread-cli",
                    "status": "complete" if _wiki_snapshot_complete(
                        pages, completeness, require_catalog=True,
                    ) else "partial",
                    "repository": f"{owner}/{repo}",
                    "commitSha": commit_sha,
                    "branch": branch,
                    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "error": "Zread generation stopped by the enrichment timeout; showing generated pages",
                    "pageCount": len(pages),
                    **completeness,
                    "truncated": True,
                    "truncatedPages": completeness["truncatedPages"],
                    "pages": pages,
                }
            raise
        if generate_code != 0:
            detail = (generate_err or generate_out).strip().replace("\n", " ")[-500:]
            pages, completeness, _ = _read_generated_wiki(
                checkout / ".zread" / "wiki"
            )
            if pages:
                return {
                    "provider": "zread-cli",
                    "status": "complete" if _wiki_snapshot_complete(
                        pages, completeness, require_catalog=True,
                    ) else "partial",
                    "repository": f"{owner}/{repo}",
                    "commitSha": commit_sha,
                    "branch": branch,
                    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "error": f"Zread exited with code {generate_code}: {detail}",
                    "pageCount": len(pages),
                    **completeness,
                    "truncated": True,
                    "truncatedPages": completeness["truncatedPages"],
                    "pages": pages,
                }
            raise RuntimeError(f"zread generate failed: {detail}")

        pages, completeness, published = _read_generated_wiki(
            checkout / ".zread" / "wiki"
        )
        if not pages:
            raise RuntimeError("zread generated no markdown pages")

        return {
            "provider": "zread-cli",
            "status": "complete" if (
                published and _wiki_snapshot_complete(pages, completeness)
            ) else "partial",
            "repository": f"{owner}/{repo}",
            "commitSha": commit_sha,
            "branch": branch,
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "pageCount": len(pages),
            **completeness,
            "truncated": completeness["truncated"],
            "truncatedPages": completeness["truncatedPages"],
            **({} if published else {"error": "Zread did not publish a current Wiki; showing generated drafts"}),
            "pages": pages,
        }

    persistent_root = Path(_work_dir())
    checkout = await prepare_zread_checkout(
        owner=owner,
        repo=repo,
        branch=branch,
        commit_sha=commit_sha,
        work_dir=persistent_root,
    )
    has_draft = (checkout / ".zread" / "wiki" / "drafts").exists()
    has_published = (checkout / ".zread" / "wiki" / "current").exists()
    return await run_generation(
        checkout,
        resume=has_draft or has_published,
    )


__all__ = ["generate_zread_wiki", "prepare_zread_checkout"]
