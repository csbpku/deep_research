"""AI chat (drawer) endpoints — Week 6.

Implements POST /api/chat/sessions, GET /api/chat/sessions/{id},
POST /api/chat/sessions/{id}/messages. Session + messages are persisted
in `ai_chat_sessions` and `ai_chat_messages` (see Prisma migration
20260724000000_w6_chat_schema).

The article chat path uses a large provider-safe context so the reader can
ask about the captured source without silently losing earlier turns. The
shared research/report prompt has its own configurable transport budget.

The session creation also persists a snapshot of the seed summary so
later edits to the underlying summary don't mutate the chat history.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid
from typing import Annotated, Any, AsyncIterator, cast

import structlog
import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ai_engine.adapters.base import ResearchEngineAdapter, ResearchRequest
from ai_engine.contracts.errors import ERROR_CODES, HTTP_STATUS, AdapterError
from ai_engine.contracts.states import (
    AI_CHAT_ROLE,
    AI_CHAT_SESSION_STATUS,
    AiChatRole,
    AiChatSessionStatus,
)
from ai_engine.llm.usage_audit import LlmUsageAttempt, record_llm_usage

router = APIRouter(prefix="/api/chat", tags=["chat"])

logger = structlog.get_logger("ai_engine.chat")

# Snapshot body truncation. Real summaries can be huge; we cap the snapshot
# so chat prompts never grow beyond a provider-safe payload.
_SNAPSHOT_BODY_MAX = int(os.environ.get("RADAR_CHAT_SNAPSHOT_MAX_CHARS", "256000"))
# Zread's bounded cache can contain a whole generated wiki. Repo discussion
# gets a larger prompt budget so it can actually use that cache rather than
# silently seeing only the first few paragraphs.
_ZREAD_CONTEXT_MAX = int(os.environ.get("RADAR_CHAT_ZREAD_MAX_CHARS", "256000"))
# Chat is an article-reading surface, so use the full bounded snapshot for
# every source type. This is still an operational ceiling for provider
# context windows, not a content truncation policy for ordinary articles.
_CHAT_INPUT_TOKENS = int(os.environ.get("RADAR_CHAT_INPUT_TOKENS", "60000"))


def _anythingllm_chat_enabled(snapshot: dict[str, Any]) -> bool:
    """Enable AnythingLLM when configured, with an optional radar allowlist."""
    base_url = os.environ.get("ANYTHINGLLM_URL", "").strip()
    api_key = os.environ.get("ANYTHINGLLM_API_KEY", "").strip()
    workspace = os.environ.get("ANYTHINGLLM_WORKSPACE", "").strip()
    if not base_url or not api_key or not workspace:
        return False
    if os.environ.get("ANYTHINGLLM_ENABLED", "true").strip().lower() in {"0", "false", "no"}:
        return False
    configured = {
        item.strip()
        for item in os.environ.get("ANYTHINGLLM_RADAR_IDS", "").split(",")
        if item.strip()
    }
    return not configured or str(snapshot.get("id") or "") in configured


def _clean_model_text(value: Any) -> str:
    """Remove DeepSeek reasoning blocks before showing an answer to readers."""
    text = str(value or "").strip()
    text = re.sub(
        r"<think[^>]*>.*?</think[^>]*>",
        "",
        text,
        flags=re.DOTALL | re.IGNORECASE,
    )
    return re.sub(
        r"<think[^>]*>[\s\S]*$",
        "",
        text,
        flags=re.IGNORECASE,
    ).strip()


def _anythingllm_sources(payload: dict[str, Any]) -> list[dict[str, str]]:
    """Normalize AnythingLLM source metadata to the existing chat contract."""
    raw = payload.get("sources")
    if not isinstance(raw, list):
        return []
    result: list[dict[str, str]] = []
    for source in raw:
        if not isinstance(source, dict):
            continue
        quote = source.get("text") or source.get("content") or source.get("quote")
        if quote:
            result.append({"quote": str(quote)[:12000]})
    return result


def _anythingllm_usage(payload: dict[str, Any]) -> tuple[int | None, int | None, str | None]:
    """Extract usage across AnythingLLM response versions when available."""
    usage = payload.get("usage") or payload.get("metrics") or payload.get("tokenUsage")
    if not isinstance(usage, dict):
        usage = payload

    def pick(*names: str) -> int | None:
        for name in names:
            value = usage.get(name)
            if isinstance(value, (int, float)) and value >= 0:
                return int(value)
        return None

    return (
        pick("prompt_tokens", "input_tokens", "promptTokens", "inputTokens"),
        pick("completion_tokens", "output_tokens", "completionTokens", "outputTokens"),
        str(
            payload.get("model")
            or payload.get("modelName")
            or (usage.get("model") if isinstance(usage, dict) else "")
            or ""
        )
        or None,
    )


async def _anythingllm_chat(
    snapshot: dict[str, Any],
    prompt: str,
    *,
    session_id: str,
) -> tuple[str, list[dict[str, str]], int | None, int | None, str | None]:
    """Ask the configured AnythingLLM workspace and return text + sources.

    This is deliberately a small adapter boundary. The rest of the chat
    persistence and citation protocol remains unchanged, which makes the
    experiment reversible and keeps non-graylisted radars untouched.
    """
    base_url = os.environ.get("ANYTHINGLLM_URL", "").strip().rstrip("/")
    api_key = os.environ.get("ANYTHINGLLM_API_KEY", "").strip()
    workspace = os.environ.get("ANYTHINGLLM_WORKSPACE", "").strip()
    if not base_url or not api_key or not workspace:
        raise RuntimeError("AnythingLLM 未配置完整")
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "message": prompt,
        "mode": "chat",
        "sessionId": f"radar-{snapshot.get('id')}-{session_id}",
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            f"{base_url}/api/v1/workspace/{workspace}/chat",
            headers=headers,
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
    if not isinstance(data, dict):
        raise ValueError("AnythingLLM 返回格式无效")
    text = _clean_model_text(
        data.get("textResponse")
        or data.get("text")
        or data.get("response")
        or data.get("message")
    )
    if not text:
        raise ValueError("AnythingLLM 返回空回答")
    input_tokens, output_tokens, actual_model = _anythingllm_usage(data)
    return text, _anythingllm_sources(data), input_tokens, output_tokens, actual_model


# ──────────────────────────────────────────────────────────────────────
# Request/response models
# ──────────────────────────────────────────────────────────────────────


class CreateChatSessionBody(BaseModel):
    user_id: str
    seed_summary_id: str


class ChatSeedSnapshot(BaseModel):
    id: str
    title: str
    url: str
    body: str
    interpretation: str | None
    summary_date: str
    tags: list[str]
    authors: list[str] = Field(default_factory=list)
    # Phase 1 deep-dive: full original source captured by radar sync
    # (see packages/ai-engine/ai_engine/radar/sync_runner.py). Optional
    # because pre-Phase-0 rows won't have it; chat behaves as before when null.
    original_markdown: str | None = None
    original_kind: str | None = None
    # GitHub Repo reading mode: the generated Zread pages are the primary
    # context, while original_markdown remains the fallback for older rows.
    reading_context: str | None = None


class CreateChatSessionResponse(BaseModel):
    session_id: str
    status: AiChatSessionStatus
    created_at: str
    seed_snapshot: ChatSeedSnapshot
    message_count: int = 0


class ChatMessageOut(BaseModel):
    id: str
    role: AiChatRole
    content: str
    sources_json: list[dict[str, str]] | None = None
    latency_ms: int | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None
    cost_cents: int | None = None
    created_at: str


class GetSessionResponse(BaseModel):
    session_id: str
    user_id: str
    status: AiChatSessionStatus
    created_at: str
    updated_at: str
    seed_snapshot: ChatSeedSnapshot
    messages: list[ChatMessageOut]


class AppendMessageBody(BaseModel):
    user_id: str
    role: AiChatRole = Field(default="user")
    # Transport-safety ceiling; the article context is not constrained here.
    content: str = Field(min_length=1, max_length=32000)
    # Phase 3.b: optional text-selection anchor.
    # When present, the selected quote is prepended to the user message
    # so the assistant can ground its answer in the exact passage.
    anchor: dict[str, Any] | None = None


# ──────────────────────────────────────────────────────────────────────
# Dependencies
# ──────────────────────────────────────────────────────────────────────


def _pool(request: Request) -> Any:
    pool = getattr(request.app.state, "db_pool", None)
    if pool is None:
        raise HTTPException(status_code=503, detail={"code": "AI_ENGINE_UNAVAILABLE"})
    return pool


def _adapter(request: Request) -> ResearchEngineAdapter:
    adapter = getattr(request.app.state, "adapter", None)
    if adapter is None:
        from ai_engine.adapters.base import build_adapter

        adapter = build_adapter()
    return adapter


# ──────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────


def _http_error(code: str, message: str, details: dict[str, Any] | None = None) -> HTTPException:
    if code not in ERROR_CODES:
        code = "INTERNAL"
    body: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        body["details"] = details
    return HTTPException(status_code=HTTP_STATUS.get(code, 500), detail=body)


def _estimate_tokens(text: str) -> int:
    """~4 chars/token heuristic. Conservative for mixed CN/EN."""
    return max(1, len(text) // 4)


def _truncate_to_tokens(text: str, max_tokens: int) -> str:
    if _estimate_tokens(text) <= max_tokens:
        return text
    max_chars = max_tokens * 4
    return text[:max_chars]


async def _load_summary(pool: Any, summary_id: str) -> dict[str, Any] | None:
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT "id", "title", "url", "body", "interpretation", '
                '"summaryDate", "tags", "originalMarkdown", "originalKind", "originalMeta", "authors" '
                'FROM "summaries" WHERE "id" = %s',
                (summary_id,),
            )
        ).fetchone()
    return dict(row) if row else None


def _zread_context(meta: Any) -> str | None:
    """Flatten cached Zread pages into grounded chat context.

    The JSON is intentionally treated as untrusted content. We preserve the
    page boundaries so citations can still be matched against the document,
    and cap the snapshot to the same budget used by the legacy source text.
    """
    if not isinstance(meta, dict):
        return None
    zread = meta.get("zread")
    if not isinstance(zread, dict):
        return None
    pages = zread.get("pages")
    if not isinstance(pages, list):
        return None
    chunks: list[str] = []
    for index, page in enumerate(pages):
        if not isinstance(page, dict):
            continue
        content = str(page.get("content") or "").strip()
        if not content:
            continue
        title = str(page.get("title") or page.get("path") or f"Zread page {index + 1}").strip()
        path = str(page.get("path") or title).strip()
        chunks.append(f"<!-- zread-path: {path} -->\n## {title}\n\n{content}")
    if not chunks:
        return None
    return "\n\n---\n\n".join(chunks)[:_ZREAD_CONTEXT_MAX]


async def _count_messages(pool: Any, session_id: str) -> int:
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                'SELECT count(*) AS cnt FROM "ai_chat_messages" WHERE "sessionId" = %s',
                (session_id,),
            )
        ).fetchone()
    return int(row["cnt"]) if row else 0


async def _count_user_messages_today(pool: Any, user_id: str) -> int:
    async with pool.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT count(*) AS cnt FROM \"ai_chat_messages\" m "
                "JOIN \"ai_chat_sessions\" s ON s.\"id\" = m.\"sessionId\" "
                "WHERE s.\"userId\" = %s AND m.\"role\" = 'user' "
                "AND m.\"createdAt\" >= date_trunc('day', now())",
                (user_id,),
            )
        ).fetchone()
    return int(row["cnt"]) if row else 0


async def _build_prompt(
    pool: Any,
    snapshot: dict[str, Any],
    history: list[dict[str, Any]],
    user_msg: dict[str, Any],
    adapter: ResearchEngineAdapter,
    context_scope: str | None = None,
    context_text: str | None = None,
) -> tuple[str, int]:
    """Assemble the assistant prompt with a larger budget for Zread repos.

    W7 (工程师 B): delegates the budget + untrusted-input boundary to
    ``prompt.build_chat_prompt`` so the chat path and the long-research
    path share one source of truth. The LLM-based "earlier turns"
    compression (W6 §6.1) is still applied BEFORE the shared builder
    so ordinary prompts and cached repo documents use the same bounded
    article-reading budget defined above.

    Returns (prompt, estimated_tokens).
    """
    from ai_engine.prompt import build_chat_prompt

    seed_body = (snapshot.get("body") or "")[:_SNAPSHOT_BODY_MAX]
    seed_interp = (snapshot.get("interpretation") or "")[:8000]

    # Keep prior turns verbatim. The shared prompt builder still enforces the
    # provider-safe total budget, but automatic fourth-turn compression used
    # to erase details the reader had explicitly asked about.

    base_original = snapshot.get("reading_context") or snapshot.get("original_markdown")
    scoped_original = str(base_original) if base_original else None
    include_original = True
    if context_scope in {"selection", "paragraph", "section"} and context_text:
        scoped_original = context_text[:256000]
    elif context_scope == "project":
        scoped_original = str(snapshot.get("reading_context") or base_original) if (snapshot.get("reading_context") or base_original) else None
    built = build_chat_prompt(
        snapshot_body=seed_body,
        snapshot_interpretation=seed_interp,
        history=history,
        user_msg=user_msg["content"],
        original_markdown=scoped_original,
        original_kind=snapshot.get("original_kind"),
        authors=list(snapshot.get("authors") or []),
        # include_original defaults True; the UI toggle will plumb a
        # session-level flag in Phase 1.4 (left as future work — current
        # default behaviour is to use the original when available).
        include_original=include_original,
        max_input_tokens=_CHAT_INPUT_TOKENS,
    )
    # M7: 引用锚点 —— 让模型在直接引用原文时用 [[cite]]...[[/cite]] 包裹，
    # 前端解析后回链到左栏原文（fuzzy match）。不改变预算，只追加一句指令。
    citation_hint = (
        "\n\n引用纪律：当你直接引用原文中的句子来支撑回答时，用 [[cite]] 原文句子 [[/cite]] 包裹，"
        "引文必须逐字复制原文。不要滥用引文，只在需要锚定证据时使用。"
    )
    return built.system + citation_hint + "\n\n" + built.user, built.estimated_tokens


# ──────────────────────────────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────────────────────────────


@router.post(
    "/sessions",
    response_model=CreateChatSessionResponse,
    status_code=200,
)
async def create_session(
    body: CreateChatSessionBody,
    request: Request,
    pool: Annotated[Any, Depends(_pool)],
) -> CreateChatSessionResponse:
    request_id = getattr(request.state, "request_id", "")
    summary = await _load_summary(pool, body.seed_summary_id)
    if summary is None:
        raise _http_error("AI_CHAT_SEED_NOT_FOUND", "种子摘要不存在")

    # A radar discussion is one conversation per user and seed. Re-opening
    # the drawer must restore the existing transcript instead of creating an
    # unreachable duplicate session every time.
    async with pool.connection() as conn:
        existing = await (
            await conn.execute(
                'SELECT "id", "createdAt" FROM "ai_chat_sessions" '
                'WHERE "userId" = %s AND "seedSummaryId" = %s AND "status" = \'active\' '
                'ORDER BY "updatedAt" DESC LIMIT 1',
                (body.user_id, body.seed_summary_id),
            )
        ).fetchone()
    if existing is not None:
        logger.info(
            "ai-engine.chat.session_reused",
            request_id=request_id,
            user_id=body.user_id,
            session_id=str(existing["id"]),
        )
        return CreateChatSessionResponse(
            session_id=str(existing["id"]),
            status=cast(AiChatSessionStatus, AI_CHAT_SESSION_STATUS["ACTIVE"]),
            created_at=existing["createdAt"].isoformat(),
            seed_snapshot=ChatSeedSnapshot.model_validate(
                (await get_session(request, pool, str(existing["id"]))).seed_snapshot
            ),
            message_count=await _count_messages(pool, str(existing["id"])),
        )

    snapshot: dict[str, object] = {
        "id": str(summary["id"]),
        "title": summary["title"] or "",
        "url": summary["url"] or "",
        "body": (summary["body"] or "")[:_SNAPSHOT_BODY_MAX],
        "interpretation": summary.get("interpretation"),
        "summary_date": summary["summaryDate"].isoformat()[:10]
        if summary.get("summaryDate") else "",
        "tags": list(summary.get("tags") or []),
        "authors": [str(author) for author in (summary.get("authors") or []) if str(author).strip()],
        # Phase 1 deep-dive fields — may be None for rows ingested
        # before Phase 0 sync ran.
        "original_markdown": (summary.get("originalMarkdown") or "")[:_SNAPSHOT_BODY_MAX]
        if summary.get("originalMarkdown") else None,
        "original_kind": summary.get("originalKind"),
        "reading_context": _zread_context(summary.get("originalMeta")),
        "repo_commit": (
            str(summary.get("originalMeta", {}).get("zread", {}).get("commitSha"))
            if isinstance(summary.get("originalMeta"), dict)
            and isinstance(summary.get("originalMeta", {}).get("zread"), dict)
            and summary.get("originalMeta", {}).get("zread", {}).get("commitSha")
            else None
        ),
    }

    try:
        async with pool.connection() as conn:
            async with conn.transaction():
                row = await (
                    await conn.execute(
                        'INSERT INTO "ai_chat_sessions" '
                        '("id", "userId", "seedSummaryId", "seedSnapshot", "status", '
                        '"createdAt", "updatedAt") '
                        "VALUES (gen_random_uuid(), %s, %s, %s::jsonb, 'active', now(), now()) "
                        'RETURNING "id", "createdAt"',
                        (body.user_id, body.seed_summary_id, json.dumps(snapshot)),
                    )
                ).fetchone()
    except Exception as exc:
        # 用户 id 不存在（如 E2E 直连 ai-engine 用了假的 requester_id）时
        # 返回 404 而不是 500，避免 BFF 侧显示“ai-engine 不可达”。
        code = getattr(exc, 'sqlstate', '')
        if code == '23503':
            raise _http_error("AI_CHAT_SEED_NOT_FOUND", "用户不存在")
        raise

    logger.info(
        "ai-engine.chat.session_created",
        request_id=request_id,
        user_id=body.user_id,
        session_id=str(row["id"]),
    )
    return CreateChatSessionResponse(
        session_id=str(row["id"]),
        status=cast(AiChatSessionStatus, AI_CHAT_SESSION_STATUS["ACTIVE"]),
        created_at=row["createdAt"].isoformat(),
        seed_snapshot=ChatSeedSnapshot.model_validate(snapshot),
        message_count=0,
    )


@router.get(
    "/sessions/{session_id}",
    response_model=GetSessionResponse,
)
async def get_session(
    request: Request,
    pool: Annotated[Any, Depends(_pool)],
    session_id: Annotated[str, Path(min_length=1)],
) -> GetSessionResponse:
    async with pool.connection() as conn:
        s_row = await (
            await conn.execute(
                'SELECT "id", "userId", "status", "createdAt", "updatedAt", '
                '"seedSnapshot" FROM "ai_chat_sessions" WHERE "id" = %s',
                (session_id,),
            )
        ).fetchone()
    if s_row is None:
        raise _http_error("AI_CHAT_SESSION_NOT_FOUND", "会话不存在")
    s = dict(s_row)
    snapshot = s["seedSnapshot"] if isinstance(s["seedSnapshot"], dict) else json.loads(s["seedSnapshot"])
    async with pool.connection() as conn:
        msg_rows = await (
            await conn.execute(
                'SELECT "id", "role", "content", "sourcesJson", "latencyMs", '
                '"tokensIn", "tokensOut", "costCents", "createdAt" '
                'FROM "ai_chat_messages" WHERE "sessionId" = %s ORDER BY "createdAt" ASC',
                (session_id,),
            )
        ).fetchall()

    messages = []
    for r in msg_rows:
        m = dict(r)
        sources = m.get("sourcesJson")
        messages.append(
            ChatMessageOut(
                id=str(m["id"]),
                role=cast(AiChatRole, m["role"]),
                content=m["content"],
                sources_json=list(sources) if isinstance(sources, list) else None,
                latency_ms=m.get("latencyMs"),
                tokens_in=m.get("tokensIn"),
                tokens_out=m.get("tokensOut"),
                cost_cents=m.get("costCents"),
                created_at=m["createdAt"].isoformat(),
            )
        )

    return GetSessionResponse(
        session_id=str(s["id"]),
        user_id=str(s["userId"]),
        status=cast(AiChatSessionStatus, s["status"]),
        created_at=s["createdAt"].isoformat(),
        updated_at=s["updatedAt"].isoformat(),
        seed_snapshot=ChatSeedSnapshot.model_validate(snapshot),
        messages=messages,
    )


@router.post(
    "/sessions/{session_id}/messages",
    response_model=ChatMessageOut,
    status_code=200,
)
async def append_message(
    body: AppendMessageBody,
    request: Request,
    pool: Annotated[Any, Depends(_pool)],
    adapter: Annotated[ResearchEngineAdapter, Depends(_adapter)],
    session_id: Annotated[str, Path(min_length=1)],
) -> ChatMessageOut:
    import time

    request_id = getattr(request.state, "request_id", "")
    if body.role != AI_CHAT_ROLE["USER"]:
        raise _http_error("VALIDATION_FAILED", "只接受 user 角色消息")

    user_quota = int(os.environ.get("BUDGET_USER_DAILY", "5"))
    used = await _count_user_messages_today(pool, body.user_id)
    if used >= user_quota:
        raise _http_error(
            "AI_QUOTA_EXCEEDED",
            "个人今日 AI 追问配额已用完",
            {"scope": "user", "used": used, "limit": user_quota},
        )

    async with pool.connection() as conn:
        s_row = await (
            await conn.execute(
                'SELECT "id", "userId", "status", "seedSnapshot" '
                'FROM "ai_chat_sessions" WHERE "id" = %s',
                (session_id,),
            )
        ).fetchone()
    if s_row is None:
        raise _http_error("AI_CHAT_SESSION_NOT_FOUND", "会话不存在")
    s = dict(s_row)
    if str(s["userId"]) != body.user_id:
        raise _http_error("AI_CHAT_SESSION_NOT_FOUND", "会话不存在")
    if s["status"] != AI_CHAT_SESSION_STATUS["ACTIVE"]:
        raise _http_error("AI_CHAT_SESSION_CLOSED", "会话已关闭,不能再追加")

    snapshot = s["seedSnapshot"] if isinstance(s["seedSnapshot"], dict) else json.loads(s["seedSnapshot"])

    # Insert user message first
    async with pool.connection() as conn:
        async with conn.transaction():
            u_row = await (
                await conn.execute(
                    'INSERT INTO "ai_chat_messages" '
                    '("id", "sessionId", "role", "content", "createdAt") '
                    "VALUES (gen_random_uuid(), %s, 'user', %s, now()) "
                    'RETURNING "id", "createdAt"',
                    (session_id, body.content),
                )
            ).fetchone()
            # Bump session updatedAt
            await conn.execute(
                'UPDATE "ai_chat_sessions" SET "updatedAt" = now() WHERE "id" = %s',
                (session_id,),
            )

    # Load history (excluding the just-inserted user msg, which we'll re-add)
    async with pool.connection() as conn:
        h_rows = await (
            await conn.execute(
                'SELECT "role", "content" FROM "ai_chat_messages" '
                'WHERE "sessionId" = %s AND "id" <> %s ORDER BY "createdAt" ASC',
                (session_id, str(u_row["id"])),
            )
        ).fetchall()
    history = [{"role": r["role"], "content": r["content"]} for r in h_rows]
    user_msg_content = body.content
    # Phase 3.b: prepend anchor quote to user message
    if body.anchor and isinstance(body.anchor, dict) and body.anchor.get("quote"):
        anchor_quote: Any = body.anchor["quote"]
        user_msg_content = (
            f'[引用] "{anchor_quote}"\n\n'
            + user_msg_content
        )
    user_msg: dict[str, str] = {"role": "user", "content": user_msg_content}

    anchor_scope = body.anchor.get("contextScope") if isinstance(body.anchor, dict) else None
    anchor_context = body.anchor.get("contextText") if isinstance(body.anchor, dict) else None
    prompt, tokens_in_est = await _build_prompt(
        pool, snapshot, history, user_msg, adapter,
        context_scope=str(anchor_scope) if anchor_scope else None,
        context_text=str(anchor_context) if anchor_context else None,
    )

    started = time.monotonic()
    brief: Any = None
    anything_sources: list[dict[str, str]] = []
    anything_tokens_in: int | None = None
    anything_tokens_out: int | None = None
    anything_model: str | None = None
    try:
        if _anythingllm_chat_enabled(snapshot):
            try:
                (
                    content,
                    anything_sources,
                    anything_tokens_in,
                    anything_tokens_out,
                    anything_model,
                ) = await _anythingllm_chat(snapshot, prompt, session_id=session_id)
                logger.info("ai-engine.chat.anythingllm", session_id=session_id)
                await record_llm_usage(
                    LlmUsageAttempt(
                        operation="chat.anythingllm",
                        request_id=request_id,
                        provider="anythingllm",
                        requested_model=anything_model or "workspace-default",
                        actual_model=anything_model,
                        input_tokens=anything_tokens_in,
                        output_tokens=anything_tokens_out,
                        latency_ms=int((time.monotonic() - started) * 1000),
                    )
                )
            except Exception as exc:
                logger.warning("ai-engine.chat.anythingllm_fallback", session_id=session_id, error=str(exc))
                content = ""
        else:
            content = ""

        if not content:
            req = ResearchRequest(
                job_id=str(uuid.uuid4()), request_id=f"chat-{session_id}",
                topic=str(snapshot.get("title") or "Chat"), context=prompt,
                report_type="summary_brief", source_policy="prefer_user_sources",
                source_refs=(), timeout_seconds=60,
            )
            await adapter.submit(req)
            deadline = time.monotonic() + 60.0
            while time.monotonic() < deadline:
                await asyncio.sleep(0.1)
                status = await adapter.get_status(req.job_id)
                if status.status in {"succeeded", "failed", "partial", "cancelled"}:
                    brief = status
                    break
            if brief is None:
                raise _http_error("AI_ENGINE_UNAVAILABLE", "adapter 60s 超时")
            if brief.status != "succeeded":
                raise _http_error("AI_ENGINE_UNAVAILABLE", brief.error_message or "AI 暂时没有生成回答，请重试")
            content = _clean_model_text(brief.output_text)
        latency_ms = int((time.monotonic() - started) * 1000)
        if not content:
            raise _http_error("AI_ENGINE_UNAVAILABLE", "AI 没有生成有效回答，请重试")

        cleaned_content, citations = _parse_citations(content, snapshot)
        if anything_sources:
            citations = _enrich_citations(anything_sources, snapshot) + citations
    except AdapterError as exc:
        raise _http_error(exc.code, exc.message)

    # Insert assistant message
    cost_cents = int(getattr(getattr(brief, "cost", None), "cost_cents", 0))
    tokens_out = (
        anything_tokens_out
        if anything_tokens_out is not None
        else int(getattr(getattr(brief, "cost", None), "token_output_total", 0) or 0)
    )
    tokens_in = anything_tokens_in if anything_tokens_in is not None else tokens_in_est
    sources_json_str = json.dumps(citations) if citations else None
    async with pool.connection() as conn:
        async with conn.transaction():
            a_row = await (
                await conn.execute(
                    'INSERT INTO "ai_chat_messages" '
                    '("id", "sessionId", "role", "content", "sourcesJson", '
                    '"latencyMs", "tokensIn", "tokensOut", "costCents", "createdAt") '
                    "VALUES (gen_random_uuid(), %s, 'assistant', %s, %s::jsonb, %s, %s, %s, %s, now()) "
                    'RETURNING "id", "createdAt"',
                    (
                        session_id,
                        cleaned_content[:100000],
                        sources_json_str,
                        latency_ms,
                        tokens_in,
                        tokens_out,
                        cost_cents,
                    ),
                )
            ).fetchone()
            await conn.execute(
                'UPDATE "ai_chat_sessions" SET "updatedAt" = now() WHERE "id" = %s',
                (session_id,),
            )

    logger.info(
        "ai-engine.chat.message_appended",
        request_id=request_id,
        session_id=session_id,
        role="assistant",
        tokens_in=tokens_in,
        cost_cents=cost_cents,
        citations=len(citations),
    )
    return ChatMessageOut(
        id=str(a_row["id"]),
        role=cast(AiChatRole, AI_CHAT_ROLE["ASSISTANT"]),
        content=cleaned_content,
        sources_json=citations,
        latency_ms=latency_ms,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cost_cents=cost_cents,
        created_at=a_row["createdAt"].isoformat(),
    )


# ──────────────────────────────────────────────────────────────────────
# M7 SSE streaming variant
# ──────────────────────────────────────────────────────────────────────


def _sse_frame(event: str, data: str) -> bytes:
    """Encode a single SSE frame with one ``event:`` and ``data:`` line."""
    return f"event: {event}\ndata: {data}\n\n".encode("utf-8")


def _citation_location(quote: str, snapshot: dict[str, Any] | None) -> dict[str, str]:
    if not snapshot:
        return {}
    source = str(
        snapshot.get("reading_context")
        or snapshot.get("original_markdown")
        or snapshot.get("body")
        or ""
    )
    normalized_quote = re.sub(r"\s+", " ", quote).strip().lower()
    if len(normalized_quote) < 18:
        return {}
    current_heading: str | None = None
    current_path: str | None = None
    current_page_line = 1
    for index, block in enumerate(re.split(r"\n{2,}", source)):
        path_match = re.search(r"<!--\s*zread-path:\s*(.+?)\s*-->", block)
        if path_match:
            current_path = path_match.group(1).strip()
            current_page_line = 1
        heading_match = re.search(r"(?m)^\s*#{1,6}\s+(.+?)\s*$", block)
        if heading_match:
            current_heading = heading_match.group(1).strip().strip("#").strip()
        normalized_block = re.sub(r"\s+", " ", block).strip().lower()
        if normalized_quote not in normalized_block:
            if current_path and not path_match:
                current_page_line += block.count("\n") + 2
            continue
        location = f"正文第 {index + 1} 段"
        if current_path:
            location = f"{current_path} · {location}"
        if current_heading:
            location = f"{current_heading} · {location}"
        result = {"sourceBlockIndex": str(index), "location": location}
        quote_offset = block.lower().find(quote.lower())
        if current_path and quote_offset >= 0:
            line_number = current_page_line + block[:quote_offset].count("\n")
            result["lineNumber"] = str(line_number)
            result["location"] = f"{current_path} · L{line_number}"
            repo_url = str(snapshot.get("url") or "").rstrip("/")
            repo_commit = str(snapshot.get("repo_commit") or "").strip()
            if repo_url.startswith("https://github.com/") and repo_commit:
                result["sourceUrl"] = f"{repo_url}/blob/{repo_commit}/{current_path}#L{line_number}"
        equation_match = re.search(r"\\tag\{(\d+)\}|(?:^|\s)\((\d+)\)\s*$", block)
        figure_match = re.search(r"(?i)\b(?:figure|fig\.)\s*(\d+)\b", block)
        if equation_match:
            equation_number = equation_match.group(1) or equation_match.group(2)
            result["anchorId"] = f"radar-equation-{equation_number}"
            result["location"] = f"{location} · 公式 ({equation_number})"
        elif figure_match:
            figure_number = figure_match.group(1)
            result["anchorId"] = f"radar-figure-{figure_number}"
            result["location"] = f"{location} · 图 {figure_number}"
        if current_path:
            result["sourcePath"] = current_path
        return result
    return {}


def _enrich_citations(
    citations: list[dict[str, str]],
    snapshot: dict[str, Any] | None,
) -> list[dict[str, str]]:
    enriched: list[dict[str, str]] = []
    for citation in citations:
        quote = citation.get("quote", "")
        item = dict(citation)
        for key, value in _citation_location(quote, snapshot).items():
            item.setdefault(key, value)
        enriched.append(item)
    return enriched


def _parse_citations(
    content: str,
    snapshot: dict[str, Any] | None = None,
) -> tuple[str, list[dict[str, str]]]:
    """Extract ``[[cite]]...[[/cite]]`` quotes from a complete assistant body.

    Returns ``(cleaned_content, citations)``. Markers are stripped from the
    cleaned content unconditionally — balanced or not — so raw ``[[cite]]``
    syntax never leaks to the client; the quoted text itself stays inline.

    The model does not always balance its markers. Captures that contain
    nested ``[[cite]]`` / ``[[/cite]]`` or span multiple paragraphs are the
    model emitting a malformed span, so they are skipped rather than surfaced
    as a garbage citation.
    """
    cite_re = re.compile(r"\[\[cite\]\](.*?)\[\[/cite\]\]", re.DOTALL)
    citations: list[dict[str, str]] = []
    for match in cite_re.finditer(content):
        quote = match.group(1).strip()
        if not quote:
            continue
        # Malformed spans: nested markers or multi-paragraph blobs are not
        # verifiable quotes — skip them instead of capturing a huge span.
        if "[[cite" in quote or "[[/cite" in quote:
            continue
        if "\n\n" in quote:
            continue
        citation = {"quote": quote[:2000]}
        citation.update(_citation_location(quote, snapshot))
        citations.append(citation)

    # Strip every marker (balanced or not) so raw syntax never leaks.
    cleaned = re.sub(r"\[\[cite\]\]", "", content)
    cleaned = re.sub(r"\[\[/cite\]\]", "", cleaned)
    cleaned = cleaned.strip()
    return cleaned, citations


async def _collect_adapter_chunks(
    adapter: ResearchEngineAdapter,
    req: ResearchRequest,
) -> list[str]:
    """Buffer adapter output until terminal status, reasoning markup included.

    Both the true-token ``stream_chat`` path and the poll-diff fallback
    return here, so the caller can clean ``<think>`` blocks before any
    text is emitted to the client.
    """
    full_chunks: list[str] = []

    async def q_delta(chunk: str) -> None:
        full_chunks.append(chunk)

    if hasattr(adapter, "stream_chat"):
        await adapter.stream_chat(req, on_delta=q_delta)
    else:
        # Approach A: poll-diff fallback.
        await adapter.submit(req)
        prev_len = 0
        deadline = time.monotonic() + req.timeout_seconds
        while True:
            if time.monotonic() >= deadline:
                raise _http_error("AI_ENGINE_UNAVAILABLE", "adapter 超时")
            status = await adapter.get_status(req.job_id)
            text = status.output_text or ""
            if len(text) > prev_len:
                full_chunks.append(text[prev_len:])
                prev_len = len(text)
            if status.status in {"succeeded", "failed", "partial", "cancelled"}:
                break
            await asyncio.sleep(0.1)
    return full_chunks


@router.post("/sessions/{session_id}/messages/stream")
async def append_message_stream(
    body: AppendMessageBody,
    request: Request,
    pool: Annotated[Any, Depends(_pool)],
    adapter: Annotated[ResearchEngineAdapter, Depends(_adapter)],
    session_id: Annotated[str, Path(min_length=1)],
) -> StreamingResponse:
    """M7 streaming variant of :func:`append_message`.

    Pre-flight (role, ownership, quota, user-message insert, history load,
    prompt build) is the same as the polling endpoint; the only difference
    is that the adapter's progress is exposed as Server-Sent Events instead
    of a single JSON response.

    Event schema:
        event: start      data: {"session_id": "...", "message_id": "..."}
        event: delta      data: "<json-encoded chunk of assistant text>"
        event: citations  data: {"citations": [{"quote": "..."}]}
        event: done       data: {"message_id": "...", "content": "...", ...}
        event: error      data: {"code": "...", "message": "..."}
    """
    request_id = getattr(request.state, "request_id", "")

    # ── Pre-flight: same as the polling route ─────────────────────────
    if body.role != AI_CHAT_ROLE["USER"]:
        raise _http_error("VALIDATION_FAILED", "只接受 user 角色消息")

    user_quota = int(os.environ.get("BUDGET_USER_DAILY", "5"))
    used = await _count_user_messages_today(pool, body.user_id)
    if used >= user_quota:
        raise _http_error(
            "AI_QUOTA_EXCEEDED",
            "个人今日 AI 追问配额已用完",
            {"scope": "user", "used": used, "limit": user_quota},
        )

    async with pool.connection() as conn:
        s_row = await (
            await conn.execute(
                'SELECT "id", "userId", "status", "seedSnapshot" '
                'FROM "ai_chat_sessions" WHERE "id" = %s',
                (session_id,),
            )
        ).fetchone()
    if s_row is None:
        raise _http_error("AI_CHAT_SESSION_NOT_FOUND", "会话不存在")
    s = dict(s_row)
    if str(s["userId"]) != body.user_id:
        raise _http_error("AI_CHAT_SESSION_NOT_FOUND", "会话不存在")
    if s["status"] != AI_CHAT_SESSION_STATUS["ACTIVE"]:
        raise _http_error("AI_CHAT_SESSION_CLOSED", "会话已关闭,不能再追加")

    snapshot = s["seedSnapshot"] if isinstance(s["seedSnapshot"], dict) else json.loads(s["seedSnapshot"])

    async with pool.connection() as conn:
        async with conn.transaction():
            u_row = await (
                await conn.execute(
                    'INSERT INTO "ai_chat_messages" '
                    '("id", "sessionId", "role", "content", "createdAt") '
                    "VALUES (gen_random_uuid(), %s, 'user', %s, now()) "
                    'RETURNING "id", "createdAt"',
                    (session_id, body.content),
                )
            ).fetchone()
            await conn.execute(
                'UPDATE "ai_chat_sessions" SET "updatedAt" = now() WHERE "id" = %s',
                (session_id,),
            )

    async with pool.connection() as conn:
        h_rows = await (
            await conn.execute(
                'SELECT "role", "content" FROM "ai_chat_messages" '
                'WHERE "sessionId" = %s AND "id" <> %s ORDER BY "createdAt" ASC',
                (session_id, str(u_row["id"])),
            )
        ).fetchall()
    history = [{"role": r["role"], "content": r["content"]} for r in h_rows]
    user_msg_content = body.content
    if body.anchor and isinstance(body.anchor, dict) and body.anchor.get("quote"):
        anchor_quote: Any = body.anchor["quote"]
        user_msg_content = (
            f'[引用] "{anchor_quote}"\n\n'
            + user_msg_content
        )
    user_msg: dict[str, str] = {"role": "user", "content": user_msg_content}

    anchor_scope = body.anchor.get("contextScope") if isinstance(body.anchor, dict) else None
    anchor_context = body.anchor.get("contextText") if isinstance(body.anchor, dict) else None
    prompt, tokens_in_est = await _build_prompt(
        pool, snapshot, history, user_msg, adapter,
        context_scope=str(anchor_scope) if anchor_scope else None,
        context_text=str(anchor_context) if anchor_context else None,
    )

    req = ResearchRequest(
        job_id=str(uuid.uuid4()),
        request_id=f"chat-{session_id}",
        topic=str(snapshot.get("title") or "Chat"),
        context=prompt,
        report_type="summary_brief",
        source_policy="prefer_user_sources",
        source_refs=(),
        timeout_seconds=60,
    )

    started_at = time.monotonic()

    async def event_source() -> AsyncIterator[bytes]:
        message_id = str(uuid.uuid4())
        yield _sse_frame(
            "start",
            json.dumps({"session_id": session_id, "message_id": message_id}, ensure_ascii=False),
        )

        # AnythingLLM's non-stream endpoint is used for the graylisted radar
        # first. We emit one delta so the existing UI keeps its streaming
        # behavior; a failure falls through to the original adapter stream.
        if _anythingllm_chat_enabled(snapshot):
            try:
                (
                    anything_text,
                    anything_sources,
                    anything_tokens_in,
                    anything_tokens_out,
                    anything_model,
                ) = await _anythingllm_chat(
                    snapshot, prompt, session_id=session_id
                )
                cleaned, citations = _parse_citations(anything_text, snapshot)
                citations = _enrich_citations(anything_sources, snapshot) + citations
                latency_ms = int((time.monotonic() - started_at) * 1000)
                await record_llm_usage(
                    LlmUsageAttempt(
                        operation="chat.anythingllm.stream",
                        request_id=request_id,
                        provider="anythingllm",
                        requested_model=anything_model or "workspace-default",
                        actual_model=anything_model,
                        input_tokens=anything_tokens_in,
                        output_tokens=anything_tokens_out,
                        latency_ms=latency_ms,
                    )
                )
                if citations:
                    yield _sse_frame("citations", json.dumps({"citations": citations}, ensure_ascii=False))
                async with pool.connection() as conn:
                    async with conn.transaction():
                        a_row = await (
                            await conn.execute(
                                'INSERT INTO "ai_chat_messages" '
                                '("id", "sessionId", "role", "content", "sourcesJson", '
                                '"latencyMs", "tokensIn", "tokensOut", "costCents", "createdAt") '
                                "VALUES (gen_random_uuid(), %s, 'assistant', %s, %s::jsonb, %s, %s, %s, %s, now()) "
                                'RETURNING "id", "createdAt"',
                                (session_id, cleaned[:100000], json.dumps(citations) if citations else None,
                                latency_ms,
                                anything_tokens_in if anything_tokens_in is not None else tokens_in_est,
                                anything_tokens_out if anything_tokens_out is not None else 0,
                                0),
                            )
                        ).fetchone()
                        await conn.execute(
                            'UPDATE "ai_chat_sessions" SET "updatedAt" = now() WHERE "id" = %s',
                            (session_id,),
                        )
                yield _sse_frame("delta", json.dumps(cleaned, ensure_ascii=False))
                yield _sse_frame("done", json.dumps({
                    "session_id": session_id, "message_id": str(a_row["id"]),
                    "content": cleaned, "sources": citations, "latency_ms": latency_ms,
                    "tokens_in": anything_tokens_in if anything_tokens_in is not None else tokens_in_est,
                    "tokens_out": anything_tokens_out if anything_tokens_out is not None else 0,
                    "cost_cents": 0,
                    "created_at": a_row["createdAt"].isoformat(),
                }, ensure_ascii=False))
                return
            except Exception as exc:
                logger.warning("ai-engine.chat.anythingllm_stream_fallback", session_id=session_id, error=str(exc))

        # Buffer the whole response before emitting anything: reasoning
        # models can still publish `<think>` blocks even with thinking
        # disabled, and single-call adapters only publish the final body.
        # The client gets one cleaned delta and paces it locally.
        final_status: Any = None
        try:
            full_chunks = await _collect_adapter_chunks(adapter, req)
        except AdapterError as exc:
            yield _sse_frame(
                "error",
                json.dumps({"code": exc.code, "message": exc.message}, ensure_ascii=False),
            )
            return
        except Exception as exc:
            yield _sse_frame(
                "error",
                json.dumps({"code": "AI_ENGINE_UNAVAILABLE", "message": str(exc)}, ensure_ascii=False),
            )
            return

        # Re-fetch terminal status (post feeder). The feeder may have
        # already returned the final status via stream_chat; fall back to
        # get_status otherwise.
        try:
            final_status = await adapter.get_status(req.job_id)
        except Exception:
            final_status = None

        if final_status is None or final_status.status != "succeeded":
            yield _sse_frame(
                "error",
                json.dumps(
                    {
                        "code": "AI_ENGINE_UNAVAILABLE",
                        "message": (getattr(final_status, "error_message", None) if final_status else None)
                        or "AI 暂时没有生成回答，请重试",
                    },
                    ensure_ascii=False,
                ),
            )
            return

        # Assemble + clean + parse citations before any text reaches the UI.
        full_text = _clean_model_text("".join(full_chunks) or (final_status.output_text or ""))
        if not full_text:
            yield _sse_frame(
                "error",
                json.dumps({"code": "AI_ENGINE_UNAVAILABLE", "message": "AI 没有生成有效回答，请重试"}, ensure_ascii=False),
            )
            return
        cleaned, citations = _parse_citations(full_text, snapshot)
        if not cleaned:
            yield _sse_frame(
                "error",
                json.dumps({"code": "AI_ENGINE_UNAVAILABLE", "message": "AI 没有生成有效回答，请重试"}, ensure_ascii=False),
            )
            return

        latency_ms = int((time.monotonic() - started_at) * 1000)
        cost_cents = int(getattr(final_status.cost, "cost_cents", 0))
        tokens_out = int(getattr(final_status.cost, "token_output_total", 0) or 0)
        sources_json_str = json.dumps(citations) if citations else None

        yield _sse_frame("delta", json.dumps(cleaned, ensure_ascii=False))

        if citations:
            yield _sse_frame(
                "citations",
                json.dumps({"citations": citations}, ensure_ascii=False),
            )

        async with pool.connection() as conn:
            async with conn.transaction():
                a_row = await (
                    await conn.execute(
                        'INSERT INTO "ai_chat_messages" '
                        '("id", "sessionId", "role", "content", "sourcesJson", '
                        '"latencyMs", "tokensIn", "tokensOut", "costCents", "createdAt") '
                        "VALUES (gen_random_uuid(), %s, 'assistant', %s, %s::jsonb, %s, %s, %s, %s, now()) "
                        'RETURNING "id", "createdAt"',
                        (
                            session_id,
                            cleaned[:100000],
                            sources_json_str,
                            latency_ms,
                            tokens_in_est,
                            tokens_out,
                            cost_cents,
                        ),
                    )
                ).fetchone()
                await conn.execute(
                    'UPDATE "ai_chat_sessions" SET "updatedAt" = now() WHERE "id" = %s',
                    (session_id,),
                )

        yield _sse_frame(
            "done",
            json.dumps(
                {
                    "session_id": session_id,
                    "message_id": str(a_row["id"]),
                    "content": cleaned,
                    "sources": citations,
                    "latency_ms": latency_ms,
                    "tokens_in": tokens_in_est,
                    "tokens_out": tokens_out,
                    "cost_cents": cost_cents,
                    "created_at": a_row["createdAt"].isoformat(),
                },
                ensure_ascii=False,
            ),
        )

        logger.info(
            "ai-engine.chat.message_streamed",
            request_id=request_id,
            session_id=session_id,
            role="assistant",
            tokens_in=tokens_in_est,
            cost_cents=cost_cents,
            citations=len(citations),
        )

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
            "x-request-id": request_id,
        },
    )


__all__ = ["router"]
