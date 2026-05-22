from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.infrastructure.db.session import DatabaseManager
from app.shared.exceptions.base import InfrastructureError


class PostgresStateCheckpointer:
    """
    Lightweight PostgreSQL checkpointer for LangGraph state persistence.
    Compatible with current langgraph version in this project.
    """

    def __init__(self, db_manager: DatabaseManager, table_name: str = "langgraph_state_checkpoints") -> None:
        self._db_manager = db_manager
        self._table_name = table_name

    async def ensure_table(self) -> None:
        try:
            async with self._db_manager.session_scope() as session:
                await session.execute(
                    text(
                        f"""
                        CREATE TABLE IF NOT EXISTS {self._table_name} (
                          id BIGSERIAL PRIMARY KEY,
                          thread_id TEXT NOT NULL,
                          state JSONB NOT NULL,
                          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                        )
                        """
                    )
                )
        except SQLAlchemyError as exc:
            raise InfrastructureError(f"Failed to ensure checkpoint table: {exc}", code="checkpoint_table_failed") from exc

    async def load_latest(self, thread_id: str) -> dict[str, Any] | None:
        try:
            async with self._db_manager.session_scope() as session:
                await self.ensure_table()
                result = await session.execute(
                    text(
                        f"""
                        SELECT state
                        FROM {self._table_name}
                        WHERE thread_id=:thread_id
                        ORDER BY id DESC
                        LIMIT 1
                        """
                    ),
                    {"thread_id": thread_id},
                )
                row = result.first()
                if row is None:
                    return None
                return dict(row[0])
        except SQLAlchemyError as exc:
            raise InfrastructureError(f"Failed to load checkpoint state: {exc}", code="checkpoint_load_failed") from exc

    async def save(self, thread_id: str, state: dict[str, Any]) -> None:
        try:
            async with self._db_manager.session_scope() as session:
                await self.ensure_table()
                await session.execute(
                    text(
                        f"""
                        INSERT INTO {self._table_name} (thread_id, state)
                        VALUES (:thread_id, CAST(:state AS JSONB))
                        """
                    ),
                    {"thread_id": thread_id, "state": json.dumps(state, ensure_ascii=False)},
                )
        except SQLAlchemyError as exc:
            raise InfrastructureError(f"Failed to save checkpoint state: {exc}", code="checkpoint_save_failed") from exc

