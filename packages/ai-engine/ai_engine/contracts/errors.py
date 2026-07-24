"""Error codes mirror.

Single source of truth: `docs/contracts/error-codes.md` and
`packages/shared/src/errors.ts`.

This module exposes:
* `ERROR_CODES` — string literal set (must match TS one-for-one).
* `ErrorCode` — typed enum-style alias.
* `HTTP_STATUS` — HTTP status mapping (Python side does not return HTTP to
  clients, but the BFF does; we expose it so the engine can emit a `code +
  http_status` pair when proxying errors back through `/api/ai/*`).
* `AdapterError` — base exception carrying `code` and a redacted `message`.

The mirror intentionally uses string literals (not Python `enum.Enum`) so that
JSON serialization and logs round-trip identical values.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

# Order must match docs/contracts/error-codes.md sections.
ERROR_CODES: Final[dict[str, str]] = {
    # Auth / 权限
    "AUTH_NOT_AUTHENTICATED": "AUTH_NOT_AUTHENTICATED",
    "AUTH_DOMAIN_NOT_ALLOWED": "AUTH_DOMAIN_NOT_ALLOWED",
    "AUTH_ACCOUNT_DISABLED": "AUTH_ACCOUNT_DISABLED",
    "PERMISSION_DENIED": "PERMISSION_DENIED",
    # 草稿 / 发布
    "DRAFT_NOT_FOUND": "DRAFT_NOT_FOUND",
    "DRAFT_NOT_OWNER": "DRAFT_NOT_OWNER",
    "DRAFT_ALREADY_PUBLISHED": "DRAFT_ALREADY_PUBLISHED",
    # AI 调研
    "AI_ENGINE_UNAVAILABLE": "AI_ENGINE_UNAVAILABLE",
    "AI_QUOTA_EXCEEDED": "AI_QUOTA_EXCEEDED",
    "AI_INVALID_SOURCE_POLICY": "AI_INVALID_SOURCE_POLICY",
    "AI_SOURCE_NOT_VISIBLE": "AI_SOURCE_NOT_VISIBLE",
    "AI_IDEMPOTENCY_MISMATCH": "AI_IDEMPOTENCY_MISMATCH",
    "AI_JOB_NOT_FOUND": "AI_JOB_NOT_FOUND",
    "AI_JOB_NOT_CANCELLABLE": "AI_JOB_NOT_CANCELLABLE",
    # Week 6 AI 多轮追问
    "AI_CHAT_SESSION_NOT_FOUND": "AI_CHAT_SESSION_NOT_FOUND",
    "AI_CHAT_CONTENT_TOO_LONG": "AI_CHAT_CONTENT_TOO_LONG",
    "AI_CHAT_SESSION_CLOSED": "AI_CHAT_SESSION_CLOSED",
    "AI_CHAT_SEED_NOT_FOUND": "AI_CHAT_SEED_NOT_FOUND",
    "AI_CHAT_FORBIDDEN_SEED": "AI_CHAT_FORBIDDEN_SEED",
    # 文件导入 / URL 抓取
    "IMPORT_FILE_TOO_LARGE": "IMPORT_FILE_TOO_LARGE",
    "IMPORT_INVALID_MIME": "IMPORT_INVALID_MIME",
    "IMPORT_NOT_UTF8": "IMPORT_NOT_UTF8",
    "IMPORT_HTML_UNSAFE": "IMPORT_HTML_UNSAFE",
    "IMPORT_HASH_DUPLICATE": "IMPORT_HASH_DUPLICATE",
    "URL_FETCH_BLOCKED": "URL_FETCH_BLOCKED",
    "URL_FETCH_TIMEOUT": "URL_FETCH_TIMEOUT",
    "URL_FETCH_TOO_LARGE": "URL_FETCH_TOO_LARGE",
    "URL_REDIRECT_LIMIT": "URL_REDIRECT_LIMIT",
    # 评论 / 提名
    "COMMENT_TARGET_INVALID": "COMMENT_TARGET_INVALID",
    "COMMENT_SELF_STAR_FORBIDDEN": "COMMENT_SELF_STAR_FORBIDDEN",
    "COMMENT_ALREADY_NOMINATED": "COMMENT_ALREADY_NOMINATED",
    # Admin
    "ADMIN_QUEUE_EMPTY": "ADMIN_QUEUE_EMPTY",
    "ADMIN_NOT_ENOUGH_ADMINS": "ADMIN_NOT_ENOUGH_ADMINS",
    "ADMIN_ACTION_REQUIRES_CONFIRM": "ADMIN_ACTION_REQUIRES_CONFIRM",
    # Worker
    "WORKER_LEASE_LOST": "WORKER_LEASE_LOST",
    "WORKER_TIMEOUT": "WORKER_TIMEOUT",
    "WORKER_RETRY_EXHAUSTED": "WORKER_RETRY_EXHAUSTED",
    # AI 追问 (W6)
    "AI_CHAT_SEED_NOT_FOUND": "AI_CHAT_SEED_NOT_FOUND",
    "AI_CHAT_FORBIDDEN_SEED": "AI_CHAT_FORBIDDEN_SEED",
    "AI_CHAT_SESSION_NOT_FOUND": "AI_CHAT_SESSION_NOT_FOUND",
    "AI_CHAT_SESSION_CLOSED": "AI_CHAT_SESSION_CLOSED",
    "AI_CHAT_CONTENT_TOO_LONG": "AI_CHAT_CONTENT_TOO_LONG",
    # 通用
    "VALIDATION_FAILED": "VALIDATION_FAILED",
    "INTERNAL": "INTERNAL",
    "NOT_IMPLEMENTED": "NOT_IMPLEMENTED",
}

ErrorCode = str  # value is one of ERROR_CODES keys

# HTTP status mapping used when the ai-engine proxies an error up to the BFF.
HTTP_STATUS: Final[dict[str, int]] = {
    "AUTH_NOT_AUTHENTICATED": 401,
    "AUTH_DOMAIN_NOT_ALLOWED": 403,
    "AUTH_ACCOUNT_DISABLED": 403,
    "PERMISSION_DENIED": 403,
    "DRAFT_NOT_FOUND": 404,
    "DRAFT_NOT_OWNER": 403,
    "DRAFT_ALREADY_PUBLISHED": 409,
    "AI_ENGINE_UNAVAILABLE": 503,
    "AI_QUOTA_EXCEEDED": 429,
    "AI_INVALID_SOURCE_POLICY": 400,
    "AI_SOURCE_NOT_VISIBLE": 403,
    "AI_IDEMPOTENCY_MISMATCH": 409,
    "AI_JOB_NOT_FOUND": 404,
    "AI_JOB_NOT_CANCELLABLE": 409,
    # Week 6 AI 多轮追问
    "AI_CHAT_SESSION_NOT_FOUND": 404,
    "AI_CHAT_CONTENT_TOO_LONG": 400,
    "AI_CHAT_SESSION_CLOSED": 403,
    "AI_CHAT_SEED_NOT_FOUND": 404,
    "AI_CHAT_FORBIDDEN_SEED": 403,
    "IMPORT_FILE_TOO_LARGE": 413,
    "IMPORT_INVALID_MIME": 415,
    "IMPORT_NOT_UTF8": 422,
    "IMPORT_HTML_UNSAFE": 422,
    "IMPORT_HASH_DUPLICATE": 409,
    "URL_FETCH_BLOCKED": 400,
    "URL_FETCH_TIMEOUT": 504,
    "URL_FETCH_TOO_LARGE": 413,
    "URL_REDIRECT_LIMIT": 502,
    "COMMENT_TARGET_INVALID": 422,
    "COMMENT_SELF_STAR_FORBIDDEN": 422,
    "COMMENT_ALREADY_NOMINATED": 409,
    "ADMIN_QUEUE_EMPTY": 404,
    "ADMIN_NOT_ENOUGH_ADMINS": 422,
    "ADMIN_ACTION_REQUIRES_CONFIRM": 412,
    "WORKER_LEASE_LOST": 410,
    "WORKER_TIMEOUT": 504,
    "WORKER_RETRY_EXHAUSTED": 503,
    "AI_CHAT_SEED_NOT_FOUND": 404,
    "AI_CHAT_FORBIDDEN_SEED": 403,
    "AI_CHAT_SESSION_NOT_FOUND": 404,
    "AI_CHAT_SESSION_CLOSED": 403,
    "AI_CHAT_CONTENT_TOO_LONG": 400,
    "VALIDATION_FAILED": 400,
    "INTERNAL": 500,
    "NOT_IMPLEMENTED": 501,
}

# Default 500 fallback for unknown codes (kept separate so logs can flag it).
INTERNAL_FALLBACK_HTTP: Final[int] = 500


@dataclass(slots=True)
class AdapterError(Exception):
    """Adapter-level error carrying a stable business code.

    `message` MUST be redacted — never include prompts, body, tokens, keys.
    """

    code: ErrorCode
    message: str
    request_id: str | None = None
    details: dict[str, object] | None = None

    def __post_init__(self) -> None:
        if self.code not in ERROR_CODES:
            # Treat unknown codes as INTERNAL so logs flag the drift.
            self.code = "INTERNAL"
        # NOTE: dataclass(slots=True) + Exception disallows calling
        # super().__init__() inside __post_init__ (the slot wrapper raises
        # "obj must be an instance or subtype of type"). Exception state is
        # set explicitly via .args for pickling/log compatibility.

    @property
    def http_status(self) -> int:
        return HTTP_STATUS.get(self.code, INTERNAL_FALLBACK_HTTP)