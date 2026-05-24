# NexusAgent Enterprise

> 企业级多智能体协同平台（中文主文档）  
> Enterprise Multi-Agent Collaboration Platform (English summary included)

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Python](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115+-009688?logo=fastapi&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=nextdotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5+-3178C6?logo=typescript&logoColor=white)

## 项目简介

`NexusAgent Enterprise` 是一个面向企业知识工作场景的端到端 AI 协同系统，支持：
- 多 Agent 协同编排（可动态增删改、启停、排序）
- 文档 RAG 检索增强（pgvector + 回退检索）
- 本地模型（Ollama）与云端 API 混合调用
- 会话记忆、历史导出、工作流状态持久化
- 企业化前端工作台（设置弹窗 + 分栏管理）

适用于报表分析、运营助理、知识库问答、内部流程协同等真实业务场景。

---

## 技术特点

### 1) 动态多 Agent 管线
- 前端可配置 Agent 数量、名称、执行模式、Prompt、顺序、启用状态
- 执行模式：`router` / `rag` / `generator` / `review` / `custom`
- 角色身份由 Prompt 驱动，不绑定固定职业标签
- 后端按配置顺序逐步执行并实时回传状态

### 2) RAG 闭环能力
- 支持 `pdf/md/txt/docx/xlsx/xls` 上传入库
- 文档切分、向量化、持久化存储
- 检索策略：
  - 优先 `pgvector` 原生向量检索
  - 无向量扩展时自动回退 JSON embedding + 余弦相似度
- 已修复空输出兜底问题，避免仅返回“任务已完成”

### 3) 本地 + 云端模型协同
- 本地 Ollama 模型发现与选择
- 云端 API Key 验证（鉴权失败/超时/连接失败分类提示）
- 云端不可用时自动降级本地模型

### 4) 企业级会话能力
- SSE 流式响应
- 会话历史持久化
- 会话导出（JSON / Markdown）
- 会话删除与后端数据同步
- Agent 执行轨迹可观测

### 5) 前端体验与可运营性
- 设置集中在弹窗（模型与 API / Agent 管理 / 文档与 RAG）
- 主工作区与会话区解耦，层次更清晰
- 响应式布局、统一视觉系统、可持续扩展

---

## 技术路线

### 后端路线（FastAPI + 动态工作流）

```text
Client Request
  -> FastAPI SSE Endpoint
  -> Load Session Context (PostgreSQL)
  -> Execute Dynamic Agent Pipeline
      -> Router / RAG / Generator / Review / Custom
      -> LLM Gateway (Ollama or Cloud API)
      -> Retriever (pgvector or fallback)
  -> Stream Tokens + Agent Status
  -> Persist History + Checkpoint
```

核心模块：
- `backend/app/main.py`：应用启动、生命周期、健康检查
- `backend/app/routers/chat.py`：聊天流、历史、模型、云端校验
- `backend/app/routers/document.py`：文档上传、入库任务、状态查询
- `backend/app/application/workflows/langgraph_core.py`：动态 Agent 运行时
- `backend/app/infrastructure/db/*`：异步数据库会话与状态持久化

### 前端路线（Next.js + Zustand）

```text
UI Workspace
  -> Zustand Store (session/model/agent state)
  -> SSE Parser
  -> Message Timeline + Agent Trace
  -> Settings Modal (Tabbed Config)
```

核心模块：
- `frontend/app/page.tsx`：工作台与设置弹窗
- `frontend/store/chatStore.ts`：状态管理与接口编排
- `frontend/components/chat/*`：消息渲染
- `frontend/components/ui/*`：通用 UI 组件

---

## 已具备功能

- [x] 多会话管理（新建、切换、删除）
- [x] 会话历史持久化与读取
- [x] 会话导出（Markdown / JSON）
- [x] 多 Agent 动态编排（增删改、启停、排序）
- [x] Agent Prompt 可配置
- [x] 文档上传入库与任务状态跟踪
- [x] RAG 检索增强问答
- [x] 本地 Ollama 模型调用
- [x] 云端 API 验证与调用
- [x] SSE 实时流式输出
- [x] 错误分类与降级容错

---

## 快速启动

### 1. 启动后端

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload
```

后端健康检查：

```text
http://127.0.0.1:8001/healthz
```

### 2. 启动前端

```powershell
cd frontend
Copy-Item .env.local.example .env.local
npm install
npm run dev
```

前端访问：

```text
http://127.0.0.1:3000
```

### 3. 可选依赖
- Ollama（本地生成与嵌入）
- PostgreSQL + pgvector（推荐）

---

## 配置说明

后端 `.env` 示例：

```env
POSTGRES_DSN=postgresql+asyncpg://postgres:postgres@127.0.0.1:5432/tech_copilot
LLM_DEFAULT_MODEL=ollama/gemma3:4b
LITELLM_API_BASE=
LITELLM_API_KEY=
```

前端 `.env.local` 示例：

```env
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8001
```

---

## 主要 API

- `POST /api/chat/stream`：SSE 聊天流（支持动态 agent 配置）
- `GET /api/history/{session_id}`：会话历史
- `GET /api/history/{session_id}/export?format=json|markdown`：导出历史
- `DELETE /api/history/{session_id}`：删除会话
- `POST /api/upload`：上传文档
- `GET /api/upload/{task_id}`：查询入库任务状态
- `GET /api/models/local`：查询本地模型
- `POST /api/cloud/validate`：云端 API Key 校验

---

## 项目结构

```text
backend/
  app/
    application/workflows/
    routers/
    infrastructure/
    core/
frontend/
  app/
  store/
  components/
```

---

## English Summary

NexusAgent Enterprise is an enterprise-ready multi-agent platform with dynamic agent orchestration, document RAG, local/cloud model routing, persistent chat memory, and modern workspace UX. It is designed for real business use cases and supports configurable pipelines, robust retrieval fallback, and production-oriented streaming interactions.

---

## License

MIT
