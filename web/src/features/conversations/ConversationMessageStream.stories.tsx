import type { Meta, StoryObj } from "@storybook/react-vite";

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
