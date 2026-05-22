from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Global application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    app_name: str = Field(default="Tech R&D Copilot Backend", description="App name.")
    app_env: Literal["local", "dev", "staging", "prod"] = Field(default="dev")
    app_debug: bool = Field(default=False)
    app_version: str = Field(default="0.1.0")

    api_v1_prefix: str = Field(default="/api/v1")
    cors_allow_origins: list[str] = Field(default_factory=lambda: ["*"])

    postgres_dsn: str = Field(
        default="postgresql+asyncpg://postgres:postgres@localhost:5432/tech_copilot",
        description="SQLAlchemy async DSN for PostgreSQL.",
    )
    postgres_pool_size: int = Field(default=10, ge=1, le=200)
    postgres_max_overflow: int = Field(default=20, ge=0, le=200)
    postgres_pool_timeout_seconds: int = Field(default=30, ge=1, le=300)
    postgres_pool_recycle_seconds: int = Field(default=1800, ge=60, le=86400)

    llm_default_model: str = Field(default="ollama/gemma3:4b")
    llm_timeout_seconds: int = Field(default=120, ge=5, le=600)
    litellm_api_base: str | None = Field(default=None)
    litellm_api_key: str | None = Field(default=None)

    langgraph_checkpoint_namespace: str = Field(default="tech_copilot")
    langgraph_checkpoint_table: str = Field(default="langgraph_checkpoints")

    @field_validator("api_v1_prefix")
    @classmethod
    def validate_api_prefix(cls, value: str) -> str:
        if not value.startswith("/"):
            raise ValueError("api_v1_prefix must start with '/'.")
        return value.rstrip("/") or "/"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Singleton settings provider."""
    return Settings()
