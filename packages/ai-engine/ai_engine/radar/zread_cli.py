"""Best-effort Zread CLI adapter for GitHub repository enrichment.

The CLI runs in a temporary shallow checkout. Generated wiki markdown is
returned as a bounded JSON-friendly payload so the existing ``originalMeta``
column can remain the storage boundary. A missing CLI or a generation failure
never fails the radar sync.
"""

from __future__ import annotations

import asyncio
import os
import re
import signal
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

ZREAD_MAX_BYTES = 120_000
ZREAD_MAX_PAGES = 24
ZREAD_PAGE_MAX_BYTES = 24_000


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
        except asyncio.TimeoutError:
            # Do not turn a timeout into a second indefinite wait.  The
            # caller records this repo as failed and the batch continues.
            pass
        raise
    return process.returncode or 0, stdout.decode("utf-8", errors="replace"), stderr.decode("utf-8", errors="replace")


def _page_title(content: str, fallback: str) -> str:
    match = re.search(r"^#\s+(.+?)\s*$", content, re.MULTILINE)
    return match.group(1).strip()[:200] if match else fallback


def _read_wiki(wiki_root: Path) -> tuple[list[dict[str, str]], dict[str, Any]]:
    if not wiki_root.exists():
        return [], {"expectedPageCount": 0, "truncated": False, "truncatedPages": []}

    # Zread stores ``wiki/current`` as a small pointer file (for example
    # ``versions/2026-08-20-153736``), not as a Markdown page. Resolve that
    # pointer before walking the generated version. Treating the pointer as a
    # page makes a fake one-page "Wiki" whose content is only the version path.
    if wiki_root.is_file():
        try:
            pointer = wiki_root.read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            return [], {"expectedPageCount": 0, "truncated": False, "truncatedPages": []}
        if not pointer or "\n" in pointer or pointer.startswith(("/", "\\")):
            return [], {"expectedPageCount": 0, "truncated": False, "truncatedPages": []}
        pointed_root = (wiki_root.parent / pointer).resolve()
        try:
            pointed_root.relative_to(wiki_root.parent.resolve())
        except ValueError:
            return [], {"expectedPageCount": 0, "truncated": False, "truncatedPages": []}
        if not pointed_root.exists():
            return [], {"expectedPageCount": 0, "truncated": False, "truncatedPages": []}
        wiki_root = pointed_root
    files = [wiki_root] if wiki_root.is_file() else sorted(wiki_root.rglob("*.md"))
    pages: list[dict[str, str]] = []
    total = 0
    truncated_pages: list[str] = []
    for path in files:
        if not path.is_file():
            continue
        relative = path.name if wiki_root.is_file() else str(path.relative_to(wiki_root))
        if len(pages) >= ZREAD_MAX_PAGES:
            truncated_pages.append(relative)
            continue
        try:
            content = path.read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            continue
        if not content:
            continue
        remaining = ZREAD_MAX_BYTES - total
        if remaining <= 0:
            truncated_pages.append(relative)
            continue
        original_size = len(content.encode("utf-8"))
        content = content[: min(ZREAD_PAGE_MAX_BYTES, remaining)]
        if len(content.encode("utf-8")) < original_size:
            truncated_pages.append(relative)
        pages.append({
            "path": relative,
            "title": _page_title(content, path.stem.replace("-", " ").title()),
            "content": content,
        })
        total += len(content.encode("utf-8"))
    return pages, {
        "expectedPageCount": len(files),
        "truncated": bool(truncated_pages),
        "truncatedPages": truncated_pages[:100],
    }


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
    timeout_raw = os.environ.get("ZREAD_CLI_TIMEOUT_SECONDS", "0").strip()
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
            pages, completeness = _read_wiki(checkout / ".zread" / "wiki" / "current")
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
        if generate_code != 0:
            detail = (generate_err or generate_out).strip().replace("\n", " ")[-500:]
            pages, completeness = _read_wiki(checkout / ".zread" / "wiki" / "current")
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

        pages, completeness = _read_wiki(checkout / ".zread" / "wiki" / "current")
        if not pages:
            raise RuntimeError("zread generated no markdown pages")

        return {
            "provider": "zread-cli",
            "status": "partial" if completeness["truncated"] else "complete",
            "repository": f"{owner}/{repo}",
            "commitSha": commit_sha,
            "branch": branch,
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "pageCount": len(pages),
            "expectedPageCount": completeness["expectedPageCount"],
            "truncated": completeness["truncated"],
            "truncatedPages": completeness["truncatedPages"],
            "pages": pages,
        }


__all__ = ["generate_zread_wiki"]
