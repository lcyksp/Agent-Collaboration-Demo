from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import Settings
from app.shared.exceptions.base import InfrastructureError


class DatabaseManager:
    """Database engine and session factory manager."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._engine: AsyncEngine | None = None
        self._session_factory: async_sessionmaker[AsyncSession] | None = None

    def initialize(self) -> None:
        """Initialize async engine and session factory."""
        if self._engine is not None and self._session_factory is not None:
            return

        self._engine = create_async_engine(
            self._settings.postgres_dsn,
            pool_pre_ping=True,
            pool_size=self._settings.postgres_pool_size,
            max_overflow=self._settings.postgres_max_overflow,
            pool_timeout=self._settings.postgres_pool_timeout_seconds,
            pool_recycle=self._settings.postgres_pool_recycle_seconds,
            future=True,
        )
        self._session_factory = async_sessionmaker(
            bind=self._engine,
            class_=AsyncSession,
            expire_on_commit=False,
            autoflush=False,
            autocommit=False,
        )

    @property
    def engine(self) -> AsyncEngine:
        if self._engine is None:
            raise InfrastructureError("Database engine is not initialized.", code="db_not_initialized")
        return self._engine

    @property
    def session_factory(self) -> async_sessionmaker[AsyncSession]:
        if self._session_factory is None:
            raise InfrastructureError("Session factory is not initialized.", code="db_not_initialized")
        return self._session_factory

    @asynccontextmanager
    async def session_scope(self) -> AsyncGenerator[AsyncSession, None]:
        session: AsyncSession = self.session_factory()
        try:
            yield session
            await session.commit()
        except SQLAlchemyError as exc:
            await session.rollback()
            raise InfrastructureError(f"Database transaction failed: {exc}", code="db_transaction_failed") from exc
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()

    async def ping(self) -> None:
        """Lightweight health-check query."""
        try:
            async with self.engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
        except Exception as exc:
            raise InfrastructureError(f"Database ping failed: {exc}", code="db_ping_failed") from exc

    async def shutdown(self) -> None:
        if self._engine is not None:
            await self._engine.dispose()
            self._engine = None
            self._session_factory = None


class LangGraphCheckpointerFactory:
    """
    Factory stub for LangGraph PostgreSQL checkpointer.
    Replace return type with actual checkpointer class when wired.
    """

    def __init__(self, db_manager: DatabaseManager, settings: Settings) -> None:
        self._db_manager = db_manager
        self._settings = settings

    async def build(self) -> dict[str, Any]:
        return {
            "type": "postgres_checkpointer",
            "dsn": self._settings.postgres_dsn,
            "namespace": self._settings.langgraph_checkpoint_namespace,
            "table": self._settings.langgraph_checkpoint_table,
            "ready": self._db_manager.engine is not None,
        }
