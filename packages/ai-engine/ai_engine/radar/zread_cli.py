"""Best-effort Zread CLI adapter for GitHub repository enrichment.

The CLI runs in a temporary shallow checkout. Generated wiki markdown is
returned as a bounded JSON-friendly payload so the existing ``originalMeta``
column can remain the storage boundary. A missing CLI or a generation failure
never fails the radar sync.
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
    return pages, {
        "expectedPageCount": expected_page_count,
        "truncated": bool(truncated_pages),
        "truncatedPages": truncated_pages[:100],
    }


def _read_generated_wiki(wiki_dir: Path) -> tuple[list[dict[str, str]], dict[str, Any], bool]:
    """Read the published Wiki, or drafts when generation failed mid-run.

    Zread only updates ``wiki/current`` after the page phase completes. With
    strict generation, a failed page therefore leaves useful pages under
    ``wiki/drafts`` but no current pointer. Preserve those pages as a partial
    result instead of falling back to README.
    """
    pages, completeness = _read_wiki(wiki_dir / "current")
    if pages:
        return pages, completeness, True
    pages, completeness = _read_wiki(wiki_dir / "drafts")
    return pages, completeness, False


async def generate_zread_wiki(
    *,
    owner: str,
    repo: str,
    branch: str,
    commit_sha: str | None,
) -> dict[str, Any] | None:
    """Clone a repo, run ``zread generate``, and return cached wiki pages."""
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
    repository_url = f"https://github.com/{owner}/{repo}.git"
    with tempfile.TemporaryDirectory(prefix="deep-research-zread-") as temp_dir:
        checkout = Path(temp_dir) / repo
        clone_code, _, clone_err = await _run(
            "git", "clone", "--depth", "1", "--branch", branch, repository_url, str(checkout),
            cwd=Path(temp_dir), timeout=60.0,
        )
        if clone_code != 0:
            raise RuntimeError(f"git clone failed: {clone_err[-400:]}")

        try:
            generate_code, generate_out, generate_err = await _run(
                *_generate_command(binary), cwd=checkout, timeout=timeout,
            )
        except asyncio.TimeoutError:
            # Zread writes pages incrementally. Preserve the pages already
            # generated before the timeout instead of deleting the useful
            # partial document with the temporary checkout.
            pages, completeness, _ = _read_generated_wiki(checkout / ".zread" / "wiki")
            if pages:
                return {
                    "provider": "zread-cli",
                    "status": "partial",
                    "repository": f"{owner}/{repo}",
                    "commitSha": commit_sha,
                    "branch": branch,
                    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "error": "Zread generation stopped after a timeout; showing generated pages",
                    "pageCount": len(pages),
                    "expectedPageCount": completeness["expectedPageCount"],
                    "truncated": True,
                    "truncatedPages": completeness["truncatedPages"],
                    "pages": pages,
                }
            raise
        except asyncio.CancelledError:
            # ``run_enrichment_for_pending`` wraps each candidate in an outer
            # timeout.  That timeout cancels this coroutine, while ``_run``
            # first kills the Zread process group and then re-raises the
            # cancellation.  Read the draft after the child is stopped so the
            # pages already written by Zread survive as a persisted partial
            # result instead of being lost with the temporary checkout.
            pages, completeness, _ = _read_generated_wiki(checkout / ".zread" / "wiki")
            if pages:
                return {
                    "provider": "zread-cli",
                    "status": "partial",
                    "repository": f"{owner}/{repo}",
                    "commitSha": commit_sha,
                    "branch": branch,
                    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "error": "Zread generation stopped by the enrichment timeout; showing generated pages",
                    "pageCount": len(pages),
                    "expectedPageCount": completeness["expectedPageCount"],
                    "truncated": True,
                    "truncatedPages": completeness["truncatedPages"],
                    "pages": pages,
                }
            raise
        if generate_code != 0:
            detail = (generate_err or generate_out).strip().replace("\n", " ")[-500:]
            pages, completeness, _ = _read_generated_wiki(checkout / ".zread" / "wiki")
            if pages:
                return {
                    "provider": "zread-cli",
                    "status": "partial",
                    "repository": f"{owner}/{repo}",
                    "commitSha": commit_sha,
                    "branch": branch,
                    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "error": f"Zread exited with code {generate_code}: {detail}",
                    "pageCount": len(pages),
                    "expectedPageCount": completeness["expectedPageCount"],
                    "truncated": True,
                    "truncatedPages": completeness["truncatedPages"],
                    "pages": pages,
                }
            raise RuntimeError(f"zread generate failed: {detail}")

        pages, completeness, published = _read_generated_wiki(checkout / ".zread" / "wiki")
        if not pages:
            raise RuntimeError("zread generated no markdown pages")

        return {
            "provider": "zread-cli",
            "status": "complete" if published and not completeness["truncated"] else "partial",
            "repository": f"{owner}/{repo}",
            "commitSha": commit_sha,
            "branch": branch,
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "pageCount": len(pages),
            "expectedPageCount": completeness["expectedPageCount"],
            "truncated": completeness["truncated"],
            "truncatedPages": completeness["truncatedPages"],
            **({} if published else {"error": "Zread did not publish a current Wiki; showing generated drafts"}),
            "pages": pages,
        }


__all__ = ["generate_zread_wiki"]
