import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import type { ReactNode } from "react";

import { ConversationContentStack } from "./ConversationContent";
import { classifyConversationEvent, type ConversationContent } from "./content";

const meta = {
  title: "Conversation/Content",
  parameters: {
    layout: "fullscreen"
  },
  tags: ["autodocs"]
} satisfies Meta<typeof ConversationContentStack>;

export default meta;

type Story = StoryObj<typeof meta>;

const content: readonly ConversationContent[] = [
  { eventId: "message-1", eventType: "message.delta", kind: "message", role: "assistant", text: "已完成基础检查，结果会保留在当前对话。", raw: { delta: "已完成基础检查，结果会保留在当前对话。" } },
  { eventId: "code-1", eventType: "item.completed", kind: "code", language: "go", filename: "internal/example.go", code: "func ready() bool {\n\treturn true\n}", raw: { type: "code", language: "go", code: "func ready() bool {\\n\\treturn true\\n}" } },
  { eventId: "tool-1", eventType: "item.started", kind: "tool", name: "go test ./...", status: "running", summary: "工具仍在执行，页面不会把开始误报为完成。", raw: { type: "commandExecution", status: "inProgress" } },
  { eventId: "unknown-1", eventType: "unknown", kind: "unknown", label: "futureRenderer/v9", itemType: "futureContent", raw: { type: "futureContent", nested: { preserve: true } } }
];

function Surface({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-[var(--canvas)] p-12" data-visual-evidence-surface><div className="mx-auto max-w-3xl" data-visual-evidence-target>{children}</div></div>;
}

export const BasicStates: Story = {
  render: () => <Surface><ConversationContentStack contents={content} /></Surface>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole("article", { name: "Agent 消息" })).toBeInTheDocument();
    expect(canvas.getByRole("article", { name: "代码 · internal/example.go" })).toBeInTheDocument();
    expect(canvas.getByRole("article", { name: "工具状态" })).toBeInTheDocument();
    expect(canvas.getByRole("article", { name: "未知内容" })).toBeInTheDocument();
    expect(canvas.getByText("查看原始字段（不会执行）")).toBeInTheDocument();
  }
};

export const EventClassification: Story = {
  render: () => <Surface><ConversationContentStack contents={[
    classifyConversationEvent({ event_id: "message", type: "message.delta", payload: { delta: "来自真实事件字段的消息" } }),
    classifyConversationEvent({ event_id: "tool", type: "item.completed", payload: { item: { type: "mcpToolCall", tool: "read_summary", status: "completed" } } }),
    classifyConversationEvent({ event_id: "future", type: "item.completed", payload: { item: { type: "futureContent", xFutureField: "keep" } } })
  ]} /></Surface>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole("article", { name: "Agent 消息" })).toHaveTextContent("来自真实事件字段的消息");
    expect(canvas.getByRole("article", { name: "工具状态" })).toHaveTextContent("已完成");
    expect(canvas.getByRole("article", { name: "未知内容" })).toHaveTextContent("futureContent");
  }
};
