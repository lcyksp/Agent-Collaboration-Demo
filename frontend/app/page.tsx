"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, Paperclip, Plus, Save, Send, Settings, Sparkles, Trash2, X } from "lucide-react";

import { MessageBubble } from "@/components/chat/message-bubble";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/components/ui/use-toast";
import { AgentConfig, AgentKind, useChatStore } from "@/store/chatStore";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8001";

type SettingsTab = "model" | "agents" | "rag";

const defaultPromptByKind: Record<AgentKind, string> = {
  router:
    "你是 Router Agent（调度中枢）。分析用户输入并只输出 JSON：{\"route\":\"rag|code|direct\",\"reason\":\"...\",\"needs_rag\":true|false}。",
  rag:
    "你是 RAG Expert Agent（知识检索专家）。仅基于检索上下文回答，不得捏造。如果检索不到相关信息，必须明确写出“未检索到可信资料”。输出应包含：结论 + 引用来源列表。",
  generator:
    "你是 Code Architect Agent（全栈开发专家）。基于需求和可用上下文，输出高内聚低耦合的实现方案与代码。请包含：1) 架构思路（简短） 2) 关键代码。",
  review:
    "你是 Review Agent（审查与测试专家）。检查逻辑漏洞、安全风险、API 规范一致性。只输出 JSON：{\"approved\":true|false,\"issues\":[\"...\"],\"suggestion\":\"...\"}。",
  custom: "你是一个通用 Agent，请根据用户需求给出有用、明确、可执行的回答。",
};

const normalizeAgents = (agents: AgentConfig[]): AgentConfig[] =>
  [...agents]
    .sort((a, b) => a.order - b.order)
    .map((a, idx) => ({ ...a, order: idx }));

export default function Page() {
  const {
    messages,
    activeSessionId,
    isGenerating,
    currentAgentStatus,
    agentTrace,
    sessionList,
    sessionMeta,
    sendMessage,
    exportCurrentSession,
    createNewSession,
    setActiveSessionId,
    loadSessionHistory,
    deleteSession,
    modelConfig,
    setModelConfig,
    agentConfigs,
    setAgentConfigs,
    savedApiKeys,
    activeApiKeyId,
    saveCurrentApiKey,
    selectSavedApiKey,
    deleteSavedApiKey,
  } = useChatStore();

  const [input, setInput] = useState("");
  const [uploading, setUploading] = useState(false);
  const [localModels, setLocalModels] = useState<string[]>([]);
  const [localModelsLoaded, setLocalModelsLoaded] = useState(false);
  const [showTrace, setShowTrace] = useState(true);
  const [validatingKey, setValidatingKey] = useState(false);
  const [apiKeyValidation, setApiKeyValidation] = useState<null | { kind: "success" | "error"; message: string }>(null);
  const [uploadStatus, setUploadStatus] = useState<null | { taskId: string; status: "queued" | "running" | "done" | "failed"; message?: string }>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("model");
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (activeSessionId === "session-default") {
      const sid = `session-${Date.now()}`;
      setActiveSessionId(sid);
      void loadSessionHistory(sid);
    }
  }, [activeSessionId, setActiveSessionId, loadSessionHistory]);

  useEffect(() => {
    if (activeSessionId && activeSessionId !== "session-default") {
      void loadSessionHistory(activeSessionId);
    }
  }, [activeSessionId, loadSessionHistory]);

  const loadLocalModels = async () => {
    try {
      const resp = await fetch(`${API_BASE_URL}/api/models/local`);
      if (!resp.ok) return;
      const data = await resp.json();
      const models: string[] = Array.isArray(data?.models)
        ? (data.models as unknown[]).filter((m: unknown): m is string => typeof m === "string")
        : [];
      const uniqueModels: string[] = [...new Set(models)];
      if (uniqueModels.length === 0) return;
      setLocalModels(uniqueModels);
      if (!uniqueModels.includes(modelConfig.localModel)) {
        setModelConfig({ localModel: uniqueModels[0] });
      }
      setLocalModelsLoaded(true);
    } catch {
      setLocalModelsLoaded(true);
    }
  };

  useEffect(() => {
    void loadLocalModels();
  }, []);

  const canSend = useMemo(() => input.trim().length > 0 && !isGenerating, [input, isGenerating]);

  const handleSend = async (e: FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput("");
    await sendMessage(text);
  };

  const handleUploadClick = () => fileRef.current?.click();

  const handleUploadFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const resp = await fetch(`${API_BASE_URL}/api/upload`, { method: "POST", body: form });
      if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
      const data = await resp.json();
      setUploadStatus({ taskId: data.task_id, status: "queued" });
      toast({ title: "上传已接收", description: `任务 ID: ${data.task_id}` });
      const taskId = data.task_id as string;
      for (let i = 0; i < 300; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const sr = await fetch(`${API_BASE_URL}/api/upload/${encodeURIComponent(taskId)}`);
        if (!sr.ok) continue;
        const st = await sr.json();
        const nextStatus = (st?.status ?? "queued") as "queued" | "running" | "done" | "failed";
        setUploadStatus({ taskId, status: nextStatus, message: st?.error_message ?? undefined });
        if (nextStatus === "done") {
          toast({ title: "上传完成", description: "文档已入库，可在对话中检索。" });
          break;
        }
        if (nextStatus === "failed") {
          toast({ title: "上传失败", description: st?.error_message ?? "文档处理失败" });
          break;
        }
      }
    } catch (err) {
      setUploadStatus({ taskId: "-", status: "failed", message: err instanceof Error ? err.message : "未知错误" });
      toast({ title: "上传失败", description: err instanceof Error ? err.message : "未知错误" });
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const handleExport = async (format: "markdown" | "json") => {
    const text = await exportCurrentSession(format);
    const blob = new Blob([text], { type: format === "json" ? "application/json" : "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeSessionId}.${format === "json" ? "json" : "md"}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRefreshUploadStatus = async () => {
    if (!uploadStatus?.taskId || uploadStatus.taskId === "-") return;
    try {
      const sr = await fetch(`${API_BASE_URL}/api/upload/${encodeURIComponent(uploadStatus.taskId)}`);
      if (!sr.ok) return;
      const st = await sr.json();
      const nextStatus = (st?.status ?? "queued") as "queued" | "running" | "done" | "failed";
      setUploadStatus({ taskId: uploadStatus.taskId, status: nextStatus, message: st?.error_message ?? undefined });
    } catch {
      return;
    }
  };

  const handleDeleteSession = (sid: string) => {
    const ok = window.confirm("确认删除该对话吗？此操作不可恢复。");
    if (!ok) return;
    deleteSession(sid);
  };

  const handleValidateApiKey = async () => {
    const key = modelConfig.apiKey.trim();
    if (!key) {
      setApiKeyValidation({ kind: "error", message: "请先填写 API Key" });
      toast({ title: "验证失败", description: "请先填写 API Key" });
      return;
    }
    setValidatingKey(true);
    setApiKeyValidation(null);
    try {
      const resp = await fetch(`${API_BASE_URL}/api/cloud/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cloud_preset: modelConfig.cloudPreset,
          api_key: key,
          api_base: modelConfig.apiBase || null,
          cloud_model: modelConfig.cloudModel || null,
        }),
      });
      const data = await resp.json();
      if (data?.ok) {
        setApiKeyValidation({ kind: "success", message: data?.message ?? "API Key 可用" });
        toast({ title: "验证成功", description: data?.message ?? "API Key 可用" });
      } else {
        setApiKeyValidation({ kind: "error", message: data?.message ?? "请检查 API Key 或平台配置" });
        toast({ title: "验证失败", description: data?.message ?? "请检查 API Key 或平台配置" });
      }
    } catch (err) {
      setApiKeyValidation({ kind: "error", message: err instanceof Error ? err.message : "网络异常，请重试" });
      toast({ title: "验证失败", description: err instanceof Error ? err.message : "网络异常，请重试" });
    } finally {
      setValidatingKey(false);
    }
  };

  const handleSaveApiKey = () => {
    if (!modelConfig.apiKey.trim()) {
      toast({ title: "保存失败", description: "请先填写 API Key" });
      return;
    }
    saveCurrentApiKey();
    toast({ title: "已保存", description: "API Key 已保存在本机浏览器中" });
  };

  const handleDeleteSavedApiKey = (keyId: string) => {
    const ok = window.confirm("确认删除这个已保存的 API Key 吗？");
    if (!ok) return;
    deleteSavedApiKey(keyId);
    toast({ title: "已删除", description: "API Key 已从本机列表移除" });
  };

  const addAgent = () => {
    const next = normalizeAgents([
      ...agentConfigs,
      {
        id: `agent-${Date.now()}`,
        name: `Custom Agent ${agentConfigs.length + 1}`,
        kind: "custom",
        prompt: defaultPromptByKind.custom,
        enabled: true,
        order: agentConfigs.length,
      },
    ]);
    setAgentConfigs(next);
  };

  const updateAgent = (id: string, patch: Partial<AgentConfig>) => {
    const next = normalizeAgents(
      agentConfigs.map((a) => {
        if (a.id !== id) return a;
        const merged = { ...a, ...patch };
        if (patch.kind && !patch.prompt) {
          merged.prompt = defaultPromptByKind[patch.kind];
        }
        return merged;
      })
    );
    setAgentConfigs(next);
  };

  const removeAgent = (id: string) => {
    const next = normalizeAgents(agentConfigs.filter((a) => a.id !== id));
    setAgentConfigs(next);
  };

  const moveAgent = (id: string, dir: "up" | "down") => {
    const arr = normalizeAgents(agentConfigs);
    const idx = arr.findIndex((a) => a.id === id);
    if (idx < 0) return;
    const target = dir === "up" ? idx - 1 : idx + 1;
    if (target < 0 || target >= arr.length) return;
    const clone = [...arr];
    const tmp = clone[idx];
    clone[idx] = clone[target];
    clone[target] = tmp;
    setAgentConfigs(normalizeAgents(clone));
  };

  const tabBtn = (tab: SettingsTab, label: string) => (
    <Button
      type="button"
      variant={settingsTab === tab ? "default" : "outline"}
      className="h-8 px-3 text-xs"
      onClick={() => setSettingsTab(tab)}
    >
      {label}
    </Button>
  );

  return (
    <main className="h-screen w-full bg-[radial-gradient(ellipse_at_top_right,_#dbeafe_0%,_#eef2ff_35%,_#f8fafc_100%)] p-4">
      <div className="mx-auto grid h-full max-w-[1500px] grid-cols-1 gap-4 lg:grid-cols-12">
        <Card className="flex h-full flex-col lg:col-span-3">
          <CardHeader className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Workspace</p>
                <h2 className="text-lg font-semibold text-slate-800">会话列表</h2>
              </div>
              <Sparkles className="h-4 w-4 text-amber-500" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="outline" className="h-10 text-xs font-semibold" onClick={createNewSession}>
                新建对话
              </Button>
              <Button type="button" variant="outline" className="h-10 text-xs font-semibold" onClick={() => setSettingsOpen(true)}>
                <Settings className="mr-1 h-4 w-4" />设置
              </Button>
            </div>
          </CardHeader>
          <CardContent className="flex h-full flex-col gap-3">
            <ScrollArea className="flex-1 space-y-2">
              {sessionList.length === 0 && <p className="text-xs text-slate-500">暂无历史会话</p>}
              {sessionList.map((sid) => (
                <div key={sid} className="mb-2 flex items-center gap-1">
                  <button
                    onClick={() => setActiveSessionId(sid)}
                    className={`w-full rounded-lg border px-3 py-2 text-left text-xs ${
                      sid === activeSessionId ? "border-slate-700 bg-slate-100" : "border-slate-200 bg-white"
                    }`}
                  >
                    {sessionMeta[sid]?.title ?? sid}
                  </button>
                  <Button type="button" variant="outline" className="px-2" onClick={() => handleDeleteSession(sid)} title="删除会话">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </ScrollArea>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={() => void handleExport("markdown")}>
                <Download className="mr-1 h-4 w-4" />导出 MD
              </Button>
              <Button variant="outline" onClick={() => void handleExport("json")}>
                <Download className="mr-1 h-4 w-4" />导出 JSON
              </Button>
            </div>
            {uploadStatus && (
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                <div className="font-semibold">文档入库状态</div>
                <div>任务 ID: {uploadStatus.taskId}</div>
                <div>
                  状态:
                  {uploadStatus.status === "queued" && " 排队中"}
                  {uploadStatus.status === "running" && " 处理中"}
                  {uploadStatus.status === "done" && " 已完成"}
                  {uploadStatus.status === "failed" && " 失败"}
                </div>
                {uploadStatus.message && <div className="text-rose-700">详情: {uploadStatus.message}</div>}
                <div className="mt-2">
                  <Button type="button" variant="outline" onClick={() => void handleRefreshUploadStatus()}>
                    刷新状态
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="flex h-full flex-col lg:col-span-9">
          <CardHeader className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wider text-slate-500">Current Session</p>
              <p className="text-sm font-semibold text-slate-800">{sessionMeta[activeSessionId]?.title ?? activeSessionId}</p>
            </div>
            <div className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700">
              {currentAgentStatus
                ? `${currentAgentStatus.agent} · ${currentAgentStatus.status} · ${currentAgentStatus.content}`
                : "等待输入"}
            </div>
          </CardHeader>
          <CardContent className="flex h-full flex-col gap-3">
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <button type="button" className="mb-2 text-xs font-semibold text-slate-700" onClick={() => setShowTrace((v) => !v)}>
                多 Agent 协同过程 {showTrace ? "收起" : "展开"}
              </button>
              {showTrace && (
                <div className="space-y-2 text-xs text-slate-700">
                  {agentTrace.length === 0 ? (
                    <p className="text-slate-400">这里会显示 Agent 的接力过程。</p>
                  ) : (
                    agentTrace.map((item, idx) => (
                      <div key={`${item.agent}-${item.at}-${idx}`} className="rounded border border-slate-200 px-3 py-2">
                        <div className="font-semibold">{item.agent} · {item.status}</div>
                        <div>{item.content}</div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            <ScrollArea className="h-[calc(100vh-260px)] space-y-3 pr-2">
              {messages.map((m) => (
                <div key={m.id} className="mb-3">
                  <MessageBubble message={m} />
                </div>
              ))}
            </ScrollArea>

            <form onSubmit={handleSend} className="flex items-center gap-2">
              <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="输入需求，例如：帮我基于已上传文档总结关键结论..." />
              <input ref={fileRef} type="file" accept=".pdf,.md,.markdown,.txt,.docx,.xlsx,.xls" className="hidden" onChange={handleUploadFile} />
              <Button type="button" variant="outline" onClick={handleUploadClick} disabled={uploading}>
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
              </Button>
              <Button type="submit" disabled={!canSend}>
                {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-5xl rounded-2xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <p className="text-sm font-semibold text-slate-800">系统设置</p>
              <Button type="button" variant="outline" onClick={() => setSettingsOpen(false)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-4 p-4">
              <div className="flex items-center gap-2">{tabBtn("model", "模型与 API")}{tabBtn("agents", "Agent 管理")}{tabBtn("rag", "文档与 RAG")}</div>

              {settingsTab === "model" && (
                <div className="grid gap-3">
                  <p className="text-xs font-semibold text-slate-600">模型设置</p>
                  <select className="h-9 w-full rounded border border-slate-300 px-2 text-xs" value={modelConfig.provider} onChange={(e) => setModelConfig({ provider: e.target.value as "local" | "cloud" })}>
                    <option value="local">本地 Ollama</option>
                    <option value="cloud">云端 API</option>
                  </select>

                  {modelConfig.provider === "local" ? (
                    <>
                      {localModels.length > 0 ? (
                        <select className="h-9 w-full rounded border border-slate-300 px-2 text-xs" value={modelConfig.localModel} onChange={(e) => setModelConfig({ localModel: e.target.value })}>
                          {localModels.map((model, index) => (
                            <option key={`${model}-${index}`} value={model}>{model}</option>
                          ))}
                        </select>
                      ) : (
                        <div className="rounded border border-amber-300 bg-amber-50 px-2 py-2 text-xs text-amber-800">
                          {localModelsLoaded ? "未发现本地 Ollama 模型，请先运行 `ollama pull <model>`。" : "正在加载本地模型列表..."}
                        </div>
                      )}
                      <Button type="button" variant="outline" onClick={loadLocalModels}>刷新本地模型列表</Button>
                    </>
                  ) : (
                    <>
                      <select className="h-9 w-full rounded border border-slate-300 px-2 text-xs" value={modelConfig.cloudPreset} onChange={(e) => setModelConfig({ cloudPreset: e.target.value as "aliyun" | "openai" | "custom", apiBase: "", cloudModel: "" })}>
                        <option value="aliyun">阿里云百炼</option>
                        <option value="openai">OpenAI</option>
                        <option value="custom">自定义</option>
                      </select>
                      {savedApiKeys.length > 0 && (
                        <select className="h-9 w-full rounded border border-slate-300 px-2 text-xs" value={activeApiKeyId ?? ""} onChange={(e) => selectSavedApiKey(e.target.value)}>
                          <option value="">已保存的 API Key</option>
                          {savedApiKeys.map((item) => (<option key={item.id} value={item.id}>{item.name}</option>))}
                        </select>
                      )}
                      <Input value={modelConfig.apiKey} onChange={(e) => setModelConfig({ apiKey: e.target.value })} placeholder="API Key（必填）" type="password" />
                      <div className="grid grid-cols-2 gap-2">
                        <Button type="button" variant="outline" onClick={handleValidateApiKey} disabled={validatingKey}>{validatingKey ? <Loader2 className="h-4 w-4 animate-spin" /> : "验证 API Key"}</Button>
                        <Button type="button" variant="outline" onClick={handleSaveApiKey}><Save className="mr-1 h-4 w-4" />保存到本机</Button>
                      </div>
                      {apiKeyValidation && (
                        <div className={`rounded border px-2 py-2 text-xs ${apiKeyValidation.kind === "success" ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-rose-300 bg-rose-50 text-rose-800"}`}>
                          {apiKeyValidation.kind === "success" ? "验证成功： " : "验证失败： "}{apiKeyValidation.message}
                        </div>
                      )}
                      {savedApiKeys.length > 0 && (
                        <div className="space-y-2 rounded border border-slate-200 bg-white p-2">
                          <p className="text-xs font-semibold text-slate-600">已保存列表</p>
                          {savedApiKeys.map((item) => (
                            <div key={item.id} className="flex items-center gap-2">
                              <button type="button" className={`flex-1 rounded border px-2 py-1 text-left text-xs ${item.id === activeApiKeyId ? "border-slate-700 bg-slate-100" : "border-slate-200 bg-white"}`} onClick={() => selectSavedApiKey(item.id)}>{item.name}</button>
                              <Button type="button" variant="outline" className="px-2" onClick={() => handleDeleteSavedApiKey(item.id)}>删除</Button>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {settingsTab === "agents" && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-slate-600">Agent 管理（增删改/顺序/启停）</p>
                    <Button type="button" variant="outline" onClick={addAgent}><Plus className="mr-1 h-4 w-4" />新增 Agent</Button>
                  </div>
                  <div className="max-h-[55vh] space-y-3 overflow-auto pr-2">
                    {normalizeAgents(agentConfigs).map((agent, idx, arr) => (
                      <div key={agent.id} className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
                        <div className="mb-2 grid grid-cols-12 gap-2">
                          <Input className="col-span-4" value={agent.name} onChange={(e) => updateAgent(agent.id, { name: e.target.value })} placeholder="Agent 名称" />
                          <select className="col-span-3 h-10 rounded-lg border border-slate-300 px-2 text-sm" value={agent.kind} onChange={(e) => updateAgent(agent.id, { kind: e.target.value as AgentKind })}>
                            <option value="router">router</option>
                            <option value="rag">rag</option>
                            <option value="generator">generator</option>
                            <option value="review">review</option>
                            <option value="custom">custom</option>
                          </select>
                          <label className="col-span-2 flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={agent.enabled} onChange={(e) => updateAgent(agent.id, { enabled: e.target.checked })} />启用</label>
                          <div className="col-span-3 flex gap-1">
                            <Button type="button" variant="outline" className="px-2" disabled={idx === 0} onClick={() => moveAgent(agent.id, "up")}>上移</Button>
                            <Button type="button" variant="outline" className="px-2" disabled={idx === arr.length - 1} onClick={() => moveAgent(agent.id, "down")}>下移</Button>
                            <Button type="button" variant="outline" className="px-2" onClick={() => removeAgent(agent.id)}><Trash2 className="h-4 w-4" /></Button>
                          </div>
                        </div>
                        <div className="mb-2 text-[11px] text-slate-500">
                          执行模式说明：`router` 任务分流，`rag` 文档检索，`generator` 生成回答，`review` 审查优化，`custom` 自定义步骤。
                        </div>
                        <textarea className="min-h-24 w-full rounded border border-slate-300 px-2 py-2 text-xs" value={agent.prompt} onChange={(e) => updateAgent(agent.id, { prompt: e.target.value })} placeholder="Agent Prompt" />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {settingsTab === "rag" && (
                <div className="space-y-2 text-sm text-slate-700">
                  <p className="font-semibold">文档与 RAG</p>
                  <p className="text-xs text-slate-600">在主聊天输入框右侧使用回形针上传文档。入库状态会在左侧显示；上传后提问会自动走当前已启用的知识检索步骤。</p>
                  <div className="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                    当前建议：至少保留 1 个负责知识检索的步骤，确保文档内容能参与回答。
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

