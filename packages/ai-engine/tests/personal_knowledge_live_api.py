"""Minimal local ASGI app for exercising the real personal-knowledge search route."""

from fastapi import FastAPI

from ai_engine.server.personal_knowledge import router

app = FastAPI()
app.include_router(router)
