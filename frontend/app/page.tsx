"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, Paperclip, Send, Sparkles, Trash2 } from "lucide-react";

import { MessageBubble } from "@/components/chat/message-bubble";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/components/ui/use-toast";
import { useChatStore } from "@/store/chatStore";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8001";

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
  const [apiKeyValidation, setApiKeyValidation] = useState<null | {
    kind: "success" | "error";
    message: string;
  }>(null);
  const [uploadStatus, setUploadStatus] = useState<null | {
    taskId: string;
    status: "queued" | "running" | "done" | "failed";
    message?: string;
  }>(null);
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
      return;
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
        setUploadStatus({
          taskId,
          status: nextStatus,
          message: st?.error_message ?? undefined,
        });
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
      setUploadStatus({
        taskId: uploadStatus.taskId,
        status: nextStatus,
        message: st?.error_message ?? undefined,
      });
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
      setApiKeyValidation({
        kind: "error",
        message: err instanceof Error ? err.message : "网络异常，请重试",
      });
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

  return (
    <main className="h-screen w-full bg-gradient-to-br from-slate-100 via-stone-50 to-amber-50 p-4">
      <div className="mx-auto grid h-full max-w-7xl grid-cols-12 gap-4">
        <Card className="col-span-3 flex h-full flex-col">
          <CardHeader className="flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-wide text-slate-700">会话列表</h2>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" className="h-8 px-2 text-xs" onClick={createNewSession}>
                新建对话
              </Button>
              <Sparkles className="h-4 w-4 text-amber-500" />
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
                  <Button
                    type="button"
                    variant="outline"
                    className="px-2"
                    onClick={() => handleDeleteSession(sid)}
                    title="删除会话"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </ScrollArea>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={() => void handleExport("markdown")}>
                <Download className="mr-1 h-4 w-4" />
                导出 MD
              </Button>
              <Button variant="outline" onClick={() => void handleExport("json")}>
                <Download className="mr-1 h-4 w-4" />
                导出 JSON
              </Button>
            </div>
            <div className="mt-3 space-y-2 rounded-lg border border-slate-200 p-2">
              <p className="text-xs font-semibold text-slate-600">模型设置</p>
              <select
                className="h-9 w-full rounded border border-slate-300 px-2 text-xs"
                value={modelConfig.provider}
                onChange={(e) => setModelConfig({ provider: e.target.value as "local" | "cloud" })}
              >
                <option value="local">本地 Ollama</option>
                <option value="cloud">云端 API</option>
              </select>
              {modelConfig.provider === "local" ? (
                <>
                  {localModels.length > 0 ? (
                    <select
                      className="h-9 w-full rounded border border-slate-300 px-2 text-xs"
                      value={modelConfig.localModel}
                      onChange={(e) => setModelConfig({ localModel: e.target.value })}
                    >
                      {localModels.map((model, index) => (
                        <option key={`${model}-${index}`} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="rounded border border-amber-300 bg-amber-50 px-2 py-2 text-xs text-amber-800">
                      {localModelsLoaded
                        ? "未发现本地 Ollama 模型，请先运行 `ollama pull <model>` 后点击刷新。"
                        : "正在加载本地模型列表..."}
                    </div>
                  )}
                  <Button type="button" variant="outline" onClick={loadLocalModels}>
                    刷新本地模型列表
                  </Button>
                </>
              ) : (
                <>
                  <select
                    className="h-9 w-full rounded border border-slate-300 px-2 text-xs"
                    value={modelConfig.cloudPreset}
                    onChange={(e) =>
                      setModelConfig({
                        cloudPreset: e.target.value as "aliyun" | "openai" | "custom",
                        apiBase: "",
                        cloudModel: "",
                      })
                    }
                    >
                      <option value="aliyun">阿里云百炼</option>
                      <option value="openai">OpenAI</option>
                      <option value="custom">自定义</option>
                    </select>
                  {savedApiKeys.length > 0 && (
                    <select
                      className="h-9 w-full rounded border border-slate-300 px-2 text-xs"
                      value={activeApiKeyId ?? ""}
                      onChange={(e) => selectSavedApiKey(e.target.value)}
                    >
                      <option value="">已保存的 API Key</option>
                      {savedApiKeys.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <Input
                    value={modelConfig.apiKey}
                    onChange={(e) => setModelConfig({ apiKey: e.target.value })}
                    placeholder="API Key（必填）"
                    type="password"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <Button type="button" variant="outline" onClick={handleValidateApiKey} disabled={validatingKey}>
                      {validatingKey ? <Loader2 className="h-4 w-4 animate-spin" /> : "验证 API Key"}
                    </Button>
                    <Button type="button" variant="outline" onClick={handleSaveApiKey}>
                      保存到本机
                    </Button>
                  </div>
                  {apiKeyValidation && (
                    <div
                      className={`rounded border px-2 py-2 text-xs ${
                        apiKeyValidation.kind === "success"
                          ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                          : "border-rose-300 bg-rose-50 text-rose-800"
                      }`}
                    >
                      {apiKeyValidation.kind === "success" ? "验证成功： " : "验证失败： "}
                      {apiKeyValidation.message}
                    </div>
                  )}
                  {savedApiKeys.length > 0 && (
                    <div className="space-y-2 rounded border border-slate-200 bg-white p-2">
                      <p className="text-xs font-semibold text-slate-600">已保存列表</p>
                      {savedApiKeys.map((item) => (
                        <div key={item.id} className="flex items-center gap-2">
                          <button
                            type="button"
                            className={`flex-1 rounded border px-2 py-1 text-left text-xs ${
                              item.id === activeApiKeyId ? "border-slate-700 bg-slate-100" : "border-slate-200 bg-white"
                            }`}
                            onClick={() => selectSavedApiKey(item.id)}
                          >
                            {item.name}
                          </button>
                          <Button type="button" variant="outline" className="px-2" onClick={() => handleDeleteSavedApiKey(item.id)}>
                            删除
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="text-xs text-slate-500">
                    选择平台后只需填写 API Key 即可使用，模型与地址由系统默认处理。
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="col-span-9 flex h-full flex-col">
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
                    <p className="text-slate-400">这里会显示 Router / RAG / Code / Review 的接力过程。</p>
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
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="输入需求，例如：帮我生成一个带 RAG 的 FastAPI 服务..."
              />
              <input ref={fileRef} type="file" accept=".pdf,.md,.markdown,.txt,.docx,.xlsx,.xls" className="hidden" onChange={handleUploadFile} />
              <Button type="button" variant="outline" onClick={handleUploadClick} disabled={uploading}>
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
              </Button>
              <Button type="submit" disabled={!canSend}>
                {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </form>
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
      </div>
    </main>
  );
}
