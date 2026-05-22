from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.domain.chat.schemas import ChatStreamRequest
from app.infrastructure.llm.factory import LiteLLMRouterFactory

router = APIRouter(prefix="/chat", tags=["chat"])


def _format_sse(data: dict[str, object], event: str = "message") -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _normalize_model_route(raw_model: str | None) -> str:
    model = (raw_model or "").strip()
    if not model:
        return "openai/gpt-4o-mini"
    if "/" in model:
        return model
    return f"openai/{model}"


@router.post("/stream")
async def chat_stream(request: Request, payload: ChatStreamRequest) -> StreamingResponse:
    llm_factory: LiteLLMRouterFactory = request.app.state.llm_router_factory
    route = llm_factory.parse_model_route(_normalize_model_route(payload.model))
    last_user_text = payload.messages[-1].content

    async def event_generator() -> AsyncGenerator[str, None]:
        yield _format_sse(
            {
                "type": "meta",
                "thread_id": payload.thread_id,
                "provider": route.provider,
                "model": route.model,
            },
            event="start",
        )
        chunks = [
            "已接收请求，",
            "正在通过多 Agent 编排处理，",
            "后续可在此替换为 LangGraph + LiteLLM 实时 token 流。",
            f" 你的输入是：{last_user_text}",
        ]
        for idx, chunk in enumerate(chunks, start=1):
            if await request.is_disconnected():
                break
            yield _format_sse({"type": "token", "index": idx, "content": chunk})
            await asyncio.sleep(0.15)

        yield _format_sse({"type": "done"}, event="end")

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
