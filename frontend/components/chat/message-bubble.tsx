"use client";

import ReactMarkdown from "react-markdown";

import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/store/chatStore";

type Props = {
  message: ChatMessage;
};

export function MessageBubble({ message }: Props) {
  const isUser = message.role === "user";
  return (
    <div className={cn("w-full flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[86%] rounded-2xl border p-4 text-sm leading-7 shadow-sm",
          isUser ? "bg-slate-900 text-slate-50 border-slate-700" : "bg-white text-slate-900 border-slate-200"
        )}
      >
        <ReactMarkdown
          components={{
            p(props) {
              return <p className="mb-3 last:mb-0 whitespace-pre-wrap break-words">{props.children}</p>;
            },
            ul(props) {
              return <ul className="mb-3 list-disc space-y-1 pl-5">{props.children}</ul>;
            },
            ol(props) {
              return <ol className="mb-3 list-decimal space-y-1 pl-5">{props.children}</ol>;
            },
            li(props) {
              return <li className="whitespace-pre-wrap break-words">{props.children}</li>;
            },
            blockquote(props) {
              return <blockquote className="mb-3 border-l-4 border-slate-300 pl-3 italic text-slate-500">{props.children}</blockquote>;
            },
            table(props) {
              return <div className="mb-3 overflow-x-auto"><table className="min-w-full border-collapse text-sm">{props.children}</table></div>;
            },
            thead(props) {
              return <thead className="bg-slate-100">{props.children}</thead>;
            },
            th(props) {
              return <th className="border border-slate-200 px-2 py-1 text-left font-semibold">{props.children}</th>;
            },
            td(props) {
              return <td className="border border-slate-200 px-2 py-1 align-top">{props.children}</td>;
            },
            code(props) {
              const { className, children } = props;
              const isBlock = Boolean(className);
              if (!isBlock) {
                return <code className="rounded bg-slate-100 px-1 py-0.5 text-[13px] text-rose-700">{children}</code>;
              }
              return (
                <pre className="mb-3 overflow-x-auto rounded-xl bg-slate-950 p-4 text-slate-100">
                  <code className={className}>{children}</code>
                </pre>
              );
            },
          }}
        >
          {message.content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
