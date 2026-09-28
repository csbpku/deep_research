"""Internal API for semantic recommendations from isolated personal workspaces."""

from __future__ import annotations

import logging
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ai_engine.personal_knowledge_index import (
    AnythingLLMClient,
    personal_knowledge_index_enabled,
)

logger = logging.getLogger("ai_engine.personal_knowledge_index.api")
router = APIRouter(prefix="/api/knowledge-index", tags=["personal-knowledge-index"])


def _require_internal_token(request: Request) -> None:
    from ai_engine.radar.sync_endpoint import _require_internal_token

    _require_internal_token(request)


class PersonalKnowledgeSearchRequest(BaseModel):
    user_id: UUID = Field(alias="userId")
    query: str = Field(min_length=2, max_length=2_000)
    limit: int = Field(default=4, ge=1, le=8)

    model_config = {"populate_by_name": True, "extra": "forbid"}


class PersonalKnowledgeSearchResponse(BaseModel):
    ids: list[UUID]
    enabled: bool


@router.post("/search", response_model=PersonalKnowledgeSearchResponse)
async def search_personal_knowledge(
    body: PersonalKnowledgeSearchRequest,
    request: Request,
    _token: Annotated[None, Depends(_require_internal_token)],
) -> PersonalKnowledgeSearchResponse:
    del request, _token
    if not personal_knowledge_index_enabled():
        return PersonalKnowledgeSearchResponse(ids=[], enabled=False)
    try:
        ids = await AnythingLLMClient(timeout_seconds=2.0).vector_search(
            str(body.user_id),
            body.query,
            limit=body.limit,
        )
    except Exception as exc:
        logger.warning("personal knowledge semantic search unavailable", extra={"error_type": type(exc).__name__})
        return PersonalKnowledgeSearchResponse(ids=[], enabled=True)
    try:
        return PersonalKnowledgeSearchResponse(ids=[UUID(value) for value in ids], enabled=True)
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="AnythingLLM returned an invalid record identifier") from exc
