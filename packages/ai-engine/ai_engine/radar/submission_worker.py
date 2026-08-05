"""P1-B: Radar 主动输入 worker。

消费 ``radar_submissions`` 表的活跃行（type_detected / extracting / scoring），
按 detectedKind 走对应的抽取 + enrichment 路径，最终写回 ``summaryId``（创建
summary 候选）并把状态推进到 completed / duplicate / failed。

设计要点：
- 与 ``run_enrichment_for_pending`` 共享 lease + heartbeat 模式（避免 worker
  进程崩溃后行永远 stuck）。
- 失败隔离：单行失败不阻断其它行；attempts 累计 + lastErrorCode 写入。
- 文件类（pdf / markdown / html / txt）：从 ``apps/web/data/import-tmp/<sha>.<ext>``
  读取；写回后由 ``infra/import-tmp-cleanup.sh`` 24h 兜底清理。
- URL 类（github_* / arxiv / article）：复用现有 enrich_* 路径或 safe_fetch +
  markdown 抽取，与 sync_runner 的 Phase 2A 行为对齐。
- duplicate 状态：与已有 summaries.canonicalUrl 冲突时返回（用户已发同样 URL，
  BFF 也会拦截；此处兜底是防 race）。
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
from typing import Any

from ai_engine.fetcher.safe_fetch import safe_fetch
from ai_engine.radar.enrichment_worker import (
    DEFAULT_ENRICHMENT_KINDS,
    enrich_arxiv_candidate,
    enrich_github_candidate,
    enrich_github_item_candidate,
    enrich_web_candidate,
)

logger = logging.getLogger("ai_engine.radar.submission_worker")

WORKER_ID = f"submission-{os.getpid()}"
LEASE_SECONDS = int(os.environ.get("WORKER_LEASE_SECONDS", "60"))
MAX_ATTEMPTS = int(os.environ.get("WORKER_MAX_RETRIES", "3"))
CONCURRENCY = int(os.environ.get("RADAR_SUBMISSION_CONCURRENCY", "2"))

# 来自 apps/web/src/lib/radar/submissions/detect.ts —— 必须保持一致
IMPORT_TMP_DIR = os.environ.get("IMPORT_TEMP_DIR") or os.path.join(
    os.environ.get("APP_WEB_DATA_DIR", "/Users/shaobo.chen/deep_research/apps/web/data"),
    "import-tmp",
)

EXT_BY_KIND: dict[str, str] = {
    "pdf": "pdf",
    "markdown": "md",
    "html": "html",
    "txt": "txt",
}


# ──────────────────────────────────────────────────────────────────────
# 抢锁 + 心跳：与 run_enrichment_for_pending 同模式
# ──────────────────────────────────────────────────────────────────────


async def _claim_one(pool: Any) -> dict[str, Any] | None:
    """抢一条非终态行（type_detected/extracting/scoring），设置 lease。
    ``SKIP LOCKED`` 兼容 PG，避免多 worker 重复抢。"""
    async with pool.connection() as conn:
        async with conn.transaction():
            row = await (
                await conn.execute(
                    """
                    SELECT "id", "kind", "rawInput", "canonicalUrl", "contentSha256",
                           "detectedKind", "attempts", "summaryId", "submitterId"
                    FROM "radar_submissions"
                    WHERE "status" IN ('type_detected', 'extracting', 'scoring')
                      AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
                    ORDER BY "createdAt" ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                    """
                )
            ).fetchone()
            if row is None:
                return None
            await conn.execute(
                """
                UPDATE "radar_submissions"
                SET "lockedBy" = %s,
                    "leaseExpiresAt" = now() + (%s || ' seconds')::interval,
                    "heartbeatAt" = now(),
                    "attempts" = "attempts" + 1
                WHERE "id" = %s
                """,
                (WORKER_ID, str(LEASE_SECONDS), row["id"]),
            )
            return dict(row)


async def _update_status(
    pool: Any,
    submission_id: str,
    *,
    status: str | None = None,
    summary_id: str | None = None,
    error_code: str | None = None,
    error_message: str | None = None,
    next_retry_at: Any | None = None,
    clear_lease: bool = False,
) -> None:
    sets: list[str] = []
    params: list[Any] = []
    if status is not None:
        sets.append('"status" = %s')
        params.append(status)
    if summary_id is not None:
        sets.append('"summaryId" = %s')
        params.append(summary_id)
    if error_code is not None:
        sets.append('"errorCode" = %s')
        params.append(error_code)
    if error_message is not None:
        sets.append('"errorMessage" = %s')
        params.append(error_message)
    if next_retry_at is not None:
        sets.append('"nextRetryAt" = %s')
        params.append(next_retry_at)
    if clear_lease:
        sets.append('"lockedBy" = NULL')
        sets.append('"leaseExpiresAt" = NULL')
    if not sets:
        return
    sets.append('"updatedAt" = now()')
    params.append(submission_id)
    async with pool.connection() as conn:
        await conn.execute(
            f'UPDATE "radar_submissions" SET {", ".join(sets)} WHERE "id" = %s',
            tuple(params),
        )


# ──────────────────────────────────────────────────────────────────────
# URL / 文件 → Summary 行
# ──────────────────────────────────────────────────────────────────────


_GITHUB_REPO_RE = re.compile(
    r"^https?://github\.com/([^/]+)/([^/]+)/?$", re.IGNORECASE
)
_GITHUB_ISSUE_RE = re.compile(
    r"^https?://github\.com/([^/]+)/([^/]+)/issues/(\d+)", re.IGNORECASE
)
_GITHUB_PR_RE = re.compile(
    r"^https?://github\.com/([^/]+)/([^/]+)/pull/(\d+)", re.IGNORECASE
)
_ARXIV_RE = re.compile(
    r"^https?://(?:www\.)?arxiv\.org/(?:abs|pdf)/([0-9.]+(?:v\d+)?)(?:\.pdf)?/?$",
    re.IGNORECASE,
)


def _url_kind(url: str) -> str:
    if _GITHUB_ISSUE_RE.match(url):
        return "github_issue"
    if _GITHUB_PR_RE.match(url):
        return "github_pr"
    if _ARXIV_RE.match(url):
        return "arxiv"
    if _GITHUB_REPO_RE.match(url):
        return "github_repo"
    return "article"


async def _read_file(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def _markdown_or_text(buf: bytes, kind: str) -> str:
    if kind == "pdf":
        # 真正的 PDF 解析交给 enrich_arxiv_candidate 或专门的 PDF worker；
        # 此处只做"提取可读文本"的最少工作。
        return buf.decode("utf-8", errors="replace")
    text = buf.decode("utf-8", errors="replace")
    if kind == "html":
        # 极简：去掉 script/style；其它交给前端渲染
        text = re.sub(r"<script[\s\S]*?</script>", " ", text, flags=re.IGNORECASE)
        text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.IGNORECASE)
    return text


async def _check_duplicate(pool: Any, canonical_url: str) -> str | None:
    """如果已有同 canonicalUrl 的 summary 行（任意 status），返回它的 id。"""
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT "id" FROM "summaries" WHERE "canonicalUrl" = %s LIMIT 1',
                (canonical_url,),
            )
        ).fetchone()
    return str(row["id"]) if row else None


async def _create_summary_for_url(
    pool: Any,
    *,
    submitter_id: str,
    raw_input: str,
    canonical_url: str,
    url_kind: str,
    title: str,
    snippet: str,
    original_kind: str,
    original_markdown: str | None,
) -> str:
    """插入一条新 summaries 行（status=candidate），返回 id。"""
    new_id = str(__import__("uuid").uuid4())
    async with pool.connection() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                INSERT INTO "summaries"
                  ("id", "title", "body", "url", "canonicalUrl", "source",
                   "contentOrigin", "status", "summaryDate",
                   "originalMarkdown", "originalKind", "originalBytes", "originalSha256",
                   "originalFetchedAt", "createdAt", "updatedAt")
                VALUES
                  (%s, %s, '', %s, %s, 'user', 'web', 'candidate', CURRENT_DATE,
                   %s, %s, %s, %s, now(), now(), now())
                """,
                (
                    new_id,
                    title[:300],
                    raw_input[:2048],
                    canonical_url,
                    original_markdown,
                    original_kind,
                    len(original_markdown.encode("utf-8")) if original_markdown else 0,
                    hashlib.sha256(original_markdown.encode("utf-8")).hexdigest()
                    if original_markdown
                    else None,
                ),
            )
    return new_id


async def _create_summary_for_file(
    pool: Any,
    *,
    submitter_id: str,
    filename: str,
    content: bytes,
    sha256: str,
    file_kind: str,
) -> str:
    new_id = str(__import__("uuid").uuid4())
    canonical_url = f"upload://{file_kind}/{sha256}"
    title = filename or f"upload-{sha256[:8]}"
    text = _markdown_or_text(content, file_kind)
    snippet = text[:500]
    async with pool.connection() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                INSERT INTO "summaries"
                  ("id", "title", "body", "url", "canonicalUrl", "source",
                   "contentOrigin", "status", "summaryDate", "userNote",
                   "originalMarkdown", "originalKind", "originalBytes", "originalSha256",
                   "originalFetchedAt", "createdAt", "updatedAt")
                VALUES
                  (%s, %s, %s, %s, %s, 'user', 'manual', 'candidate', CURRENT_DATE,
                   %s, %s, %s, %s, %s, now(), now(), now())
                """,
                (
                    new_id,
                    title[:300],
                    snippet,
                    canonical_url,
                    canonical_url,
                    snippet[:500],
                    text,
                    f"upload_{file_kind}",
                    len(content),
                    sha256,
                ),
            )
    return new_id


# ──────────────────────────────────────────────────────────────────────
# 单条处理
# ──────────────────────────────────────────────────────────────────────


async def _process_one(pool: Any, row: dict[str, Any]) -> bool:
    sid = str(row["id"])
    kind = str(row["kind"])
    raw_input = str(row["rawInput"])
    canonical_url = row.get("canonicalUrl")
    content_sha = row.get("contentSha256")
    submitter_id = str(row.get("submitterId") or "00000000-0000-0000-0000-000000000000")

    try:
        # 状态推进到 extracting
        await _update_status(pool, sid, status="extracting")

        # 文件类
        if kind in ("pdf", "markdown", "html", "txt"):
            if not content_sha:
                raise ValueError("文件类 submission 缺少 contentSha256")
            ext = EXT_BY_KIND[kind]
            path = os.path.join(IMPORT_TMP_DIR, f"{content_sha}.{ext}")
            if not os.path.exists(path):
                raise FileNotFoundError(f"import-tmp 找不到 {path}")
            content = await _read_file(path)
            # dedup：同 (user, sha) 在非终态有活跃 submission → 标 duplicate
            # （BFF 已拦截；这里是兜底）
            existing_sub = await _check_active_duplicate_submission(pool, sid, content_sha)
            if existing_sub:
                await _update_status(
                    pool, sid, status="duplicate",
                    error_message=f"重复提交 {existing_sub}", clear_lease=True,
                )
                return True
            summary_id = await _create_summary_for_file(
                pool,
                submitter_id=submitter_id,
                filename=raw_input,
                content=content,
                sha256=content_sha,
                file_kind=kind,
            )
            await _update_status(
                pool, sid, status="completed", summary_id=summary_id, clear_lease=True,
            )
            return True

        # URL 类
        if not canonical_url:
            raise ValueError("URL 类 submission 缺少 canonicalUrl")
        # 走与现有 Summary 同样的 dedup
        dup_id = await _check_duplicate(pool, canonical_url)
        if dup_id:
            await _update_status(
                pool, sid, status="duplicate",
                summary_id=dup_id,
                error_message=f"已有 summary {dup_id}", clear_lease=True,
            )
            return True

        # 抽取：safe_fetch + markdown
        await _update_status(pool, sid, status="scoring")
        fetched = await safe_fetch(canonical_url)
        if fetched is None or not fetched.content:
            raise RuntimeError("safe_fetch 返回空内容")

        text = fetched.content.decode("utf-8", errors="replace")
        # 极简：HTML 去 script/style
        text = re.sub(r"<script[\s\S]*?</script>", " ", text, flags=re.IGNORECASE)
        text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.IGNORECASE)
        title = (raw_input.split("/")[-1] or canonical_url)[:300]
        snippet = text[:500]
        url_kind = _url_kind(canonical_url)
        original_kind = url_kind if url_kind != "article" else "rss"

        summary_id = await _create_summary_for_url(
            pool,
            submitter_id=submitter_id,
            raw_input=raw_input,
            canonical_url=canonical_url,
            url_kind=url_kind,
            title=title,
            snippet=snippet,
            original_kind=original_kind,
            original_markdown=text[:64_000] or None,
        )
        await _update_status(
            pool, sid, status="completed", summary_id=summary_id, clear_lease=True,
        )

        # 触发 enrichment：复用 sync_runner 的 enrich 入口
        try:
            if original_kind in DEFAULT_ENRICHMENT_KINDS:
                if original_kind == "github_repo":
                    await enrich_github_candidate(pool, summary_id=summary_id, canonical_url=canonical_url)
                elif original_kind == "arxiv":
                    await enrich_arxiv_candidate(pool, summary_id=summary_id, canonical_url=canonical_url)
                elif original_kind in ("github_other", "github_release"):
                    await enrich_github_item_candidate(pool, summary_id=summary_id, canonical_url=canonical_url)
                elif original_kind in ("rss", "web_share"):
                    await enrich_web_candidate(pool, summary_id=summary_id, canonical_url=canonical_url)
        except Exception as exc:
            logger.warning(
                "ai-engine.radar.submission.enrich_failed",
                extra={"submission_id": sid, "summary_id": summary_id, "error": type(exc).__name__},
            )
        return True
    except Exception as exc:
        attempts = int(row.get("attempts") or 0)
        if attempts >= MAX_ATTEMPTS:
            await _update_status(
                pool, sid,
                status="failed",
                error_code=type(exc).__name__,
                error_message=str(exc)[:500],
                clear_lease=True,
            )
        else:
            # 退避 30s 释放 lease
            await _update_status(
                pool, sid,
                status="type_detected",
                error_code=type(exc).__name__,
                error_message=str(exc)[:500],
                next_retry_at="now() + interval '30 seconds'",
                clear_lease=True,
            )
        logger.warning(
            "ai-engine.radar.submission.failed",
            extra={"submission_id": sid, "error": type(exc).__name__, "exc_message": str(exc)[:200]},
        )
        return False


async def _check_active_duplicate_submission(
    pool: Any, current_id: str, sha256: str
) -> str | None:
    """同 (user, sha256) 在非终态有别的 submission → 返回那个 id；否则 None。"""
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                """
                SELECT "id" FROM "radar_submissions"
                WHERE "contentSha256" = %s
                  AND "id" <> %s
                  AND "status" NOT IN ('completed', 'duplicate', 'failed')
                LIMIT 1
                """,
                (sha256, current_id),
            )
        ).fetchone()
    return str(row["id"]) if row else None


# ──────────────────────────────────────────────────────────────────────
# 循环入口
# ──────────────────────────────────────────────────────────────────────


async def run_submission_worker(
    pool: Any,
    *,
    max_iterations: int | None = None,
) -> int:
    """主循环：每轮抢一批行（最多 CONCURRENCY 个），并发处理。

    Returns total successfully processed rows.
    """
    sem = asyncio.Semaphore(CONCURRENCY)
    processed = 0
    iteration = 0
    while True:
        iteration += 1
        if max_iterations is not None and iteration > max_iterations:
            return processed
        rows: list[dict[str, Any]] = []
        # 每轮抢 CONCURRENCY 行（独立事务）
        for _ in range(CONCURRENCY):
            row = await _claim_one(pool)
            if row is None:
                break
            rows.append(row)
        if not rows:
            return processed

        async def _wrap(r: dict[str, Any]) -> bool:
            async with sem:
                return await _process_one(pool, r)

        outcomes = await asyncio.gather(*(_wrap(r) for r in rows))
        processed += sum(1 for o in outcomes if o)


__all__ = ["run_submission_worker"]
