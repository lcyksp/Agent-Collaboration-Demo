from __future__ import annotations

import json
import logging
import hashlib
import math
from collections.abc import AsyncGenerator
from datetime import datetime
from http import HTTPStatus
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.application.workflows.langgraph_core import GraphRuntime, GraphState, _run_dynamic_agent, build_graph
from app.infrastructure.db.postgres_checkpointer import PostgresStateCheckpointer
from app.infrastructure.db.session import DatabaseManager
from app.infrastructure.llm.factory import LiteLLMRouterFactory
from app.shared.exceptions.base import InfrastructureError

router = APIRouter(tags=["chat"])
logger = logging.getLogger(__name__)


class ChatStreamRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=128)
    user_input: str = Field(min_length=1, max_length=20000)
    model_provider: Literal["local", "cloud"] = Field(default="local")
    cloud_preset: Literal["aliyun", "openai", "custom"] = Field(default="aliyun")
    api_key: str | None = Field(default=None)
    api_base: str | None = Field(default=None)
    cloud_model: str | None = Field(default=None)
    local_model: str | None = Field(default=None)
    agent_prompts: dict[str, str] | None = Field(default=None)
    agent_configs: list[dict[str, Any]] | None = Field(default=None)


class HistoryItem(BaseModel):
    role: Literal["user", "assistant", "system", "tool"]
    content: str
    created_at: datetime


class HistoryResponse(BaseModel):
    session_id: str
    messages: list[HistoryItem]


class CloudValidateRequest(BaseModel):
    cloud_preset: Literal["aliyun", "openai", "custom"] = Field(default="aliyun")
    api_key: str = Field(min_length=1, max_length=512)
    api_base: str | None = Field(default=None)
    cloud_model: str | None = Field(default=None)


class CloudValidateResponse(BaseModel):
    ok: bool
    code: str
    message: str


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _status_from_node(node_name: str) -> dict[str, str]:
    mapping = {
        "router": {"agent": "Router Agent", "status": "routing", "content": "正在分析请求并分发任务..."},
        "rag_expert": {"agent": "RAG Expert", "status": "searching", "content": "正在检索文档并组织引用..."},
        "code_architect": {"agent": "Code Architect", "status": "coding", "content": "正在输出架构与代码方案..."},
        "review": {"agent": "Review Agent", "status": "reviewing", "content": "正在审查逻辑、安全与规范..."},
    }
    return mapping.get(node_name, {"agent": node_name, "status": "running", "content": "节点执行中..."})


def _is_timeout_error(exc: Exception) -> bool:
    name = exc.__class__.__name__.lower()
    message = str(exc).lower()
    return "timeout" in name or "timed out" in message or "request timed out" in message


def _is_connection_error(exc: Exception) -> bool:
    name = exc.__class__.__name__.lower()
    message = str(exc).lower()
    return "connection" in name or "connection error" in message or "connect error" in message


def _is_auth_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return (
        "invalid_api_key" in message
        or "incorrect api key" in message
        or "unauthorized" in message
        or "401" in message
        or "authenticationerror" in message
        or "missing credentials" in message
    )


async def _ensure_chat_tables(session: AsyncSession) -> None:
    await session.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS chat_history (
              id BIGSERIAL PRIMARY KEY,
              session_id TEXT NOT NULL,
              role TEXT NOT NULL,
              content TEXT NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
    )


async def _save_message(session: AsyncSession, session_id: str, role: str, content: str) -> None:
    await session.execute(
        text("INSERT INTO chat_history (session_id, role, content) VALUES (:session_id, :role, :content)"),
        {"session_id": session_id, "role": role, "content": content},
    )


async def _load_recent_history(session: AsyncSession, session_id: str, limit: int = 12) -> list[dict[str, str]]:
    result = await session.execute(
        text(
            """
            SELECT role, content
            FROM chat_history
            WHERE session_id=:session_id
            ORDER BY id DESC
            LIMIT :limit_count
            """
        ),
        {"session_id": session_id, "limit_count": limit},
    )
    rows = result.fetchall()
    rows.reverse()
    return [{"role": str(r[0]), "content": str(r[1])} for r in rows]


class LiteLLMGateway:
    def __init__(self, llm_factory: LiteLLMRouterFactory) -> None:
        self._llm_factory = llm_factory

    async def ainvoke(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        provider: str,
        cloud_preset: str = "aliyun",
        api_key: str | None = None,
        api_base: str | None = None,
        cloud_model: str | None = None,
        local_model: str | None = None,
    ) -> str:
        cloud_defaults = {
            "aliyun": {"provider": "openai", "base": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen-plus"},
            "openai": {"provider": "openai", "base": "https://api.openai.com/v1", "model": "gpt-4o-mini"},
            "custom": {"provider": "openai", "base": self._llm_factory._settings.litellm_api_base or "", "model": "gpt-4o-mini"},
        }
        preset = cloud_defaults.get(cloud_preset, cloud_defaults["aliyun"])
        route_name = (
            f"ollama/{(local_model or 'gemma3:4b')}"
            if provider == "local"
            else f"{preset['provider']}/{cloud_model or preset['model'] or 'gpt-4o-mini'}"
        )
        route = self._llm_factory.parse_model_route(route_name)
        timeout = self._llm_factory._settings.llm_timeout_seconds
        effective_base = api_base or preset["base"] or self._llm_factory._settings.litellm_api_base or None
        effective_api_key = api_key or self._llm_factory._settings.litellm_api_key or None
        logger.info(
            "LLM invoke start provider=%s model=%s cloud_preset=%s api_base=%s api_key_set=%s timeout=%s",
            route.provider,
            route.model,
            cloud_preset,
            effective_base,
            bool(effective_api_key),
            timeout,
        )

        try:
            from litellm import acompletion
            try:
                from litellm.exceptions import Timeout as LiteLLMTimeout
            except Exception:  # pragma: no cover
                LiteLLMTimeout = TimeoutError  # type: ignore[assignment]

            response = await acompletion(
                model=f"{route.provider}/{route.model}",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                timeout=timeout,
                api_base=effective_base,
                api_key=effective_api_key,
            )
            content = response.choices[0].message.content
            return str(content or "")
        except (LiteLLMTimeout, TimeoutError) as exc:
            logger.warning("LLM timeout provider=%s model=%s err=%r", route.provider, route.model, exc)
            raise InfrastructureError("LLM request timeout. Please try again.", code="llm_timeout") from exc
        except Exception as exc:
            logger.exception(
                "LLM invoke failed provider=%s model=%s cloud_preset=%s api_base=%s api_key_set=%s err_type=%s err=%s",
                route.provider,
                route.model,
                cloud_preset,
                effective_base,
                bool(effective_api_key),
                exc.__class__.__name__,
                str(exc),
            )
            if _is_connection_error(exc):
                raise InfrastructureError("LLM connection error. Please check API base/network and try again.", code="llm_connection_error") from exc
            if route.provider != "ollama":
                raise
            try:
                from ollama import AsyncClient

                client = AsyncClient()
                response = await client.chat(
                    model=route.model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                )
                return str(response["message"]["content"])
            except Exception as exc:
                raise InfrastructureError(f"LLM invocation failed: {exc}", code="llm_invoke_failed") from exc


class PgVectorRetriever:
    def __init__(self, db_manager: DatabaseManager) -> None:
        self._db_manager = db_manager

    @staticmethod
    def _cosine_similarity(a: list[float], b: list[float]) -> float:
        if not a or not b or len(a) != len(b):
            return 0.0
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = sum(x * x for x in a) ** 0.5
        norm_b = sum(y * y for y in b) ** 0.5
        if norm_a == 0 or norm_b == 0:
            return 0.0
        return dot / (norm_a * norm_b)

    @staticmethod
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

    async def search(self, *, query: str, top_k: int = 5) -> list[dict[str, Any]]:
        try:
            q_vec: list[float]
            try:
                from langchain_ollama import OllamaEmbeddings
                embedder = OllamaEmbeddings(model="nomic-embed-text")
                q_vec = embedder.embed_query(query)
            except Exception:
                q_vec = self._fallback_embedding(query)
            async with self._db_manager.session_scope() as session:
                has_vector = False
                try:
                    ext = await session.execute(text("SELECT 1 FROM pg_extension WHERE extname='vector' LIMIT 1"))
                    has_vector = ext.first() is not None
                except Exception:
                    has_vector = False

                if has_vector and len(q_vec) == 1024:
                    result = await session.execute(
                        text(
                            """
                            SELECT source_name, content, 1 - (embedding <=> CAST(:embedding AS vector)) AS score
                            FROM rag_documents
                            WHERE embedding IS NOT NULL
                            ORDER BY embedding <=> CAST(:embedding AS vector)
                            LIMIT :top_k
                            """
                        ),
                        {"embedding": str(q_vec), "top_k": top_k},
                    )
                    rows = result.fetchall()
                    return [{"source": str(r[0]), "content": str(r[1]), "score": float(r[2])} for r in rows]

                result = await session.execute(
                    text(
                        """
                        SELECT source_name, content, embedding_json
                        FROM rag_documents
                        WHERE embedding_json IS NOT NULL
                        ORDER BY created_at DESC
                        LIMIT :limit_count
                        """
                    ),
                    {"limit_count": max(top_k * 20, 100)},
                )
                rows = result.fetchall()
                scored: list[dict[str, Any]] = []
                for row in rows:
                    emb = row[2]
                    if not isinstance(emb, list):
                        continue
                    try:
                        emb_float = [float(x) for x in emb]
                    except Exception:
                        continue
                    score = self._cosine_similarity(q_vec, emb_float)
                    scored.append({"source": str(row[0]), "content": str(row[1]), "score": float(score)})
                scored.sort(key=lambda x: x["score"], reverse=True)
                return scored[:top_k]
        except Exception:
            return []


@router.post("/api/chat/stream")
async def stream_chat(request: Request, payload: ChatStreamRequest) -> StreamingResponse:
    db_manager: DatabaseManager = request.app.state.db_manager
    llm_factory: LiteLLMRouterFactory = request.app.state.llm_router_factory
    state_checkpointer = PostgresStateCheckpointer(db_manager=db_manager)
    model_gateway = LiteLLMGateway(llm_factory=llm_factory)

    graph_runtime = GraphRuntime(
        model_gateway=model_gateway,
        retriever=PgVectorRetriever(db_manager=db_manager),
        max_rewrite_rounds=1,
        agents=payload.agent_configs,
    )
    graph = build_graph(runtime=graph_runtime, checkpointer=None)

    async def event_stream() -> AsyncGenerator[str, None]:
        db_available = True
        history_context = ""

        try:
            async with db_manager.session_scope() as session:
                await _ensure_chat_tables(session)
                history = await _load_recent_history(session, payload.session_id, limit=12)
                await _save_message(session, payload.session_id, "user", payload.user_input)
                if history:
                    history_context = "\\n".join([f"{m['role']}: {m['content']}" for m in history])
        except Exception as exc:
            db_available = False
            yield _sse("agent_status", {"agent": "Memory Agent", "status": "degraded", "content": f"数据库不可用，降级运行：{exc}"})

        try:
            previous_state: dict[str, Any] | None = None
            if db_available:
                try:
                    previous_state = await state_checkpointer.load_latest(payload.session_id)
                except Exception:
                    previous_state = None

            effective_provider = payload.model_provider
            if payload.model_provider == "cloud" and not (payload.api_key or llm_factory._settings.litellm_api_key):
                effective_provider = "local"
                yield _sse("agent_status", {"agent": "Router Agent", "status": "fallback", "content": "未配置云端 API Key，已自动切换到本地模型。"})

            input_text = payload.user_input
            if history_context:
                input_text = f"[会话历史]\\n{history_context}\\n\\n[当前问题]\\n{payload.user_input}"

            initial_state: GraphState = {
                "session_id": payload.session_id,
                "user_input": input_text,
                "model_provider": effective_provider,
                "cloud_preset": payload.cloud_preset,
                "api_key": payload.api_key or "",
                "api_base": payload.api_base or "",
                "cloud_model": payload.cloud_model or "",
                "local_model": payload.local_model or "",
                "router_prompt": (payload.agent_prompts or {}).get("router", ""),
                "rag_prompt": (payload.agent_prompts or {}).get("rag_expert", ""),
                "code_prompt": (payload.agent_prompts or {}).get("code_architect", ""),
                "review_prompt": (payload.agent_prompts or {}).get("review", ""),
                "agent_configs": payload.agent_configs or [],
                "rewrite_count": 0,
                "statuses": [],
            }
            if isinstance(previous_state, dict):
                initial_state = {**previous_state, **initial_state}

            stream_config = {"configurable": {"thread_id": payload.session_id}}
            final_answer = ""
            final_state_snapshot: dict[str, Any] = dict(initial_state)

            dynamic_agents = [a for a in (graph_runtime.agents or []) if bool(a.get("enabled", True))]
            if dynamic_agents:
                for agent in dynamic_agents:
                    yield _sse("agent_status", {"agent": agent.get("name", "Agent"), "status": "running", "content": "正在执行..."})
                    try:
                        next_state = await _run_dynamic_agent(final_state_snapshot, graph_runtime, agent)
                    except Exception as exc:
                        yield _sse("error", {"code": "agent_execution_failed", "message": str(exc)})
                        raise
                    if isinstance(next_state, dict):
                        final_state_snapshot = {**final_state_snapshot, **next_state}
                        candidate = next_state.get("final_answer") or next_state.get("draft_answer")
                        if isinstance(candidate, str) and candidate.strip():
                            final_answer = candidate
            else:
                async for event in graph.astream_events(initial_state, config=stream_config, version="v2"):
                    event_name = event.get("event")
                    if event_name == "on_chain_start":
                        node = str(event.get("name", "unknown"))
                        if node in {"router", "rag_expert", "code_architect", "review"}:
                            yield _sse("agent_status", _status_from_node(node))
                    elif event_name == "on_chain_end":
                        data = event.get("data", {})
                        if isinstance(data, dict):
                            output = data.get("output", {})
                            if isinstance(output, dict):
                                final_state_snapshot = {**final_state_snapshot, **output}
                                candidate = output.get("final_answer") or output.get("draft_answer")
                                if isinstance(candidate, str) and candidate.strip():
                                    final_answer = candidate

            final_answer = (
                final_answer
                or str(final_state_snapshot.get("final_answer") or "").strip()
                or str(final_state_snapshot.get("draft_answer") or "").strip()
            )

            if not final_answer:
                fallback = str(final_state_snapshot.get("rag_context") or "").strip()
                final_answer = fallback or f"已处理请求：{payload.user_input}"

            for token in final_answer:
                yield _sse("chunk", {"chunk": token})

            if db_available:
                try:
                    async with db_manager.session_scope() as session:
                        await _save_message(session, payload.session_id, "assistant", final_answer)
                except Exception:
                    pass

            if db_available:
                try:
                    await state_checkpointer.save(payload.session_id, final_state_snapshot)
                except Exception:
                    pass

            yield _sse("done", {"session_id": payload.session_id, "message": "stream completed"})
        except InfrastructureError as exc:
            if db_available:
                try:
                    async with db_manager.session_scope() as session:
                        await _save_message(session, payload.session_id, "assistant", f"[Error] {exc.message}")
                except Exception:
                    pass
            yield _sse("error", {"code": exc.code, "message": exc.message})
        except SQLAlchemyError as exc:
            if db_available:
                try:
                    async with db_manager.session_scope() as session:
                        await _save_message(session, payload.session_id, "assistant", f"[Error] Database operation failed: {exc}")
                except Exception:
                    pass
            yield _sse("error", {"code": "db_error", "message": f"Database operation failed: {exc}"})
        except TimeoutError:
            if db_available:
                try:
                    async with db_manager.session_scope() as session:
                        await _save_message(session, payload.session_id, "assistant", "[Error] LLM request timeout.")
                except Exception:
                    pass
            yield _sse("error", {"code": "llm_timeout", "message": "LLM request timeout."})
        except Exception as exc:
            if _is_timeout_error(exc):
                if db_available:
                    try:
                        async with db_manager.session_scope() as session:
                            await _save_message(session, payload.session_id, "assistant", "[Error] LLM request timeout. Please try again.")
                    except Exception:
                        pass
                yield _sse("error", {"code": "llm_timeout", "message": "LLM request timeout. Please try again."})
                return
            if _is_connection_error(exc):
                if db_available:
                    try:
                        async with db_manager.session_scope() as session:
                            await _save_message(session, payload.session_id, "assistant", "[Error] LLM connection error. Please check API base/network and try again.")
                    except Exception:
                        pass
                yield _sse("error", {"code": "llm_connection_error", "message": "LLM connection error. Please check API base/network and try again."})
                return
            if db_available:
                try:
                    async with db_manager.session_scope() as session:
                        await _save_message(session, payload.session_id, "assistant", f"[Error] {str(exc)}")
                except Exception:
                    pass
            yield _sse("error", {"code": "stream_internal_error", "message": str(exc)})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
        status_code=HTTPStatus.OK,
    )


@router.get("/api/history/{session_id}", response_model=HistoryResponse)
async def get_history(request: Request, session_id: str) -> HistoryResponse:
    if not session_id.strip():
        raise HTTPException(status_code=400, detail="session_id cannot be empty.")

    db_manager: DatabaseManager = request.app.state.db_manager
    try:
        async with db_manager.session_scope() as session:
            await _ensure_chat_tables(session)
            result = await session.execute(
                text(
                    """
                    SELECT role, content, created_at
                    FROM chat_history
                    WHERE session_id=:session_id
                    ORDER BY id ASC
                    """
                ),
                {"session_id": session_id},
            )
            rows = result.fetchall()
    except SQLAlchemyError as exc:
        raise InfrastructureError(f"Failed to read session history: {exc}", code="history_query_failed") from exc

    messages = [HistoryItem(role=row[0], content=row[1], created_at=row[2]) for row in rows]
    return HistoryResponse(session_id=session_id, messages=messages)


@router.get("/api/history/{session_id}/export")
async def export_history(
    request: Request,
    session_id: str,
    format: Literal["json", "markdown"] = Query(default="json"),
):
    history = await get_history(request, session_id)
    if format == "json":
        return JSONResponse(
            content={"session_id": history.session_id, "messages": [m.model_dump(mode="json") for m in history.messages]},
            media_type="application/json; charset=utf-8",
        )

    lines = [f"# Session: {history.session_id}", ""]
    for m in history.messages:
        lines.append(f"## {m.role.upper()} [{m.created_at.isoformat()}]")
        lines.append(m.content)
        lines.append("")
    content = "\n".join(lines)
    return StreamingResponse(iter([content]), media_type="text/markdown; charset=utf-8")


@router.delete("/api/history/{session_id}")
async def delete_history(request: Request, session_id: str) -> dict[str, Any]:
    if not session_id.strip():
        raise HTTPException(status_code=400, detail="session_id cannot be empty.")

    db_manager: DatabaseManager = request.app.state.db_manager
    try:
        async with db_manager.session_scope() as session:
            await _ensure_chat_tables(session)
            await session.execute(
                text("DELETE FROM chat_history WHERE session_id=:session_id"),
                {"session_id": session_id},
            )
    except SQLAlchemyError as exc:
        raise InfrastructureError(f"Failed to delete session history: {exc}", code="history_delete_failed") from exc

    try:
        state_checkpointer = PostgresStateCheckpointer(db_manager=db_manager)
        await state_checkpointer.ensure_table()
        async with db_manager.session_scope() as session:
            await session.execute(
                text("DELETE FROM langgraph_state_checkpoints WHERE thread_id=:thread_id"),
                {"thread_id": session_id},
            )
    except Exception:
        pass

    return {"ok": True, "session_id": session_id}


@router.get("/api/models/local")
async def list_local_models() -> dict[str, Any]:
    try:
        from ollama import Client

        client = Client()
        response = client.list()
        raw_models = getattr(response, "models", None)
        if raw_models is None and isinstance(response, dict):
            raw_models = response.get("models", [])
        if raw_models is None:
            raw_models = []

        names: list[str] = []
        for item in raw_models:
            model_name = getattr(item, "model", None)
            if not model_name and isinstance(item, dict):
                model_name = item.get("model") or item.get("name")
            if model_name:
                names.append(str(model_name))
        return {"models": names}
    except Exception:
        return {"models": []}


@router.post("/api/cloud/validate", response_model=CloudValidateResponse)
async def validate_cloud_api(payload: CloudValidateRequest) -> CloudValidateResponse:
    cloud_defaults = {
        "aliyun": {"base": "https://dashscope.aliyuncs.com/compatible-mode/v1", "model": "qwen-plus"},
        "openai": {"base": "https://api.openai.com/v1", "model": "gpt-4o-mini"},
        "custom": {"base": "", "model": "gpt-4o-mini"},
    }
    preset = cloud_defaults.get(payload.cloud_preset, cloud_defaults["aliyun"])
    if payload.cloud_preset == "custom":
        base = (payload.api_base or "").strip().rstrip("/")
        model = (payload.cloud_model or preset["model"] or "gpt-4o-mini").strip()
    else:
        # For known presets, ignore possibly stale frontend overrides.
        base = (preset["base"] or "").strip().rstrip("/")
        model = (preset["model"] or "gpt-4o-mini").strip()
    key = payload.api_key.strip()

    if not base:
        return CloudValidateResponse(ok=False, code="invalid_base", message="缺少 API Base URL，请选择平台或填写地址。")
    if not key:
        return CloudValidateResponse(ok=False, code="invalid_api_key", message="API Key 不能为空。")

    try:
        from litellm import acompletion

        await acompletion(
            model=f"openai/{model}",
            messages=[{"role": "user", "content": "ping"}],
            api_base=base,
            api_key=key,
            timeout=25,
            max_tokens=1,
        )
        return CloudValidateResponse(ok=True, code="ok", message="API Key 验证成功。")
    except Exception as exc:
        if _is_auth_error(exc):
            return CloudValidateResponse(ok=False, code="auth_failed", message="API Key 无效、过期，或无该模型权限。")
        if _is_timeout_error(exc):
            return CloudValidateResponse(ok=False, code="timeout", message="验证超时，请检查网络后重试。")
        if _is_connection_error(exc):
            return CloudValidateResponse(ok=False, code="connection_error", message="无法连接云端接口，请检查网络或 API Base。")
        logger.exception(
            "Cloud validate failed cloud_preset=%s base=%s model=%s err=%s",
            payload.cloud_preset,
            base,
            model,
            str(exc),
        )
        return CloudValidateResponse(ok=False, code="validate_failed", message="验证失败，请检查平台、模型和密钥配置。")
