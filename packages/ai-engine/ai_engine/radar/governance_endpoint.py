"""Internal counterpart to the authenticated Admin governance BFF."""
from __future__ import annotations

from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ai_engine.radar import governance
from ai_engine.radar.sync_endpoint import _require_internal_token

router = APIRouter(prefix='/api/radar/governance', tags=['radar-governance'])


class GovernanceRequest(BaseModel):
    mode: Literal['preview', 'report', 'apply', 'rollback', 'recover']
    actorId: UUID
    batchId: UUID | None = None
    limit: int = Field(default=10, ge=1, le=100)


@router.post('')
async def govern(request: Request, body: GovernanceRequest, _token: None = Depends(_require_internal_token)) -> dict[str, Any]:
    pool = request.app.state.db_pool
    actor = str(body.actorId)
    try:
        if body.mode == 'preview':
            return governance.summary(await governance.snapshot(pool, actor))
        if body.batchId is None:
            raise ValueError('batchId is required')
        batch = str(body.batchId)
        async with pool.connection() as conn:
            admin = await governance.verify_admin(conn, actor)
        if governance.load(batch)['actorId'] != admin:
            raise PermissionError('batch belongs to a different Admin')
        if body.mode == 'report':
            return governance.load(batch)
        if body.mode == 'recover':
            return await governance.recover(pool, actor, batch, limit=min(body.limit, 20))
        return await governance.execute(pool, actor, batch, limit=body.limit, rollback=body.mode == 'rollback')
    except PermissionError as exc:
        raise HTTPException(403, detail=str(exc)) from exc
    except (ValueError, FileNotFoundError, BlockingIOError) as exc:
        raise HTTPException(409, detail=type(exc).__name__) from exc
