"""AI chat (drawer) endpoints — Week 6.

Implements POST /api/chat/sessions, GET /api/chat/sessions/{id},
POST /api/chat/sessions/{id}/messages. Session + messages are persisted
in `ai_chat_sessions` and `ai_chat_messages` (see Prisma migration
20260724000000_w6_chat_schema).

Architecture §6.1 context compression: when round >= 3 (i.e. user message
count >= 4), older history is summarized into a single "Earlier Q&A
summary" segment before the Claude call, keeping the last 2 turns in full.
Per-call input token budget is 1500 hard-capped.

The session creation also persists a snapshot of the seed summary so
later edits to the underlying summary don't mutate the chat history.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from typing import Annotated, Any, cast

import structlog
from fastapi import APIRouter, Depends, HTTPException, Path, Request
from pydantic import BaseModel, Field

from ai_engine.adapters.base import ResearchEngineAdapter, ResearchRequest
from ai_engine.contracts.errors import ERROR_CODES, HTTP_STATUS, AdapterError
from ai_engine.contracts.states import (
    AI_CHAT_ROLE,
    AI_CHAT_SESSION_STATUS,
    AiChatRole,
    AiChatSessionStatus,
)

router = APIRouter(prefix="/api/chat", tags=["chat"])

logger = structlog.get_logger("ai_engine.chat")

# Per-call input token hard cap. Tokens are estimated as chars/4 (rough
# heuristic — Claude's tokenizer averages ~4 chars/token for English and
# mixed CN/EN). This keeps us well under the 200k context window and
# protects against runaway costs.
_MAX_INPUT_TOKENS = 1500
_MAX_OUTPUT_TOKENS = 800

# When history has more than this many user messages, the older ones are
# compressed into a summary segment; only the last 2 turns remain verbatim.
_COMPRESS_AT_USER_COUNT = 4

# Snapshot body truncation. Real summaries can be huge; we cap the snapshot
# so chat prompts never grow unbounded with old sessions.
_SNAPSHOT_BODY_MAX = 50_000


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
    # Phase 1 deep-dive: full original source captured by radar sync
    # (see packages/ai-engine/ai_engine/radar/sync_runner.py). Optional
    # because pre-Phase-0 rows won't have it; chat behaves as before when null.
    original_markdown: str | None = None
    original_kind: str | None = None


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
    content: str = Field(min_length=1, max_length=4000)
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
                '"summaryDate", "tags", "originalMarkdown", "originalKind" '
                'FROM "summaries" WHERE "id" = %s',
                (summary_id,),
            )
        ).fetchone()
    return dict(row) if row else None


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
) -> tuple[str, int]:
    """Assemble the assistant prompt under 1500-token budget.

    W7 (工程师 B): delegates the budget + untrusted-input boundary to
    ``prompt.build_chat_prompt`` so the chat path and the long-research
    path share one source of truth. The LLM-based "earlier turns"
    compression (W6 §6.1) is still applied BEFORE the shared builder
    so the prompt stays well under the 1500-token cap.

    Returns (prompt, estimated_tokens).
    """
    from ai_engine.prompt import build_chat_prompt

    seed_body = (snapshot.get("body") or "")[:30000]
    seed_interp = (snapshot.get("interpretation") or "")[:2000]

    user_message_count = sum(1 for m in history if m["role"] == "user")
    # Compress older turns when round >= 3 (>= 4 user messages total).
    if user_message_count >= _COMPRESS_AT_USER_COUNT:
        older = history[:-4]  # drop the last 2 user/assistant pairs
        recent = history[-4:]
        if older:
            try:
                from ai_engine.ingestion.pipeline import _generate_brief

                summary_input = "\n".join(
                    f"[{m['role']}] {m['content']}" for m in older
                )
                brief = await _generate_brief(
                    adapter,
                    {"title": "Earlier Q&A", "snippet": summary_input[:8000]},
                    "earlier-qa",
                    timeout_seconds=20.0,
                )
                compressed = (brief.output_text or "").strip() or "(上下文已压缩)"
            except Exception:
                compressed = "(上下文已压缩,详见对话历史)"
            # Prepend the compressed segment so it lands in the budget
            # before the recent turns and the new user message.
            history = (
                [{"role": "system", "content": f"[Earlier Q&A summary] {compressed[:1500]}"}]
                + recent
            )
        else:
            history = recent

    built = build_chat_prompt(
        snapshot_body=seed_body,
        snapshot_interpretation=seed_interp,
        history=history,
        user_msg=user_msg["content"],
        original_markdown=snapshot.get("original_markdown"),
        original_kind=snapshot.get("original_kind"),
        # include_original defaults True; the UI toggle will plumb a
        # session-level flag in Phase 1.4 (left as future work — current
        # default behaviour is to use the original when available).
        include_original=True,
    )
    return built.system + "\n\n" + built.user, built.estimated_tokens


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

    snapshot: dict[str, object] = {
        "id": str(summary["id"]),
        "title": summary["title"] or "",
        "url": summary["url"] or "",
        "body": (summary["body"] or "")[:_SNAPSHOT_BODY_MAX],
        "interpretation": summary.get("interpretation"),
        "summary_date": summary["summaryDate"].isoformat()[:10]
        if summary.get("summaryDate") else "",
        "tags": list(summary.get("tags") or []),
        # Phase 1 deep-dive fields — may be None for rows ingested
        # before Phase 0 sync ran.
        "original_markdown": (summary.get("originalMarkdown") or "")[:_SNAPSHOT_BODY_MAX]
        if summary.get("originalMarkdown") else None,
        "original_kind": summary.get("originalKind"),
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

    prompt, tokens_in_est = await _build_prompt(pool, snapshot, history, user_msg, adapter)

    started = time.monotonic()
    try:
        req = ResearchRequest(
            job_id=str(uuid.uuid4()),
            request_id=f"chat-{session_id}",
            topic=str(snapshot.get("title") or "Chat"),
            context=prompt,
            report_type="summary_brief",
            # The chat session already carries the captured article in its
            # prompt context; it does not submit a URL source_ref. Using
            # only_user_sources here incorrectly fails every follow-up with
            # NO_SOURCES_FOUND before the model can read the snapshot.
            source_policy="prefer_user_sources",
            source_refs=(),
            timeout_seconds=60,
        )
        await adapter.submit(req)
        deadline = time.monotonic() + 60.0
        brief = None
        while time.monotonic() < deadline:
            await asyncio.sleep(0.1)
            status = await adapter.get_status(req.job_id)
            if status.status in {"succeeded", "failed", "partial", "cancelled"}:
                brief = status
                break
        if brief is None:
            raise _http_error("AI_ENGINE_UNAVAILABLE", "adapter 60s 超时")
        latency_ms = int((time.monotonic() - started) * 1000)
        if brief.status != "succeeded":
            raise _http_error(
                "AI_ENGINE_UNAVAILABLE",
                brief.error_message or "AI 暂时没有生成回答，请重试",
            )
        content = (brief.output_text or "").strip()
        if not content:
            # Do not persist or return an empty assistant bubble. An empty
            # model result is an upstream failure from the user's perspective.
            raise _http_error("AI_ENGINE_UNAVAILABLE", "AI 没有生成有效回答，请重试")
    except AdapterError as exc:
        raise _http_error(exc.code, exc.message)

    # Insert assistant message
    cost_cents = int(getattr(brief.cost, "cost_cents", 0))
    async with pool.connection() as conn:
        async with conn.transaction():
            a_row = await (
                await conn.execute(
                    'INSERT INTO "ai_chat_messages" '
                    '("id", "sessionId", "role", "content", "sourcesJson", '
                    '"latencyMs", "tokensIn", "tokensOut", "costCents", "createdAt") '
                    "VALUES (gen_random_uuid(), %s, 'assistant', %s, NULL, %s, %s, %s, %s, now()) "
                    'RETURNING "id", "createdAt"',
                    (
                        session_id,
                        content[:50000],
                        latency_ms,
                        tokens_in_est,
                        int(getattr(brief.cost, "token_output_total", 0) or 0),
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
        tokens_in=tokens_in_est,
        cost_cents=cost_cents,
    )
    return ChatMessageOut(
        id=str(a_row["id"]),
        role=cast(AiChatRole, AI_CHAT_ROLE["ASSISTANT"]),
        content=content,
        sources_json=None,
        latency_ms=latency_ms,
        tokens_in=tokens_in_est,
        tokens_out=int(getattr(brief.cost, "token_output_total", 0) or 0),
        cost_cents=cost_cents,
        created_at=a_row["createdAt"].isoformat(),
    )


__all__ = ["router"]
