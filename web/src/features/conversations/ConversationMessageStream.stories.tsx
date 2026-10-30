import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Artifact } from "@loomhelm/protocol";

import { ConversationMessageStream, type ConversationMessage } from "./ConversationMessageStream";

const messages: readonly ConversationMessage[] = [
  {
    author: "你",
    content: "先确认当前工作区和任务主会话的边界。",
    delivery: "received",
    id: "message-user-1",
    kind: "message",
    role: "user",
    occurredAt: "01:11"
  },
  {
    author: "Codex · 主对话",
    content: "我会保留任务业务状态，并把 Run 的执行与审批事实单独显示。",
    detail: "已读取任务目标、Session 身份与最近一次 Run 事件。",
    delivery: "received",
    eventType: "message.delta",
    id: "message-assistant-1",
    kind: "message",
    role: "assistant",
    occurredAt: "01:12"
  },
  {
    author: "工具事件",
    content: "读取工作区元数据",
    detail: "工具事件只展示已观察到的开始和完成内容。",
    eventType: "item.completed",
    id: "message-tool-1",
    kind: "tool",
    role: "system",
    occurredAt: "01:12"
  },
  {
    author: "未识别内容",
    content: "当前事件类型没有可用的专用渲染器。",
    detail: "事件元数据\n{\n  \"event_id\": \"event-unknown-1\"\n}\n\n原始 payload\n{\n  \"futureField\": true\n}",
    eventType: "unknown",
    id: "message-unknown-1",
    kind: "unknown",
    role: "system",
    occurredAt: "01:13"
  }
];

const richArtifact: Artifact = {
  content_type: "text/markdown",
  created_at: "2026-10-29 14:05",
  id: "artifact-story-u04-report",
  kind: "file",
  name: "reports/summary.md",
  session_id: "session-story-u04",
  sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  size: 68
};

const richContentMessages: readonly ConversationMessage[] = [
  {
    author: "Codex",
    content: "已接收结构化消息。",
    eventType: "item.completed",
    id: "rich-message",
    kind: "message",
    occurredAt: "14:04",
    richContent: { eventId: "rich-message", eventType: "item.completed", kind: "message", raw: { text: "已接收结构化消息。" }, role: "assistant", text: "已接收结构化消息。" },
    role: "assistant"
  },
  {
    author: "执行事件",
    content: "已读取代码内容。",
    eventType: "item.completed",
    id: "rich-code",
    kind: "tool",
    occurredAt: "14:04",
    richContent: { code: "await workspace.read(\"reports/summary.md\");", eventId: "rich-code", eventType: "item.completed", filename: "/workspace/loomhelm/reports/summary.md", kind: "code", language: "typescript", raw: { code: "await workspace.read(\"reports/summary.md\");" } },
    role: "system"
  },
  {
    author: "执行事件",
    content: "读取完成。",
    eventType: "message.delta",
    id: "rich-tool",
    kind: "tool",
    occurredAt: "14:04",
    richContent: { eventId: "rich-tool", eventType: "message.delta", kind: "tool", name: "item/commandExecution/outputDelta", raw: { method: "item/commandExecution/outputDelta" }, status: "completed", summary: "读取完成：1 个授权文件，未扩大工作区范围。" },
    role: "system"
  },
  {
    author: "未识别内容",
    content: "保留未来事件字段。",
    eventType: "unknown",
    id: "rich-unknown",
    kind: "unknown",
    occurredAt: "14:05",
    richContent: { eventId: "rich-unknown", eventType: "unknown", kind: "unknown", label: "futureContent", raw: { futureField: true } },
    role: "system"
  },
  {
    author: "文件产物",
    artifactId: richArtifact.id,
    content: "已接收文件产物。",
    eventType: "artifact.created",
    id: "rich-artifact",
    kind: "artifact",
    occurredAt: "14:05",
    role: "system"
  }
];

const meta = {
  title: "Features/Conversations/Message Stream",
  component: ConversationMessageStream,
  args: {
    messages: []
  },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "消息流保留已接收内容、工具事件和 unknown 回退；断线时不把控制命令伪装成已完成。"
      }
    }
  },
  tags: ["autodocs"]
} satisfies Meta<typeof ConversationMessageStream>;

export default meta;

type Story = StoryObj<typeof meta>;

function EvidenceFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[832px] bg-[var(--canvas)] p-6 sm:p-8" data-visual-evidence-surface>
      <div className="mx-auto grid w-full max-w-3xl gap-5" data-visual-evidence-target>{children}</div>
    </div>
  );
}
export const StateGallery: Story = {
  render: () => (
    <EvidenceFrame>
      <ConversationMessageStream messages={messages} />
      <ConversationMessageStream connection="offline" messages={messages.slice(0, 2)} />
    </EvidenceFrame>
  )
};
export const SendingAndReceived: Story = {
  render: () => (
    <EvidenceFrame>
      <ConversationMessageStream messages={[
        { ...messages[0], delivery: "sending", id: "message-sending" },
        { ...messages[1], id: "message-received" }
      ]} />
    </EvidenceFrame>
  )
};

export const Unknown: Story = {
  render: () => (
    <EvidenceFrame>
      <ConversationMessageStream messages={[messages[3]]} />
    </EvidenceFrame>
  )
};

export const Disconnected: Story = {
  render: () => (
    <EvidenceFrame>
      <ConversationMessageStream connection="offline" messages={messages.slice(0, 2)} />
    </EvidenceFrame>
  )
};

export const Empty: Story = {
  render: () => (
    <EvidenceFrame>
      <ConversationMessageStream messages={[]} />
    </EvidenceFrame>
  )
};

export const RichContentAndArtifact: Story = {
  render: () => (
    <EvidenceFrame>
      <ConversationMessageStream
        loadArtifactMetadata={async () => richArtifact}
        messages={richContentMessages}
      />
    </EvidenceFrame>
  )
};
