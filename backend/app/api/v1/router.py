from __future__ import annotations

from fastapi import APIRouter

from app.api.v1.endpoints.chat import router as chat_router

api_v1_router = APIRouter()
api_v1_router.include_router(chat_router)
