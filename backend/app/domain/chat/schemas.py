from __future__ import annotations

from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    role: str = Field(description="Role: system/user/assistant/tool")
    content: str = Field(min_length=1, description="Message content")


class ChatStreamRequest(BaseModel):
    thread_id: str = Field(min_length=1, max_length=128)
    messages: list[ChatMessage] = Field(default_factory=list, min_length=1)
    model: str | None = Field(default=None, description="Optional override model route")
