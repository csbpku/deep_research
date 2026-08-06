"""Deterministic file-import worker for Week 3.

The web app stores an opaque object key in ``content_import_jobs``. This
worker owns conversion, draft creation, terminal state, and file cleanup.
No LLM is involved in this path.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid
from contextlib import suppress
from html.parser import HTMLParser
from pathlib import Path
from typing import cast
from urllib.parse import urlparse

from ai_engine.job_runner.db_store import IMPORT_TABLE, DbJobStore
from ai_engine.job_runner.models import JobLease, LeaseLostError

MAX_FILE_BYTES = 5 * 1024 * 1024
ALLOWED_EXTENSIONS = {".md", ".txt", ".html"}
_DANGEROUS_TAGS = {"script", "style", "iframe", "object", "embed", "applet"}


def default_temp_dir() -> Path:
    configured = os.environ.get("IMPORT_TEMP_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    workspace_root = Path(__file__).resolve().parents[3]
    return (workspace_root / "apps" / "web" / "data" / "import-tmp").resolve()


class _HtmlToMarkdown(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.warnings: list[str] = []
        self._skip_depth = 0
        self._list_stack: list[str] = []
        self._link_href: str | None = None
        self._link_text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in _DANGEROUS_TAGS:
            self._skip_depth += 1
            self.warnings.append(f"removed unsafe <{tag}> element")
            return
        if self._skip_depth:
            return
        attributes = {name.lower(): value for name, value in attrs}
        if any(name.startswith("on") for name in attributes):
            self.warnings.append("removed HTML event handler attribute")
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._block_break()
            self.parts.append("#" * int(tag[1]) + " ")
        elif tag in {"p", "div", "section", "article"}:
            self._block_break()
        elif tag == "br":
            self.parts.append("\n")
        elif tag in {"ul", "ol"}:
            self._list_stack.append(tag)
            self._block_break()
        elif tag == "li":
            self._block_break(single=True)
            self.parts.append("1. " if self._list_stack and self._list_stack[-1] == "ol" else "- ")
        elif tag == "blockquote":
            self._block_break()
            self.parts.append("> ")
        elif tag == "pre":
            self._block_break()
            self.parts.append("```\n")
        elif tag == "code" and not self._endswith("```\n"):
            self.parts.append("`")
        elif tag in {"strong", "b"}:
            self.parts.append("**")
        elif tag in {"em", "i"}:
            self.parts.append("*")
        elif tag == "a":
            href = (attributes.get("href") or "").strip()
            parsed = urlparse(href)
            self._link_href = href if parsed.scheme in {"http", "https", "mailto"} else None
            if href and self._link_href is None:
                self.warnings.append("removed unsafe link URL")
            self._link_text = []
        elif tag == "tr":
            self._block_break(single=True)
            self.parts.append("| ")
        elif tag in {"th", "td"}:
            if not self._endswith("| "):
                self.parts.append("| ")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in _DANGEROUS_TAGS:
            if self._skip_depth:
                self._skip_depth -= 1
            return
        if self._skip_depth:
            return
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "section", "article"}:
            self._block_break()
        elif tag in {"ul", "ol"}:
            if self._list_stack:
                self._list_stack.pop()
            self._block_break()
        elif tag in {"li", "blockquote"}:
            self._block_break(single=True)
        elif tag == "pre":
            self.parts.append("\n```\n\n")
        elif tag == "code" and not self._endswith("\n```\n\n"):
            self.parts.append("`")
        elif tag in {"strong", "b"}:
            self.parts.append("**")
        elif tag in {"em", "i"}:
            self.parts.append("*")
        elif tag == "a":
            text = "".join(self._link_text).strip()
            if self._link_href:
                self.parts.append(f"[{text}]({self._link_href})")
            else:
                self.parts.append(text)
            self._link_href = None
            self._link_text = []
        elif tag in {"th", "td"}:
            self.parts.append("| ")
        elif tag == "tr":
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        if self._link_href is not None or self._link_text:
            self._link_text.append(data)
        else:
            self.parts.append(data)

    def markdown(self) -> str:
        value = "".join(self.parts)
        value = re.sub(r"[ \t]+\n", "\n", value)
        value = re.sub(r"\n{3,}", "\n\n", value)
        return value.strip()

    def _block_break(self, *, single: bool = False) -> None:
        suffix = "\n" if single else "\n\n"
        if self.parts and not self._endswith(suffix):
            self.parts.append(suffix)

    def _endswith(self, value: str) -> bool:
        return bool(self.parts) and self.parts[-1].endswith(value)


def convert_to_markdown(content: str, extension: str) -> tuple[str, list[str]]:
    extension = extension.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise ValueError(f"unsupported extension: {extension}")
    if extension == ".html":
        parser = _HtmlToMarkdown()
        parser.feed(content)
        parser.close()
        markdown = parser.markdown()
        if not markdown:
            raise ValueError("HTML contains no importable text")
        return markdown, sorted(set(parser.warnings))
    return content.strip(), []


def _safe_temp_path(object_key: str, temp_dir: Path) -> Path:
    if not object_key or Path(object_key).name != object_key:
        raise ValueError("invalid temp object key")
    root = temp_dir.resolve()
    candidate = (root / object_key).resolve()
    if candidate.parent != root:
        raise ValueError("temp object escaped import directory")
    return candidate


async def _heartbeat_until_done(store: DbJobStore, lease: JobLease, done: asyncio.Event) -> None:
    interval = max(1.0, float(lease.heartbeat_interval_seconds))
    while not done.is_set():
        try:
            await asyncio.wait_for(done.wait(), timeout=interval)
            return
        except TimeoutError:
            heartbeat = await store.heartbeat(lease)
            if not heartbeat.renewed:
                raise LeaseLostError(heartbeat.reason or "import lease lost")


async def run_one_import_job(
    store: DbJobStore,
    *,
    worker_id: str,
    temp_dir: Path | None = None,
) -> str | None:
    if store.table_name != IMPORT_TABLE:
        raise ValueError("import worker requires content_import_jobs store")
    acquired = await store.acquire_next_job(worker_id)
    if acquired is None:
        return None
    lease, snapshot = acquired
    root = temp_dir or default_temp_dir()
    done = asyncio.Event()
    heartbeat_task = asyncio.create_task(_heartbeat_until_done(store, lease, done))
    temp_path: Path | None = None
    terminal_written = False
    try:
        pool = store.pool
        async with pool.connection() as conn:
            cur = await conn.execute(
                'SELECT "tempObjectKey", "originalFilename", "mimeType", "sizeBytes", "sourceKind", "sourceUrl", "externalPageId", "externalVersion" '
                'FROM "content_import_jobs" WHERE "id" = %s AND "lockedBy" = %s',
                (lease.job_id, lease.worker_id),
            )
            row = await cur.fetchone()
        if row is None:
            raise LeaseLostError("import lease lost before conversion")
        record = dict(row)
        source_kind = str(record.get("sourceKind") or "file")
        object_key = str(record.get("tempObjectKey") or "")
        original_filename = str(record.get("originalFilename") or "Imported document")
        extension = Path(original_filename).suffix.lower()
        temp_path = _safe_temp_path(object_key, root)
        raw = await asyncio.to_thread(temp_path.read_bytes)
        if len(raw) > MAX_FILE_BYTES:
            raise ValueError("file exceeds 5MB")
        content = raw.decode("utf-8", errors="strict")
        markdown, warnings = convert_to_markdown(content, extension)
        if not markdown:
            raise ValueError("file is empty")
        if heartbeat_task.done():
            await heartbeat_task

        research_id = str(uuid.uuid4())
        title = Path(original_filename).stem.strip()[:300] or "Imported document"
        async with pool.connection() as conn:
            async with conn.transaction():
                await conn.execute(
                    'INSERT INTO "researches" '
                    '("id", "type", "status", "title", "body", "authorId", '
                    ' "creationMethod", "aiAssisted", "createdAt", "updatedAt") '
                    "VALUES (%s, 'research', 'draft', %s, %s, %s, %s, false, now(), now())",
                    (research_id, title, markdown, snapshot.requester_id, 'confluence_import' if source_kind == 'confluence' else 'file_import'),
                )
                await conn.execute(
                    'INSERT INTO "research_audit" '
                    '("researchId", "editorId", "action", "createdAt") '
                    "VALUES (%s, %s, 'create', now())",
                    (research_id, snapshot.requester_id),
                )
                cur = await conn.execute(
                    'UPDATE "content_import_jobs" SET "status" = \'succeeded\', '
                    '"warnings" = %s::jsonb, "outputResearchId" = %s, "completedAt" = now(), '
                    '"lockedBy" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL '
                    'WHERE "id" = %s AND "lockedBy" = %s AND "status" = \'running\' RETURNING "id"',
                    (json.dumps(warnings), research_id, lease.job_id, lease.worker_id),
                )
                if await cur.fetchone() is None:
                    raise LeaseLostError("import lease lost before commit")
        terminal_written = True
        return lease.job_id
    except LeaseLostError:
        raise
    except (UnicodeDecodeError, ValueError, OSError) as exc:
        code = "IMPORT_NOT_UTF8" if isinstance(exc, UnicodeDecodeError) else "VALIDATION_FAILED"
        await store.mark_terminal(
            lease,
            "failed",
            current_step=None,
            error_code=code,
            error_message=str(exc)[:500],
            draft_research_id=None,
        )
        terminal_written = True
        return lease.job_id
    finally:
        done.set()
        heartbeat_task.cancel()
        with suppress(asyncio.CancelledError):
            await heartbeat_task
        if terminal_written and temp_path is not None:
            with suppress(FileNotFoundError):
                await asyncio.to_thread(temp_path.unlink)


async def run_import_worker_once() -> str | None:
    store = DbJobStore(table_name=IMPORT_TABLE)
    async with store:
        async with store.pool.connection() as conn:
            rows = await (
                await conn.execute(
                    'SELECT "tempObjectKey" FROM "content_import_jobs" '
                    "WHERE \"status\" IN ('queued', 'running') AND \"tempObjectKey\" IS NOT NULL"
                )
            ).fetchall()
        protected_keys = {
            str(cast(dict[str, object], row)["tempObjectKey"]) for row in rows
        }
        await cleanup_stale_import_files(
            default_temp_dir(), protected_keys=protected_keys
        )
        return await run_one_import_job(store, worker_id=f"import-{os.getpid()}")


async def cleanup_stale_import_files(
    temp_dir: Path,
    *,
    max_age_seconds: int = 24 * 60 * 60,
    protected_keys: set[str] | None = None,
) -> int:
    """Remove abandoned upload objects older than the retention window."""
    root = temp_dir.resolve()
    if not root.exists():
        return 0
    now = time.time()
    protected = protected_keys or set()
    removed = 0
    for path in root.iterdir():
        if (
            path.is_file()
            and path.name not in protected
            and now - path.stat().st_mtime > max_age_seconds
        ):
            await asyncio.to_thread(path.unlink)
            removed += 1
    return removed


if __name__ == "__main__":  # pragma: no cover
    print(asyncio.run(run_import_worker_once()) or "queue empty")
