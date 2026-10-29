import { Braces, CircleHelp, CircleUserRound, Code2, LoaderCircle, Wrench } from "lucide-react";
import type { ReactNode } from "react";

import type { ConversationContent, ConversationEvent, MessageContent, ToolContent, ToolStatus } from "./content";
import { classifyConversationEvent, inspectableRawPayload } from "./content";

const toolStatusLabels: Record<ToolStatus, string> = {
  pending: "等待开始",
  running: "执行中",
  completed: "已完成",
  failed: "失败或被拒绝",
  unknown: "状态未知"
};

function contentFrame(label: string, icon: ReactNode, children: ReactNode) {
  return (
    <article className="grid gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4 text-[var(--ink)] shadow-[var(--shadow)]" aria-label={label}>
      <div className="flex items-center gap-2 text-xs font-semibold text-[var(--muted)]">
        {icon}
        <span>{label}</span>
      </div>
      {children}
    </article>
  );
}

function MessageBlock({ content }: { content: MessageContent }) {
  const roleLabel = content.role === "user" ? "用户消息" : content.role === "system" ? "系统消息" : "Agent 消息";
  return contentFrame(roleLabel, <CircleUserRound size={15} aria-hidden="true" />, <p className="whitespace-pre-wrap break-words text-sm leading-7">{content.text}</p>);
}

function CodeBlock({ content }: { content: Extract<ConversationContent, { kind: "code" }> }) {
  return contentFrame(
    content.filename ? `代码 · ${content.filename}` : "代码",
    <Code2 size={15} aria-hidden="true" />,
    <pre className="max-h-96 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--surface-soft)] p-3 text-xs leading-6"><code>{content.code}</code></pre>
  );
}

function ToolBlock({ content }: { content: ToolContent }) {
  const statusLabel = toolStatusLabels[content.status];
  return contentFrame(
    "工具状态",
    content.status === "running" ? <LoaderCircle className="animate-spin" size={15} aria-hidden="true" /> : <Wrench size={15} aria-hidden="true" />,
    <div className="grid gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <strong className="break-all text-sm font-semibold">{content.name}</strong>
        <span className="rounded-full bg-[var(--selected)] px-2 py-1 text-xs font-medium text-[var(--ink)]" role="status" aria-live="polite" aria-atomic="true">{statusLabel}</span>
      </div>
      {content.summary && <p className="break-words text-xs leading-6 text-[var(--muted)]">{content.summary}</p>}
    </div>
  );
}

function UnknownBlock({ content }: { content: Extract<ConversationContent, { kind: "unknown" }> }) {
  return contentFrame(
    "未知内容",
    <CircleHelp size={15} aria-hidden="true" />,
    <details className="rounded-lg border border-[var(--line)] bg-[var(--surface-soft)] p-3 text-xs">
      <summary className="flex min-h-[44px] cursor-pointer items-center font-semibold">查看原始字段（不会执行）</summary>
      <div className="mt-3 grid gap-2 text-[var(--muted)]">
        <span>类型：{content.label}</span>
        <span className="text-[var(--muted)]">原始事件保留在授权上下文中；此处仅隐藏凭据和绝对路径，内容不会执行。</span>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-[var(--ink)]">{JSON.stringify(inspectableRawPayload(content.raw), null, 2)}</pre>
      </div>
    </details>
  );
}

export function ConversationContentView({ content }: { content: ConversationContent }) {
  switch (content.kind) {
    case "message":
      return <MessageBlock content={content} />;
    case "code":
      return <CodeBlock content={content} />;
    case "tool":
      return <ToolBlock content={content} />;
    case "unknown":
      return <UnknownBlock content={content} />;
  }
}

export function ConversationEventContent({ event }: { event: ConversationEvent }) {
  return <ConversationContentView content={classifyConversationEvent(event)} />;
}

export function ConversationContentStack({ contents }: { contents: readonly ConversationContent[] }) {
  return <div className="grid gap-3">{contents.map((content) => <ConversationContentView key={content.eventId} content={content} />)}</div>;
}

export function ContentTypeBadge({ content }: { content: ConversationContent }) {
  const label = content.kind === "message" ? "消息" : content.kind === "code" ? "代码" : content.kind === "tool" ? "工具" : "未知";
  const Icon = content.kind === "message" ? CircleUserRound : content.kind === "code" ? Code2 : content.kind === "tool" ? Wrench : Braces;
  return <span className="inline-flex items-center gap-1 rounded-full border border-[var(--line)] px-2 py-1 text-xs text-[var(--muted)]"><Icon size={13} aria-hidden="true" />{label}</span>;
}
