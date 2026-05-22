from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import Settings, get_settings
from app.infrastructure.db.postgres_checkpointer import PostgresStateCheckpointer
from app.infrastructure.db.session import DatabaseManager, LangGraphCheckpointerFactory
from app.infrastructure.llm.factory import LiteLLMRouterFactory
from app.routers.chat import router as chat_router
from app.routers.document import router as document_router
from app.shared.exceptions.base import AppError, InfrastructureError

logger = logging.getLogger(__name__)


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def handle_app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": exc.message}},
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=HTTPStatus.UNPROCESSABLE_ENTITY,
            content={"error": {"code": "request_validation_failed", "message": "Invalid request payload.", "details": exc.errors()}},
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_error(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled exception: %s", exc)
        return JSONResponse(
            status_code=HTTPStatus.INTERNAL_SERVER_ERROR,
            content={"error": {"code": "internal_server_error", "message": "Unexpected server error."}},
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings: Settings = get_settings()
    db_manager = DatabaseManager(settings=settings)
    db_manager.initialize()

    llm_router_factory = LiteLLMRouterFactory(settings=settings)
    checkpointer_factory = LangGraphCheckpointerFactory(db_manager=db_manager, settings=settings)

    try:
        await db_manager.ping()
    except Exception as exc:
        logger.warning("Database unavailable during startup: %s", exc)

    app.state.settings = settings
    app.state.db_manager = db_manager
    app.state.llm_router_factory = llm_router_factory
    app.state.checkpointer_factory = checkpointer_factory
    app.state.llm_router_config = llm_router_factory.build()
    app.state.checkpointer_config = await checkpointer_factory.build()
    app.state.graph_checkpointer = PostgresStateCheckpointer(db_manager=db_manager)
    yield
    await db_manager.shutdown()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        debug=settings.app_debug,
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_allow_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    register_exception_handlers(app)
    app.include_router(chat_router)
    app.include_router(document_router)

    @app.get("/healthz", tags=["system"])
    async def healthz(request: Request) -> dict[str, Any]:
        db_status = "ok"
        try:
            db_manager: DatabaseManager = request.app.state.db_manager
            await db_manager.ping()
        except AppError:
            db_status = "degraded"
        return {
            "service": settings.app_name,
            "version": settings.app_version,
            "env": settings.app_env,
            "db": db_status,
        }

    return app


app = create_app()
