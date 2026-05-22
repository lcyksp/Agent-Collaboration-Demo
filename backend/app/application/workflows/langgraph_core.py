from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Literal, Protocol, TypedDict

from langgraph.graph import END, START, StateGraph


class AgentStatus(TypedDict):
    agent: str
    status: str
    content: str


class RetrievedDoc(TypedDict):
    source: str
    content: str
    score: float


class GraphState(TypedDict, total=False):
    session_id: str
    user_input: str
    model_provider: Literal["local", "cloud"]
    cloud_preset: Literal["aliyun", "openai", "custom"]
    api_key: str
    api_base: str
    cloud_model: str
    local_model: str
    router_prompt: str
    rag_prompt: str
    code_prompt: str
    review_prompt: str
    route: Literal["rag", "code", "direct"]
    needs_rag: bool
    retrieved_docs: list[RetrievedDoc]
    rag_context: str
    draft_answer: str
    final_answer: str
    review_passed: bool
    rewrite_count: int
    statuses: list[AgentStatus]


class ModelGateway(Protocol):
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
        """Unified model call interface (LiteLLM/ChatModel adapter)."""


class VectorRetriever(Protocol):
    async def search(self, *, query: str, top_k: int = 5) -> list[RetrievedDoc]:
        """Vector search interface for pgvector-backed retrieval."""


@dataclass(slots=True)
class GraphRuntime:
    model_gateway: ModelGateway
    retriever: VectorRetriever
    max_rewrite_rounds: int = 2


ROUTER_SYSTEM_PROMPT = (
    "你是 Router Agent（调度中枢）。"
    "分析用户输入并只输出 JSON："
    '{"route":"rag|code|direct","reason":"...","needs_rag":true|false}。'
)

RAG_SYSTEM_PROMPT = (
    "你是 RAG Expert Agent（知识检索专家）。"
    "仅基于检索上下文回答，不得捏造。"
    "如果检索不到相关信息，必须明确写出“未检索到可信资料”。"
    "输出应包含：结论 + 引用来源列表。"
)

CODE_ARCH_SYSTEM_PROMPT = (
    "你是 Code Architect Agent（全栈开发专家）。"
    "基于需求和可用上下文，输出高内聚低耦合的实现方案与代码。"
    "请包含：1) 架构思路（简短） 2) 关键代码。"
)

REVIEW_SYSTEM_PROMPT = (
    "你是 Review Agent（审查与测试专家）。"
    "检查逻辑漏洞、安全风险、API 规范一致性。"
    "只输出 JSON："
    '{"approved":true|false,"issues":["..."],"suggestion":"..."}。'
)


def _append_status(state: GraphState, agent: str, status: str, content: str) -> list[AgentStatus]:
    statuses = list(state.get("statuses", []))
    statuses.append({"agent": agent, "status": status, "content": content})
    return statuses


def _safe_json(raw: str, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        return json.loads(raw)
    except Exception:
        return fallback


async def router_node(state: GraphState, runtime: GraphRuntime) -> GraphState:
    router_prompt = state.get("router_prompt") or ROUTER_SYSTEM_PROMPT
    result = await runtime.model_gateway.ainvoke(
        system_prompt=router_prompt,
        user_prompt=f"用户输入：{state['user_input']}",
        provider=state.get("model_provider", "cloud"),
        cloud_preset=state.get("cloud_preset", "aliyun"),
        api_key=state.get("api_key"),
        api_base=state.get("api_base"),
        cloud_model=state.get("cloud_model"),
        local_model=state.get("local_model"),
    )
    parsed = _safe_json(result, {"route": "direct", "needs_rag": False, "reason": "fallback"})
    route = parsed.get("route", "direct")
    if route not in {"rag", "code", "direct"}:
        route = "direct"

    return {
        "route": route,
        "needs_rag": bool(parsed.get("needs_rag", route == "rag")),
        "statuses": _append_status(state, "Router Agent", "routed", f"route={route}"),
    }


async def rag_expert_node(state: GraphState, runtime: GraphRuntime) -> GraphState:
    rag_prompt = state.get("rag_prompt") or RAG_SYSTEM_PROMPT
    docs = await runtime.retriever.search(query=state["user_input"], top_k=5)
    if not docs:
        context = "未检索到可信资料。"
        rag_answer = "未检索到可信资料，无法给出基于知识库的结论。"
    else:
        refs = "\n".join([f"- {d['source']} (score={d['score']:.4f})" for d in docs])
        snippets = "\n\n".join([f"[{d['source']}] {d['content']}" for d in docs])
        context = f"检索片段：\n{snippets}\n\n引用来源：\n{refs}"
        rag_answer = await runtime.model_gateway.ainvoke(
            system_prompt=rag_prompt,
            user_prompt=f"问题：{state['user_input']}\n\n{context}",
            provider=state.get("model_provider", "cloud"),
            cloud_preset=state.get("cloud_preset", "aliyun"),
            api_key=state.get("api_key"),
            api_base=state.get("api_base"),
            cloud_model=state.get("cloud_model"),
            local_model=state.get("local_model"),
        )

    return {
        "retrieved_docs": docs,
        "rag_context": context,
        "draft_answer": rag_answer,
        "statuses": _append_status(state, "RAG Expert Agent", "searching", "正在检索并整理引用来源"),
    }


async def code_architect_node(state: GraphState, runtime: GraphRuntime) -> GraphState:
    code_prompt = state.get("code_prompt") or CODE_ARCH_SYSTEM_PROMPT
    context = state.get("rag_context", "")
    base = f"用户需求：{state['user_input']}"
    if context:
        base += f"\n\nRAG 上下文：\n{context}"
    if state.get("draft_answer"):
        base += f"\n\n现有草案：\n{state['draft_answer']}"

    draft = await runtime.model_gateway.ainvoke(
        system_prompt=code_prompt,
        user_prompt=base,
        provider=state.get("model_provider", "cloud"),
        cloud_preset=state.get("cloud_preset", "aliyun"),
        api_key=state.get("api_key"),
        api_base=state.get("api_base"),
        cloud_model=state.get("cloud_model"),
        local_model=state.get("local_model"),
    )
    return {
        "draft_answer": draft,
        "statuses": _append_status(state, "Code Architect Agent", "coding", "已生成架构与代码草案"),
    }


async def review_node(state: GraphState, runtime: GraphRuntime) -> GraphState:
    review_prompt = state.get("review_prompt") or REVIEW_SYSTEM_PROMPT
    review_raw = await runtime.model_gateway.ainvoke(
        system_prompt=review_prompt,
        user_prompt=f"请审查以下输出：\n{state.get('draft_answer', '')}",
        provider=state.get("model_provider", "cloud"),
        cloud_preset=state.get("cloud_preset", "aliyun"),
        api_key=state.get("api_key"),
        api_base=state.get("api_base"),
        cloud_model=state.get("cloud_model"),
        local_model=state.get("local_model"),
    )
    parsed = _safe_json(review_raw, {"approved": True, "issues": [], "suggestion": ""})
    approved = bool(parsed.get("approved", True))
    issues = parsed.get("issues", [])
    suggestion = parsed.get("suggestion", "")
    rewrite_count = int(state.get("rewrite_count", 0))

    if approved:
        final = state.get("draft_answer", "")
        status_msg = "审核通过，输出最终结果"
    else:
        rewrite_count += 1
        final = state.get("final_answer", "")
        issue_text = "; ".join([str(i) for i in issues]) if isinstance(issues, list) else str(issues)
        state["user_input"] = f"{state['user_input']}\n\n[Review反馈]{issue_text}\n建议：{suggestion}"
        status_msg = "发现问题，返回重写"

    return {
        "review_passed": approved,
        "rewrite_count": rewrite_count,
        "final_answer": final,
        "statuses": _append_status(state, "Review Agent", "reviewing", status_msg),
    }


def route_from_router(state: GraphState) -> Literal["rag_expert", "code_architect", "end"]:
    route = state.get("route", "direct")
    if route == "rag":
        return "rag_expert"
    if route == "code":
        return "code_architect"
    return "end"


def route_from_review(state: GraphState, max_rewrite_rounds: int) -> Literal["code_architect", "end"]:
    if state.get("review_passed", False):
        return "end"
    if int(state.get("rewrite_count", 0)) >= max_rewrite_rounds:
        return "end"
    return "code_architect"


def build_graph(runtime: GraphRuntime, checkpointer: Any | None = None) -> Any:
    graph = StateGraph(GraphState)

    async def router_entry(state: GraphState) -> GraphState:
        return await router_node(state, runtime)

    async def rag_entry(state: GraphState) -> GraphState:
        return await rag_expert_node(state, runtime)

    async def code_entry(state: GraphState) -> GraphState:
        return await code_architect_node(state, runtime)

    async def review_entry(state: GraphState) -> GraphState:
        return await review_node(state, runtime)

    graph.add_node("router", router_entry)
    graph.add_node("rag_expert", rag_entry)
    graph.add_node("code_architect", code_entry)
    graph.add_node("review", review_entry)

    graph.add_edge(START, "router")
    graph.add_conditional_edges(
        "router",
        route_from_router,
        {"rag_expert": "rag_expert", "code_architect": "code_architect", "end": END},
    )
    graph.add_edge("rag_expert", "code_architect")
    graph.add_edge("code_architect", "review")
    graph.add_conditional_edges(
        "review",
        lambda s: route_from_review(s, runtime.max_rewrite_rounds),
        {"code_architect": "code_architect", "end": END},
    )

    return graph.compile(checkpointer=checkpointer) if checkpointer is not None else graph.compile()
