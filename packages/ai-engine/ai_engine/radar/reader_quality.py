"""Deterministic quality contract for high-value radar reading surfaces.

Enrichment writes source-specific payloads, but a non-empty payload is not
enough to promise a readable document.  This module keeps the first-principles
gate cheap, deterministic, and independent from the utility LLM reviewer.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Literal

from collections.abc import Mapping

ReaderQualityStatus = Literal["ready", "incomplete", "invalid"]
READER_QUALITY_VERSION = "1.1"
MIN_READER_CONTENT_CHARS = 200
MIN_MEANINGFUL_CARD_CONTENT_CHARS = 1_000

_BOT_MARKERS = (
    "just a moment...",
    "enable javascript and cookies to continue",
    "checking your browser before accessing",
    "performance & security by cloudflare",
    "verify you are human",
)
_CARD_MARKERS = (
    "models citing this paper",
    "datasets citing this paper",
    "collections including this paper",
    "/collections/",
    "/models/",
)


@dataclass(frozen=True, slots=True)
class ReaderQuality:
    status: ReaderQualityStatus
    reason: str
    message: str
    char_count: int
    fingerprint: str
    details: dict[str, Any]
    content_sha256: str = ""

    @property
    def ready(self) -> bool:
        return self.status == "ready"

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": READER_QUALITY_VERSION,
            "status": self.status,
            "reason": self.reason,
            "message": self.message,
            "charCount": self.char_count,
            "fingerprint": self.fingerprint,
            "contentSha256": self.content_sha256,
            **self.details,
        }


def _as_dict(value: object) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, Mapping):
        return dict(value)
    return None


def _int_value(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return max(0, int(value))
    if isinstance(value, str):
        try:
            return max(0, int(value))
        except ValueError:
            return 0
    return 0


def _fingerprint(kind: str, markdown: str, original_meta: object) -> str:
    meta = _as_dict(original_meta) or {}
    zread = _as_dict(meta.get("zread")) or {}
    source_state = {
        "kind": kind,
        "markdownSha256": hashlib.sha256(markdown.encode("utf-8")).hexdigest(),
        "enrichmentVersion": meta.get("enrichmentVersion"),
        "readerMarkdownComplete": meta.get("readerMarkdownComplete"),
        "zread": {
            "status": zread.get("status"),
            "provider": zread.get("provider"),
            "pageCount": zread.get("pageCount"),
            "expectedPageCount": zread.get("expectedPageCount"),
            "generatedAt": zread.get("generatedAt"),
            "missingPages": zread.get("missingPages"),
            "mixedCommits": zread.get("mixedCommits"),
        },
    }
    return hashlib.sha256(
        json.dumps(
            source_state,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def _result(
    *,
    kind: str,
    markdown: str,
    original_meta: object,
    status: ReaderQualityStatus,
    reason: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> ReaderQuality:
    return ReaderQuality(
        status=status,
        reason=reason,
        message=message,
        char_count=len(markdown.strip()),
        fingerprint=_fingerprint(kind, markdown, original_meta),
        details=details or {},
        content_sha256=hashlib.sha256(markdown.encode("utf-8")).hexdigest(),
    )


def _looks_like_collection_card(markdown: str) -> bool:
    lowered = markdown.lower()
    # A real article or model card can legitimately link to models and
    # collections in its body or related-links footer.  Those links are only
    # evidence of a card shell when the captured body is still short.
    if len(markdown.strip()) < MIN_MEANINGFUL_CARD_CONTENT_CHARS and any(
        marker in lowered for marker in _CARD_MARKERS
    ):
        return True
    lines = [line.strip() for line in markdown.splitlines() if line.strip()]
    if not lines or len(lines) > 8:
        return False
    if all(
        line.startswith(("[", "![", "No ", "Models ", "Datasets ", "Collections "))
        or re.fullmatch(r"[-*_` ]+", line)
        for line in lines
    ):
        return True
    return bool(
        len(markdown.strip()) < MIN_MEANINGFUL_CARD_CONTENT_CHARS
        and re.fullmatch(r"(?:\[[^\]]+\]\([^)]+\)|\s|[•·|0-9A-Za-z:/._-])+", markdown.strip())
    )


def _github_quality(
    *,
    kind: str,
    markdown: str,
    original_meta: object,
) -> ReaderQuality | None:
    if kind != "github_repo":
        return None
    meta = _as_dict(original_meta)
    zread = _as_dict(meta.get("zread")) if meta else None
    if not zread:
        return _result(
            kind=kind,
            markdown=markdown,
            original_meta=original_meta,
            status="incomplete",
            reason="github_zread_missing",
            message="GitHub 仓库尚未形成可交付的项目文档。",
        )
    provider = str(zread.get("provider") or "")
    status = str(zread.get("status") or "")
    page_count = _int_value(zread.get("pageCount"))
    expected = _int_value(zread.get("expectedPageCount"))
    if provider == "github-readme-fallback":
        return _result(
            kind=kind,
            markdown=markdown,
            original_meta=original_meta,
            status="incomplete",
            reason="github_readme_fallback",
            message="当前只有 README fallback，尚未覆盖项目文档。",
            details={"pageCount": page_count, "expectedPageCount": expected},
        )
    if status != "complete":
        return _result(
            kind=kind,
            markdown=markdown,
            original_meta=original_meta,
            status="incomplete",
            reason=f"github_zread_{status or 'unknown'}",
            message="GitHub 项目文档尚未完整生成。",
            details={"pageCount": page_count, "expectedPageCount": expected},
        )
    if expected > 0 and page_count < expected:
        return _result(
            kind=kind,
            markdown=markdown,
            original_meta=original_meta,
            status="incomplete",
            reason="github_zread_page_gap",
            message="GitHub 项目文档页数不足，不能承诺完整阅读。",
            details={"pageCount": page_count, "expectedPageCount": expected},
        )
    if zread.get("missingPages") or zread.get("mixedCommits"):
        return _result(
            kind=kind,
            markdown=markdown,
            original_meta=original_meta,
            status="incomplete",
            reason="github_zread_catalog_gap",
            message="项目文档目录仍有缺页或混合版本，不能承诺完整阅读。",
            details={
                "pageCount": page_count, "expectedPageCount": expected,
                "missingPages": zread.get("missingPages") or [],
                "mixedCommits": bool(zread.get("mixedCommits")),
            },
        )
    return None


def evaluate_reader_quality(
    *,
    kind: str,
    markdown: str | None,
    original_meta: object = None,
) -> ReaderQuality:
    """Evaluate whether a high-value source can be presented as full reading."""
    content = str(markdown or "")
    stripped = content.strip()
    github_result = _github_quality(
        kind=kind,
        markdown=content,
        original_meta=original_meta,
    )
    if github_result is not None:
        if github_result.status != "ready" and not stripped:
            return github_result
        if github_result.status != "ready":
            return github_result
        return github_result

    if not stripped:
        return _result(
            kind=kind,
            markdown=content,
            original_meta=original_meta,
            status="incomplete",
            reason="empty_content",
            message="没有可供阅读的正文。",
        )
    lowered = stripped.lower()
    if any(marker in lowered for marker in _BOT_MARKERS):
        return _result(
            kind=kind,
            markdown=content,
            original_meta=original_meta,
            status="invalid",
            reason="bot_or_verification_shell",
            message="抓取结果疑似验证页或机器人拦截页。",
        )
    if kind in {"rss", "web_share"} and _looks_like_collection_card(stripped):
        return _result(
            kind=kind,
            markdown=content,
            original_meta=original_meta,
            status="incomplete",
            reason="source_card_only",
            message="抓取到的是来源卡片，不是可阅读的正文。",
        )
    if len(stripped) < MIN_READER_CONTENT_CHARS:
        return _result(
            kind=kind,
            markdown=content,
            original_meta=original_meta,
            status="incomplete",
            reason="content_too_short",
            message="正文过短，只有页面摘要或壳内容。",
        )
    meta = _as_dict(original_meta) or {}
    if (
        kind in {"github_repo", "arxiv"}
        and len(stripped) >= 500_000
        and meta.get("readerMarkdownComplete") is not True
    ):
        return _result(
            kind=kind,
            markdown=content,
            original_meta=original_meta,
            status="incomplete",
            reason="legacy_reader_truncation",
            message="正文命中了历史存储边界，完整性尚未得到确认。",
        )
    if (
        kind in {"rss", "web_share"}
        and len(stripped) < MIN_MEANINGFUL_CARD_CONTENT_CHARS
        and not re.search(r"(?m)^(?:#{1,6}\s+|\S.{80,})", stripped)
    ):
        return _result(
            kind=kind,
            markdown=content,
            original_meta=original_meta,
            status="incomplete",
            reason="insufficient_prose",
            message="正文有效段落不足，不能承诺完整阅读。",
        )
    if re.fullmatch(r"\s*!?\[[^\]]*\]\([^)]*\)\s*", stripped):
        return _result(
            kind=kind,
            markdown=content,
            original_meta=original_meta,
            status="incomplete",
            reason="link_or_image_only",
            message="抓取结果只有链接或图片标记。",
        )
    return _result(
        kind=kind,
        markdown=content,
        original_meta=original_meta,
        status="ready",
        reason="reader_contract_satisfied",
        message="正文满足当前来源的可阅读契约。",
    )


class ReaderQualityConflict(RuntimeError):
    """The source snapshot changed before quality could be persisted."""


async def load_and_persist_reader_quality(
    pool: Any,
    *,
    summary_id: str,
    claim_id: str | None = None,
) -> ReaderQuality:
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT "originalKind", "originalMarkdown", "originalMeta", '
                '"originalSha256" '
                'FROM "summaries" WHERE "id" = %s',
                (summary_id,),
            )
        ).fetchone()
        if row is None:
            return evaluate_reader_quality(kind="", markdown="")
        quality = evaluate_reader_quality(
            kind=str(row.get("originalKind") or ""),
            markdown=str(row.get("originalMarkdown") or ""),
            original_meta=row.get("originalMeta"),
        )
        stored_sha256 = row.get("originalSha256")
        if stored_sha256 is None:
            snapshot_guard = (
                '"originalSha256" IS NULL '
                'AND "originalMarkdown" IS NOT DISTINCT FROM %s'
            )
            snapshot_params: tuple[Any, ...] = (
                str(row.get("originalMarkdown") or ""),
            )
        else:
            snapshot_guard = '"originalSha256" IS NOT DISTINCT FROM %s'
            snapshot_params = (str(stored_sha256),)
        claim_guard = ""
        claim_params: tuple[Any, ...] = ()
        if claim_id:
            claim_guard = (
                ' AND "contentReviewStatus" = \'reviewing\' '
                'AND "contentReviewClaimId" = %s::uuid'
            )
            claim_params = (claim_id,)
        cursor = await conn.execute(
            'UPDATE "summaries" SET '
            '"readerQualityStatus" = %s, '
            '"readerQualityDetails" = %s::jsonb, '
            '"readerQualityCheckedAt" = now(), '
            '"tags" = CASE WHEN %s = \'ready\' '
            'THEN array_remove("tags", \'content_pending\') '
            'ELSE CASE WHEN COALESCE("tags", ARRAY[]::text[]) '
            '@> ARRAY[\'content_pending\']::text[] THEN "tags" '
            'ELSE array_append(COALESCE("tags", ARRAY[]::text[]), \'content_pending\') END END, '
            '"updatedAt" = now() WHERE "id" = %s '
            f'AND {snapshot_guard}'
            f'{claim_guard}',
            (
                quality.status,
                json.dumps(quality.to_dict(), ensure_ascii=False),
                quality.status,
                summary_id,
                *snapshot_params,
                *claim_params,
            ),
        )
        if getattr(cursor, "rowcount", 1) == 0:
            raise ReaderQualityConflict(
                f"summary {summary_id} changed before reader quality persisted",
            )
    return quality


__all__ = [
    "MIN_READER_CONTENT_CHARS",
    "READER_QUALITY_VERSION",
    "ReaderQualityConflict",
    "ReaderQuality",
    "evaluate_reader_quality",
    "load_and_persist_reader_quality",
]
