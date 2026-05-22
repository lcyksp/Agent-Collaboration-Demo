from __future__ import annotations

import json
import uuid
import hashlib
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.db.session import DatabaseManager
from app.shared.exceptions.base import InfrastructureError

router = APIRouter(tags=["document"])

ALLOWED_EXTENSIONS: set[str] = {".pdf", ".md", ".markdown", ".txt", ".docx", ".xlsx", ".xls"}


class UploadResponse(BaseModel):
    task_id: str
    status: Literal["queued"]
    filename: str
    accepted_at: datetime


class UploadTaskStatus(BaseModel):
    task_id: str
    status: Literal["queued", "running", "done", "failed"]
    error_message: str | None = None


async def _ensure_document_tables(session: AsyncSession) -> None:
    await session.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS ingestion_tasks (
              id UUID PRIMARY KEY,
              filename TEXT NOT NULL,
              status TEXT NOT NULL,
              error_message TEXT,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
    )
    await session.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS rag_documents (
              id UUID PRIMARY KEY,
              task_id UUID NOT NULL REFERENCES ingestion_tasks(id),
              source_name TEXT NOT NULL,
              chunk_index INT NOT NULL,
              content TEXT NOT NULL,
              metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
              embedding_json JSONB,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
    )
    try:
        ext = await session.execute(text("SELECT 1 FROM pg_extension WHERE extname='vector' LIMIT 1"))
        if ext.first() is not None:
            await session.execute(text("ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS embedding VECTOR(1024)"))
    except Exception:
        pass


def _fallback_embedding(text_value: str, dim: int = 1024) -> list[float]:
    vec = [0.0] * dim
    for token in text_value.lower().split():
        h = int(hashlib.sha256(token.encode("utf-8")).hexdigest(), 16)
        idx = h % dim
        vec[idx] += 1.0
    norm = math.sqrt(sum(v * v for v in vec))
    if norm > 0:
        vec = [v / norm for v in vec]
    return vec


async def _update_task(db_manager: DatabaseManager, task_id: uuid.UUID, status: str, error_message: str | None = None) -> None:
    async with db_manager.session_scope() as session:
        await _ensure_document_tables(session)
        await session.execute(
            text(
                """
                UPDATE ingestion_tasks
                SET status=:status, error_message=:error_message, updated_at=NOW()
                WHERE id=:id
                """
            ),
            {"id": task_id, "status": status, "error_message": error_message},
        )


async def _ingest_file_task(task_id: uuid.UUID, file_path: str, source_name: str, db_manager: DatabaseManager) -> None:
    try:
        await _update_task(db_manager, task_id, "running", None)

        try:
            from langchain_community.document_loaders import (
                Docx2txtLoader,
                PyPDFLoader,
                TextLoader,
                UnstructuredExcelLoader,
            )
            from langchain_text_splitters import RecursiveCharacterTextSplitter
        except Exception as exc:
            await _update_task(db_manager, task_id, "failed", f"Dependency error: {exc}")
            return

        path = Path(file_path)
        suffix = path.suffix.lower()
        if suffix == ".pdf":
            loader = PyPDFLoader(str(path))
        elif suffix == ".docx":
            loader = Docx2txtLoader(str(path))
        elif suffix in {".xlsx", ".xls"}:
            loader = UnstructuredExcelLoader(str(path), mode="elements")
        else:
            loader = TextLoader(str(path), encoding="utf-8")

        docs = loader.load()
        splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=150)
        chunks = splitter.split_documents(docs)
        embedder = None
        try:
            from langchain_ollama import OllamaEmbeddings
            embedder = OllamaEmbeddings(model="nomic-embed-text")
        except Exception:
            embedder = None

        async with db_manager.session_scope() as session:
            await _ensure_document_tables(session)
            col_result = await session.execute(
                text(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name='rag_documents' AND column_name='embedding'
                    LIMIT 1
                    """
                )
            )
            has_embedding_column = col_result.first() is not None
            for idx, doc in enumerate(chunks):
                if embedder is not None:
                    try:
                        vector = embedder.embed_query(doc.page_content)
                    except Exception:
                        vector = _fallback_embedding(doc.page_content)
                else:
                    vector = _fallback_embedding(doc.page_content)
                params = {
                    "id": uuid.uuid4(),
                    "task_id": task_id,
                    "source_name": source_name,
                    "chunk_index": idx,
                    "content": doc.page_content,
                    "metadata": json.dumps(doc.metadata, ensure_ascii=False),
                    "embedding_json": json.dumps(vector, ensure_ascii=False),
                }
                if has_embedding_column and len(vector) == 1024:
                    await session.execute(
                        text(
                            """
                            INSERT INTO rag_documents (id, task_id, source_name, chunk_index, content, metadata, embedding_json, embedding)
                            VALUES (:id, :task_id, :source_name, :chunk_index, :content, CAST(:metadata AS JSONB), CAST(:embedding_json AS JSONB), CAST(:embedding AS vector))
                            """
                        ),
                        {**params, "embedding": str(vector)},
                    )
                else:
                    await session.execute(
                        text(
                            """
                            INSERT INTO rag_documents (id, task_id, source_name, chunk_index, content, metadata, embedding_json)
                            VALUES (:id, :task_id, :source_name, :chunk_index, :content, CAST(:metadata AS JSONB), CAST(:embedding_json AS JSONB))
                            """
                        ),
                        params,
                    )

        await _update_task(db_manager, task_id, "done", None)
    except SQLAlchemyError as exc:
        await _update_task(db_manager, task_id, "failed", f"Database error: {exc}")
    except TimeoutError:
        await _update_task(db_manager, task_id, "failed", "Embedding timeout.")
    except Exception as exc:
        await _update_task(db_manager, task_id, "failed", str(exc))
    finally:
        try:
            Path(file_path).unlink(missing_ok=True)
        except OSError:
            pass


@router.post("/api/upload", response_model=UploadResponse)
async def upload_document(
    request: Request,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
) -> UploadResponse:
    filename = file.filename or "unknown"
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported file type. Allowed: PDF, Markdown, TXT, DOCX, XLSX, XLS.")

    db_manager: DatabaseManager = request.app.state.db_manager
    task_id = uuid.uuid4()
    tmp_dir = Path("tmp_uploads")
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp_file_path = tmp_dir / f"{task_id}{suffix}"

    try:
        content = await file.read()
        tmp_file_path.write_bytes(content)
        async with db_manager.session_scope() as session:
            await _ensure_document_tables(session)
            await session.execute(
                text("INSERT INTO ingestion_tasks (id, filename, status) VALUES (:id, :filename, :status)"),
                {"id": task_id, "filename": filename, "status": "queued"},
            )
    except SQLAlchemyError as exc:
        raise InfrastructureError(f"Failed to create ingestion task: {exc}", code="task_create_failed") from exc
    except Exception as exc:
        raise InfrastructureError(f"Failed to save uploaded file: {exc}", code="upload_save_failed") from exc

    background_tasks.add_task(_ingest_file_task, task_id, str(tmp_file_path), filename, db_manager)
    return UploadResponse(
        task_id=str(task_id),
        status="queued",
        filename=filename,
        accepted_at=datetime.now(timezone.utc),
    )


@router.get("/api/upload/{task_id}", response_model=UploadTaskStatus)
async def get_upload_task_status(request: Request, task_id: str) -> UploadTaskStatus:
    db_manager: DatabaseManager = request.app.state.db_manager
    try:
        task_uuid = uuid.UUID(task_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid task_id format.") from exc

    try:
        async with db_manager.session_scope() as session:
            await _ensure_document_tables(session)
            result = await session.execute(
                text("SELECT status, error_message FROM ingestion_tasks WHERE id=:id"),
                {"id": task_uuid},
            )
            row = result.first()
            if row is None:
                raise HTTPException(status_code=404, detail="Task not found.")
    except SQLAlchemyError as exc:
        raise InfrastructureError(f"Failed to query upload task status: {exc}", code="task_query_failed") from exc

    return UploadTaskStatus(task_id=task_id, status=row[0], error_message=row[1])
