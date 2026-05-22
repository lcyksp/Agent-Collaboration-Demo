"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

type Role = "user" | "assistant" | "system";

export type ChatMessage = {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
};

export type ChatSession = {
  id: string;
  title: string;
};

export type AgentStatus = {
  agent: string;
  status: string;
  content: string;
};

export type AgentTraceItem = AgentStatus & {
  at: number;
};

export type ModelConfig = {
  provider: "local" | "cloud";
  cloudPreset: "aliyun" | "openai" | "custom";
  apiKey: string;
  apiBase: string;
  cloudModel: string;
  localModel: string;
};

export type SavedApiKey = {
  id: string;
  name: string;
  apiKey: string;
  cloudPreset: ModelConfig["cloudPreset"];
  apiBase: string;
  cloudModel: string;
  createdAt: number;
};

type ChatState = {
  messages: ChatMessage[];
  sessionMessages: Record<string, ChatMessage[]>;
  sessionMeta: Record<string, ChatSession>;
  sessionAgentTrace: Record<string, AgentTraceItem[]>;
  activeSessionId: string;
  isGenerating: boolean;
  currentAgentStatus: AgentStatus | null;
  agentTrace: AgentTraceItem[];
  sessionList: string[];
  modelConfig: ModelConfig;
  savedApiKeys: SavedApiKey[];
  activeApiKeyId: string | null;
  setActiveSessionId: (sessionId: string) => void;
  loadSessionHistory: (sessionId: string) => Promise<void>;
  createNewSession: () => void;
  deleteSession: (sessionId: string) => void;
  setModelConfig: (patch: Partial<ModelConfig>) => void;
  saveCurrentApiKey: () => void;
  selectSavedApiKey: (keyId: string) => void;
  deleteSavedApiKey: (keyId: string) => void;
  sendMessage: (input: string) => Promise<void>;
  exportCurrentSession: (format: "markdown" | "json") => Promise<string>;
};

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8001";
const uid = (): string => `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const maskApiKey = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length <= 10) return `${trimmed.slice(0, 4)}****`;
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
};

const parseSSE = (buffer: string): { events: Array<{ event: string; data: string }>; rest: string } => {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: Array<{ event: string; data: string }> = [];
  for (const block of blocks) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) events.push({ event, data: dataLines.join("\n") });
  }
  return { events, rest };
};

const normalizeRole = (role: string): Role => {
  if (role === "assistant" || role === "system") return role;
  return "user";
};

const fromHistoryMessage = (role: string, content: string, createdAt?: string): ChatMessage => ({
  id: uid(),
  role: normalizeRole(role),
  content,
  createdAt: createdAt ? new Date(createdAt).getTime() : Date.now(),
});

const summarizeTitle = (messages: ChatMessage[]): string => {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "新对话";
  const text = firstUser.content.replace(/\s+/g, " ").trim();
  return text.length > 18 ? `${text.slice(0, 18)}...` : text;
};

const formatTime = (ts: number): string => new Date(ts).toLocaleString("zh-CN", { hour12: false });

const appendTraceItem = (trace: AgentTraceItem[], next: AgentStatus): AgentTraceItem[] => {
  const item: AgentTraceItem = { ...next, at: Date.now() };
  const last = trace[trace.length - 1];
  if (last && last.agent === item.agent && last.status === item.status && last.content === item.content) {
    return trace;
  }
  return [...trace, item];
};

const normalizeErrorMessage = (message: string): string => {
  const lower = message.toLowerCase();
  if (lower.includes("timeout") || lower.includes("timed out")) return "请求超时，请稍后重试";
  if (lower.includes("missing credentials")) return "云端 API Key 缺失或无效，请检查设置";
  if (lower.includes("incorrect api key") || lower.includes("invalid_api_key") || lower.includes("authenticationerror"))
    return "API Key 无效、过期或无模型权限";
  if (lower.includes("connection error") || lower.includes("connect error")) return "云端连接失败，请检查网络、平台选择和 API Key";
  return message;
};

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      messages: [],
      sessionMessages: {},
      sessionMeta: {},
      sessionAgentTrace: {},
      activeSessionId: "session-default",
      isGenerating: false,
      currentAgentStatus: null,
      agentTrace: [],
      sessionList: [],
      savedApiKeys: [],
      activeApiKeyId: null,
      modelConfig: {
        provider: "local",
        cloudPreset: "aliyun",
        apiKey: "",
        apiBase: "",
        cloudModel: "",
        localModel: "gemma3:4b",
      },

      setActiveSessionId: (sessionId: string) =>
        set((state) => ({
          activeSessionId: sessionId,
          messages: state.sessionMessages[sessionId] ?? [],
          agentTrace: state.sessionAgentTrace[sessionId] ?? [],
          sessionList: state.sessionList.includes(sessionId) ? state.sessionList : [sessionId, ...state.sessionList],
        })),

      createNewSession: () => {
        const sessionId = `session-${Date.now()}`;
        set((state) => ({
          activeSessionId: sessionId,
          messages: [],
          agentTrace: [],
          sessionList: [sessionId, ...state.sessionList.filter((sid) => sid !== sessionId)],
          sessionMeta: { ...state.sessionMeta, [sessionId]: { id: sessionId, title: "新对话" } },
        }));
      },

      loadSessionHistory: async (sessionId: string) => {
        const cached = get().sessionMessages[sessionId];
        if (cached && cached.length > 0) {
          if (get().activeSessionId === sessionId) set({ messages: cached });
          return;
        }

        try {
          const response = await fetch(`${API_BASE_URL}/api/history/${encodeURIComponent(sessionId)}`);
          if (!response.ok) return;

          const data = await response.json();
          const historyMessages: ChatMessage[] = Array.isArray(data?.messages)
            ? data.messages.map((m: any) => fromHistoryMessage(String(m.role ?? "user"), String(m.content ?? ""), m.created_at))
            : [];

          set((state) => ({
            sessionMessages: { ...state.sessionMessages, [sessionId]: historyMessages },
            sessionMeta: {
              ...state.sessionMeta,
              [sessionId]: state.sessionMeta[sessionId] ?? { id: sessionId, title: summarizeTitle(historyMessages) },
            },
            messages: state.activeSessionId === sessionId ? historyMessages : state.messages,
          }));
        } catch {
          return;
        }
      },

      deleteSession: (sessionId: string) => {
        void fetch(`${API_BASE_URL}/api/history/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(() => undefined);
        set((state) => {
          const nextList = state.sessionList.filter((sid) => sid !== sessionId);
          const deletingActive = state.activeSessionId === sessionId;
          const nextActive = deletingActive ? nextList[0] ?? "session-default" : state.activeSessionId;
          const nextSessionMessages = Object.fromEntries(Object.entries(state.sessionMessages).filter(([sid]) => sid !== sessionId));

          return {
            sessionList: nextList,
            activeSessionId: nextActive,
            sessionMessages: nextSessionMessages,
            sessionMeta: Object.fromEntries(Object.entries(state.sessionMeta).filter(([sid]) => sid !== sessionId)),
            sessionAgentTrace: Object.fromEntries(Object.entries(state.sessionAgentTrace).filter(([sid]) => sid !== sessionId)),
            messages: deletingActive ? nextSessionMessages[nextActive] ?? [] : state.messages,
            agentTrace: deletingActive ? state.sessionAgentTrace[nextActive] ?? [] : state.agentTrace,
          };
        });
      },

      setModelConfig: (patch: Partial<ModelConfig>) => set((state) => ({ modelConfig: { ...state.modelConfig, ...patch } })),

      saveCurrentApiKey: () =>
        set((state) => {
          const apiKey = state.modelConfig.apiKey.trim();
          if (!apiKey) return state;

          const nextKey: SavedApiKey = {
            id: state.activeApiKeyId && state.savedApiKeys.some((item) => item.id === state.activeApiKeyId) ? state.activeApiKeyId : uid(),
            name: `${state.modelConfig.cloudPreset} · ${maskApiKey(apiKey)}`,
            apiKey,
            cloudPreset: state.modelConfig.cloudPreset,
            apiBase: state.modelConfig.apiBase.trim(),
            cloudModel: state.modelConfig.cloudModel.trim(),
            createdAt: Date.now(),
          };

          const filtered = state.savedApiKeys.filter((item) => item.id !== nextKey.id && item.apiKey !== nextKey.apiKey);
          return {
            savedApiKeys: [nextKey, ...filtered],
            activeApiKeyId: nextKey.id,
          };
        }),

      selectSavedApiKey: (keyId: string) =>
        set((state) => {
          const selected = state.savedApiKeys.find((item) => item.id === keyId);
          if (!selected) return state;
          return {
            activeApiKeyId: selected.id,
            modelConfig: {
              ...state.modelConfig,
              cloudPreset: selected.cloudPreset,
              apiKey: selected.apiKey,
              apiBase: selected.apiBase,
              cloudModel: selected.cloudModel,
            },
          };
        }),

      deleteSavedApiKey: (keyId: string) =>
        set((state) => {
          const nextKeys = state.savedApiKeys.filter((item) => item.id !== keyId);
          const deletedActive = state.activeApiKeyId === keyId;
          const nextActive = deletedActive ? nextKeys[0] ?? null : state.activeApiKeyId;
          const nextSelected = nextActive ? nextKeys.find((item) => item.id === nextActive) ?? null : null;
          return {
            savedApiKeys: nextKeys,
            activeApiKeyId: typeof nextActive === "string" ? nextActive : null,
            modelConfig: nextSelected
              ? {
                  ...state.modelConfig,
                  cloudPreset: nextSelected.cloudPreset,
                  apiKey: nextSelected.apiKey,
                  apiBase: nextSelected.apiBase,
                  cloudModel: nextSelected.cloudModel,
                }
              : deletedActive
                ? { ...state.modelConfig, apiKey: "", apiBase: "", cloudModel: "" }
                : state.modelConfig,
          };
        }),

      sendMessage: async (input: string) => {
        const content = input.trim();
        if (!content || get().isGenerating) return;

        const sessionId = get().activeSessionId;
        const cfg = get().modelConfig;
        const userMsg: ChatMessage = { id: uid(), role: "user", content, createdAt: Date.now() };
        const assistantMsg: ChatMessage = { id: uid(), role: "assistant", content: "", createdAt: Date.now() };
        const initialTrace: AgentTraceItem[] = [
          { agent: "Router Agent", status: "routing", content: "正在分发任务...", at: Date.now() },
        ];

        set((state) => {
          const nextSession = [...(state.sessionMessages[sessionId] ?? []), userMsg, assistantMsg];
          return {
            isGenerating: true,
            currentAgentStatus: initialTrace[0],
            messages: nextSession,
            sessionMessages: { ...state.sessionMessages, [sessionId]: nextSession },
            sessionMeta: {
              ...state.sessionMeta,
              [sessionId]: state.sessionMeta[sessionId] ?? { id: sessionId, title: "新对话" },
            },
            agentTrace: initialTrace,
            sessionAgentTrace: { ...state.sessionAgentTrace, [sessionId]: initialTrace },
            sessionList: state.sessionList.includes(sessionId) ? state.sessionList : [sessionId, ...state.sessionList],
          };
        });

        try {
          const controller = new AbortController();
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const resetTimeout = () => {
            if (timeoutId) clearTimeout(timeoutId);
            timeoutId = setTimeout(() => controller.abort("timeout"), 180000);
          };
          resetTimeout();
          const response = await fetch(`${API_BASE_URL}/api/chat/stream`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              session_id: sessionId,
              user_input: content,
              model_provider: cfg.provider,
              cloud_preset: cfg.cloudPreset,
              api_key: cfg.apiKey || null,
              api_base: cfg.apiBase || null,
              cloud_model: cfg.cloudModel || null,
              local_model: cfg.localModel || null,
            }),
          });

          if (!response.ok || !response.body) throw new Error(`SSE request failed: ${response.status}`);

          const reader = response.body.getReader();
          const decoder = new TextDecoder("utf-8");
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const { events, rest } = parseSSE(buffer);
            buffer = rest;

            for (const evt of events) {
              let payload: any = {};
              try {
                payload = JSON.parse(evt.data);
              } catch {
                continue;
              }

              if (evt.event === "agent_status") {
                const nextStatus = payload as AgentStatus;
                set((state) => {
                  const nextTrace = appendTraceItem(state.agentTrace, nextStatus);
                  return {
                    currentAgentStatus: nextStatus,
                    agentTrace: nextTrace,
                    sessionAgentTrace: { ...state.sessionAgentTrace, [sessionId]: nextTrace },
                  };
                });
                resetTimeout();
                continue;
              }

              if (evt.event === "chunk" && typeof payload.chunk === "string") {
                set((state) => {
                  const nextSession = (state.sessionMessages[sessionId] ?? []).map((m) =>
                    m.id === assistantMsg.id ? { ...m, content: `${m.content}${payload.chunk}` } : m
                  );
                  return {
                    messages: state.activeSessionId === sessionId ? nextSession : state.messages,
                    sessionMessages: { ...state.sessionMessages, [sessionId]: nextSession },
                    sessionMeta: {
                      ...state.sessionMeta,
                      [sessionId]: { id: sessionId, title: summarizeTitle(nextSession) },
                    },
                  };
                });
                resetTimeout();
                continue;
              }

              if (evt.event === "error") throw new Error(payload.message ?? "Unknown stream error");
              if (evt.event === "done") {
                set((state) => {
                  const doneStatus: AgentStatus = { agent: "Review Agent", status: "done", content: "任务完成" };
                  const nextTrace = appendTraceItem(state.agentTrace, doneStatus);
                  return {
                    currentAgentStatus: doneStatus,
                    agentTrace: nextTrace,
                    sessionAgentTrace: { ...state.sessionAgentTrace, [sessionId]: nextTrace },
                  };
                });
                if (timeoutId) clearTimeout(timeoutId);
              }
            }
            if (timeoutId) clearTimeout(timeoutId);
          }
        } catch (error) {
          const message = normalizeErrorMessage(error instanceof Error ? error.message : "生成失败");
          set((state) => {
            const nextSession = (state.sessionMessages[sessionId] ?? []).map((m) =>
              m.id === assistantMsg.id ? { ...m, content: `\n\n> [Error] ${message}` } : m
            );
            const errorStatus: AgentStatus = { agent: "System", status: "error", content: message };
            const nextTrace = appendTraceItem(state.agentTrace, errorStatus);
            return {
              messages: state.activeSessionId === sessionId ? nextSession : state.messages,
              sessionMessages: { ...state.sessionMessages, [sessionId]: nextSession },
              sessionMeta: {
                ...state.sessionMeta,
                [sessionId]: { id: sessionId, title: summarizeTitle(nextSession) },
              },
              sessionAgentTrace: { ...state.sessionAgentTrace, [sessionId]: nextTrace },
              currentAgentStatus: errorStatus,
              agentTrace: nextTrace,
            };
          });
        } finally {
          set({ isGenerating: false });
        }
      },

      exportCurrentSession: async (format: "markdown" | "json") => {
        const { activeSessionId, messages } = get();
        try {
          const response = await fetch(
            `${API_BASE_URL}/api/history/${encodeURIComponent(activeSessionId)}/export?format=${format}`
          );
          if (response.ok) {
            return await response.text();
          }
        } catch {
          // fallback to local export
        }
        const title = summarizeTitle(messages);
        if (format === "json") {
          return JSON.stringify(
            {
              sessionId: activeSessionId,
              title,
              exportedAt: new Date().toISOString(),
              messageCount: messages.length,
              messages,
            },
            null,
            2
          );
        }
        const lines = [
          `# 对话导出`,
          "",
          `- 会话 ID: ${activeSessionId}`,
          `- 标题: ${title}`,
          `- 导出时间: ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
          `- 消息数: ${messages.length}`,
          "",
          "---",
          "",
        ];
        for (const m of messages) {
          lines.push(`## ${m.role.toUpperCase()} · ${formatTime(m.createdAt)}`);
          lines.push(m.content);
          lines.push("");
        }
        return lines.join("\n");
      },
    }),
    {
      name: "tech-copilot-chat-store",
      partialize: (state) => ({
        activeSessionId: state.activeSessionId,
        sessionMessages: state.sessionMessages,
        sessionMeta: state.sessionMeta,
        sessionAgentTrace: state.sessionAgentTrace,
        sessionList: state.sessionList,
        savedApiKeys: state.savedApiKeys,
        activeApiKeyId: state.activeApiKeyId,
        modelConfig: {
          ...state.modelConfig,
          apiKey: "",
        },
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const mergedModelConfig: ModelConfig = {
          ...(state.modelConfig ?? {}),
          provider: state.modelConfig?.provider ?? "local",
          cloudPreset: state.modelConfig?.cloudPreset ?? "aliyun",
          apiKey: state.modelConfig?.apiKey ?? "",
          apiBase: state.modelConfig?.apiBase ?? "",
          cloudModel: state.modelConfig?.cloudModel ?? "",
          localModel: state.modelConfig?.localModel ?? "gemma3:4b",
        };
        state.modelConfig = mergedModelConfig;
        state.messages = state.sessionMessages[state.activeSessionId] ?? [];
        state.sessionMeta = state.sessionMeta ?? {};
        state.agentTrace = state.sessionAgentTrace?.[state.activeSessionId] ?? [];
        state.savedApiKeys = state.savedApiKeys ?? [];
        state.activeApiKeyId = state.activeApiKeyId ?? null;
        const activeKey = state.activeApiKeyId ? state.savedApiKeys.find((item) => item.id === state.activeApiKeyId) : null;
        if (activeKey) {
          state.modelConfig = {
            ...state.modelConfig,
            cloudPreset: activeKey.cloudPreset,
            apiKey: activeKey.apiKey,
            apiBase: activeKey.apiBase,
            cloudModel: activeKey.cloudModel,
          };
        }
      },
    }
  )
);
