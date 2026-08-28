"""AI research follow-up chat endpoint.

Persistent AI-research conversations are stored by the web BFF
(``ai_research_conversations`` / ``ai_research_conversation_messages``).
This endpoint is deliberately stateless: the BFF supplies the final
report text + recent history, and we stream a grounded follow-up answer
back over SSE using the same adapter path as the radar chat.
"""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from typing import Annotated, Any, AsyncIterator

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ai_engine.adapters.base import ResearchEngineAdapter, ResearchRequest
from ai_engine.contracts.errors import HTTP_STATUS, AdapterError
from ai_engine.prompt import build_chat_prompt

router = APIRouter(prefix="/api/ai-research/chat", tags=["research-chat"])

logger = structlog.get_logger("ai_engine.research_chat")


def _http_error(code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=HTTP_STATUS.get(code, 500),
        detail={"code": code, "message": message},
    )


def _adapter(request: Request) -> ResearchEngineAdapter:
    adapter = getattr(request.app.state, "adapter", None)
    if adapter is None:
        from ai_engine.adapters.base import build_adapter

        adapter = build_adapter()
    return adapter


def _clean_model_text(value: Any) -> str:
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


def _sse_frame(event: str, data: str) -> bytes:
    return f"event: {event}\ndata: {data}\n\n".encode("utf-8")


class FollowUpBody(BaseModel):
    user_id: str
    report_title: str = Field(default="AI 调研", max_length=300)
    report_content: str = Field(default="", max_length=512000)
    history: list[dict[str, str]] = Field(default_factory=list)
    question: str = Field(min_length=1, max_length=32000)


@router.post("/follow-up")
async def follow_up(
    body: FollowUpBody,
    request: Request,
    adapter: Annotated[ResearchEngineAdapter, Depends(_adapter)],
) -> StreamingResponse:
    """Stream a grounded follow-up answer about a finished research report."""
    request_id = getattr(request.state, "request_id", "")
    question = body.question.strip()
    if not question:
        raise _http_error("VALIDATION_FAILED", "提问不能为空")

    built = build_chat_prompt(
        snapshot_body=body.report_content,
        snapshot_interpretation=None,
        history=[message for message in body.history if message.get("content")],
        user_msg=question,
        max_input_tokens=60000,
    )
    req = ResearchRequest(
        job_id=str(uuid.uuid4()),
        # ``_run_brief`` treats request ids starting with ``chat-`` as Q&A
        # rather than a summary, and keeps a larger context budget for them.
        request_id=f"chat-research-{body.user_id[:12]}-{uuid.uuid4().hex[:8]}",
        topic=body.report_title[:200],
        # The shared prompt builder returns the trust-boundary system text
        # separately; pass both so the adapter's single-call path enforces
        # the same "no internal reasoning" instruction as the radar chat.
        context=f"{built.system}\n\n{built.user}",
        report_type="summary_brief",
        source_policy="prefer_user_sources",
        source_refs=(),
        timeout_seconds=120,
    )

    started_at = asyncio.get_event_loop().time()

    async def event_source() -> AsyncIterator[bytes]:
        message_id = str(uuid.uuid4())
        yield _sse_frame(
            "start",
            json.dumps({"message_id": message_id}, ensure_ascii=False),
        )

        full_chunks: list[str] = []
        queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=128)

        async def feeder() -> None:
            async def q_delta(chunk: str) -> None:
                await queue.put(chunk)

            try:
                if hasattr(adapter, "stream_chat"):
                    await adapter.stream_chat(req, on_delta=q_delta)
                else:
                    await adapter.submit(req)
                    prev_len = 0
                    deadline = asyncio.get_event_loop().time() + req.timeout_seconds
                    while True:
                        if asyncio.get_event_loop().time() >= deadline:
                            raise _http_error("AI_ENGINE_UNAVAILABLE", "adapter 超时")
                        status = await adapter.get_status(req.job_id)
                        text = status.output_text or ""
                        if len(text) > prev_len:
                            # Single-call adapters only publish the final body;
                            # buffer it and emit the cleaned answer after the
                            # terminal status so <think> markup never streams.
                            full_chunks.append(text[prev_len:])
                            prev_len = len(text)
                        if status.status in {"succeeded", "failed", "partial", "cancelled"}:
                            break
                        await asyncio.sleep(0.1)
            finally:
                await queue.put(None)

        feeder_task = asyncio.create_task(feeder())
        streamed_any = False

        while True:
            item = await queue.get()
            if item is None:
                break
            full_chunks.append(item)
            streamed_any = True
            yield _sse_frame("delta", json.dumps(item, ensure_ascii=False))

        final_status: Any = None
        try:
            await feeder_task
        except AdapterError as exc:
            yield _sse_frame(
                "error",
                json.dumps({"code": exc.code, "message": exc.message}, ensure_ascii=False),
            )
            return
        except Exception as exc:  # pragma: no cover - defensive
            yield _sse_frame(
                "error",
                json.dumps({"code": "AI_ENGINE_UNAVAILABLE", "message": str(exc)}, ensure_ascii=False),
            )
            return

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

        full_text = _clean_model_text("".join(full_chunks) or (final_status.output_text or ""))
        if not full_text:
            yield _sse_frame(
                "error",
                json.dumps({"code": "AI_ENGINE_UNAVAILABLE", "message": "AI 没有生成有效回答，请重试"}, ensure_ascii=False),
            )
            return
        if not streamed_any:
            # Fake/in-memory adapters may finish before the first poll-diff
            # read, and single-call adapters publish only the final body;
            # emit the complete cleaned answer as one delta so the UI still
            # gets its streaming/typewriter path without <think> markup.
            yield _sse_frame("delta", json.dumps(full_text, ensure_ascii=False))

        latency_ms = int((asyncio.get_event_loop().time() - started_at) * 1000)
        yield _sse_frame(
            "done",
            json.dumps(
                {
                    "message_id": message_id,
                    "content": full_text[:100000],
                    "latency_ms": latency_ms,
                },
                ensure_ascii=False,
            ),
        )
        logger.info(
            "ai-engine.research_chat.follow_up",
            request_id=request_id,
            user_id=body.user_id,
            latency_ms=latency_ms,
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
