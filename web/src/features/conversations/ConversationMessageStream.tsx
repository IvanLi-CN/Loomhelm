import { CheckCircle2, CircleHelp, CloudOff, FileArchive, FileCode2, LoaderCircle, MessageCircle, Send, UserRound, Wrench } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";

import type { EventType } from "@loomhelm/protocol";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ArtifactDownloader, ArtifactMetadataLoader } from "@/features/artifacts/api";
import { ArtifactReference } from "@/features/artifacts/ArtifactReference";
import { ConversationContentView } from "@/features/artifacts/ConversationContent";
import type { ConversationContent } from "@/features/artifacts/content";
import { cn } from "@/lib/utils";

import {
  canSendControl,
  type ConnectionAvailability,
  getConnectionLabel
} from "@/features/sessions/session-model";

export type ConversationMessageRole = "user" | "assistant" | "system";
export type ConversationMessageKind = "message" | "tool" | "unknown" | "artifact";
export type MessageDeliveryState = "sending" | "received";

export interface ConversationMessage {
  id: string;
  runId?: string;
  sequence?: number;
  role: ConversationMessageRole;
  author: string;
  content: string;
  detail?: string;
  delivery?: MessageDeliveryState;
  eventType?: EventType;
  kind?: ConversationMessageKind;
  occurredAt?: string;
  deltaParts?: readonly { content: string; sequence: number }[];
  richContent?: ConversationContent;
  artifactId?: string;
}
export interface ConversationMessageStreamProps {
  messages: readonly ConversationMessage[];
  connection?: ConnectionAvailability;
  emptyMessage?: string;
  className?: string;
  loadArtifactMetadata?: ArtifactMetadataLoader;
  downloadArtifact?: ArtifactDownloader;
}

function getMessageIcon(message: ConversationMessage) {
  if (message.kind === "artifact") return <FileArchive className="size-4" aria-hidden="true" />;
  if (message.kind === "tool") return <Wrench className="size-4" aria-hidden="true" />;
  if (message.kind === "unknown") return <CircleHelp className="size-4" aria-hidden="true" />;
  if (message.role === "user") return <UserRound className="size-4" aria-hidden="true" />;
  if (message.role === "system") return <FileCode2 className="size-4" aria-hidden="true" />;
  return <MessageCircle className="size-4" aria-hidden="true" />;
}

function getMessageKindLabel(message: ConversationMessage): string {
  if (message.kind === "artifact") return "文件产物";
  if (message.kind === "tool") return "工具事件";
  if (message.kind === "unknown") return "unknown";
  if (message.role === "user") return "你";
  if (message.role === "system") return "系统事件";
  return "Codex";
}

function getDeliveryLabel(delivery: MessageDeliveryState | undefined): string | null {
  if (delivery === "sending") return "发送中";
  if (delivery === "received") return "已接收";
  return null;
}

export function ConversationMessageStream({ messages, connection = "online", emptyMessage = "这段会话还没有已接收消息。", className, loadArtifactMetadata, downloadArtifact }: ConversationMessageStreamProps) {
  return (
    <section className={cn("grid min-w-0 gap-4 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] p-5 text-[var(--ink)] shadow-[var(--shadow)]", className)} aria-label="会话消息流" data-testid="conversation-message-stream">
      {connection !== "online" ? (
        <div className="flex items-start gap-2 rounded-[var(--radius-sm)] bg-[var(--warning-bg)] p-3 text-xs leading-5 text-[var(--warning)]" data-testid="message-stream-connection" role="status">
          <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span><strong>{getConnectionLabel(connection)}</strong>。已接收内容保留，新的发送和控制命令不会排队。</span>
        </div>
      ) : null}

      {messages.length === 0 ? (
        <div className="grid min-h-32 place-items-center rounded-[var(--radius-sm)] bg-[var(--surface-soft)] p-6 text-center text-xs leading-6 text-[var(--muted)]" data-testid="message-stream-empty">
          {emptyMessage}
        </div>
      ) : (
        <ol className="grid min-w-0 gap-4" data-testid="message-stream-list" role="log" aria-live="polite" aria-relevant="additions text">
          {messages.map((message) => {
            const deliveryLabel = getDeliveryLabel(message.delivery);
            const isUnknown = message.kind === "unknown";
            return (
              <li key={message.id} className="min-w-0 border-b border-[var(--line)] pb-4 last:border-b-0 last:pb-0" data-message-id={message.id}>
                <article className="grid min-w-0 gap-2" aria-label={`${getMessageKindLabel(message)}${deliveryLabel ? `，${deliveryLabel}` : ""}`}>
                  <header className="flex min-w-0 flex-wrap items-center gap-2 text-xs font-semibold">
                    <span className={cn("inline-flex items-center gap-1.5", isUnknown ? "text-[var(--muted)]" : message.role === "user" ? "text-[var(--ink)]" : "text-[var(--accent)]")}>
                      {getMessageIcon(message)}
                      {message.author}
                    </span>
                    <span className={cn("rounded-[var(--radius-sm)] border border-[var(--line)] px-2 py-0.5 text-[10px] font-semibold", isUnknown ? "bg-[var(--surface-soft)] text-[var(--muted)]" : "bg-[var(--selected)] text-[var(--accent)]")}>
                      {getMessageKindLabel(message)}
                    </span>
                    {deliveryLabel ? (
                      <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--surface-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--muted)]">
                        {message.delivery === "sending" ? <LoaderCircle className="size-3 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="size-3" aria-hidden="true" />}
                        {deliveryLabel}
                      </span>
                    ) : null}
                    {message.occurredAt ? <time className="ml-auto text-[10px] font-normal text-[var(--muted)]">{message.occurredAt}</time> : null}
                  </header>
                  {message.artifactId ? (
                    loadArtifactMetadata ? <ArtifactReference artifactId={message.artifactId} download={downloadArtifact} loadMetadata={loadArtifactMetadata} /> : <div className="grid gap-1 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--surface-soft)] p-3 text-xs text-[var(--muted)]" data-testid="artifact-reference-unavailable"><strong className="text-[var(--ink)]">已接收文件产物</strong><span>当前会话没有可用的授权 metadata 读取器；不会把 artifact 身份当作文件内容或下载地址。</span></div>
                  ) : message.richContent ? (
                    <ConversationContentView content={message.richContent} />
                  ) : (
                    <p className={cn("wrap-anywhere whitespace-pre-wrap text-[13px] leading-7", isUnknown ? "text-[var(--muted)]" : "text-[var(--ink)]")}>{message.content}</p>
                  )}
                  {message.eventType ? <code className="w-fit max-w-full wrap-anywhere rounded-[var(--radius-sm)] bg-[var(--surface-soft)] px-2 py-1 text-[10px] text-[var(--muted)]">{message.eventType}</code> : null}
                  {message.detail && !message.richContent && !message.artifactId ? <details className="border-t border-[var(--line)] pt-2 text-xs leading-6 text-[var(--muted)]"><summary className="cursor-pointer">{isUnknown ? "查看原始事件" : "查看过程"}</summary><p className="mt-2 whitespace-pre-wrap">{message.detail}</p></details> : null}
                  {isUnknown ? <p className="text-[11px] leading-5 text-[var(--muted)]">该内容保留为 unknown，不推断为成功或失败。</p> : null}
                </article>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export interface ConversationComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (value: string) => void | Promise<void>;
  connection?: ConnectionAvailability;
  readOnly?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  placeholder?: string;
}

export function ConversationComposer({ value, onChange, onSend, connection = "online", readOnly = false, disabled = false, disabledReason, placeholder = "继续说明目标或补充上下文…" }: ConversationComposerProps) {
  const submissionLock = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const canSubmit = Boolean(value.trim()) && canSendControl(connection, readOnly) && !disabled && !submitting;
  const blockedReason = disabledReason ?? (readOnly
    ? "当前会话只读，草稿可以保留但不会发送。"
    : connection === "online"
      ? "发送需要明确点击；恢复连接不会自动发送草稿。"
      : "连接不可用，不会发送或排队草稿。");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || submissionLock.current) return;

    const content = value.trim();
    submissionLock.current = true;
    setSubmitting(true);
    try {
      await onSend(content);
    } finally {
      submissionLock.current = false;
      setSubmitting(false);
    }
  };

  return (
    <form className="grid min-w-0 gap-3 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--surface)] p-4 text-[var(--ink)] shadow-[var(--shadow)]" onSubmit={submit} aria-busy={submitting} data-testid="conversation-composer">
      <label className="text-xs font-semibold text-[var(--muted)]" htmlFor="conversation-composer-draft">对话共享草稿</label>
      <Textarea
        id="conversation-composer-draft"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled || readOnly}
        className="min-h-24 resize-y border-[var(--line-strong)] bg-[var(--surface-glass)] text-[var(--ink)] placeholder:text-[var(--muted)]"
        aria-describedby="conversation-composer-status"
      />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p id="conversation-composer-status" className="max-w-[48ch] text-[11px] leading-5 text-[var(--muted)]">{blockedReason}</p>
        <Button type="submit" disabled={!canSubmit} data-testid="conversation-send-button">
          {submitting ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
          {submitting ? "发送中" : "发送"}
        </Button>
      </div>
    </form>
  );
}
