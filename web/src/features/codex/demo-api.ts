import type { BindCodexConversationParams, GeneratedApiClient, GetCodexConversationParams, UpdateCodexConversationTitleParams } from "@loomhelm/api-client";
import type { CodexConversation, CodexConversationDetail, CodexHistoryEvent, CodexSource } from "@loomhelm/protocol";

const source: CodexSource = {
  host_id: "host-default",
  host_name: "开发机",
  state: "online",
  sync_state: "complete",
  build: "codex-cli 0.166.0",
  protocol_version: "v2",
  capabilities: ["project/list", "thread/list", "thread/read", "thread/name/set"],
  capability_states: {
    "project/list": "supported",
    "thread/list": "supported",
    "thread/read": "supported",
    "thread/name/set": "supported",
    "thread/attachment/list": "unsupported"
  },
  as_of: "2026-11-02T10:30:00Z"
};

const history: CodexHistoryEvent[] = [
  {
    event_id: "event-1",
    sequence: 1,
    event_type: "user_message",
    raw_payload: { role: "user", text: "检查 Host-local app-server 的历史导入状态" },
    readable_fallback: "检查 Host-local app-server 的历史导入状态",
    occurred_at: "2026-11-02T10:12:00Z"
  },
  {
    event_id: "event-2",
    sequence: 2,
    event_type: "assistant_message",
    raw_payload: { role: "assistant", text: "已确认当前来源的能力与历史快照。" },
    readable_fallback: "已确认当前来源的能力与历史快照。",
    occurred_at: "2026-11-02T10:18:00Z"
  }
];

const conversations: CodexConversation[] = [
  {
    host_id: "host-default",
    thread_id: "thread-1",
    project_id: "codex-project",
    project_name: "来源同步",
    conversation_title: "同步 Codex 历史",
    codex_title: "同步 Codex 历史",
    preview: "检查 Host-local app-server 的历史导入状态",
    cwd: "/workspace/loomhelm",
    source_kind: "main",
    source_status: "active",
    history_state: "complete",
    files_complete: true,
    read_only: false,
    can_edit_title: true,
    title_sync_state: "synced",
    bound_task_id: "LH-30",
    as_of: source.as_of,
    updated_at: "2026-11-02T10:28:00Z"
  },
  {
    host_id: "host-default",
    thread_id: "thread-2",
    project_id: "codex-project",
    project_name: "来源同步",
    conversation_title: "未绑定材料",
    codex_title: "",
    preview: "历史仍在补齐，暂时不能进入项目",
    cwd: "/workspace/loomhelm",
    source_kind: "main",
    source_status: "active",
    history_state: "partial",
    files_complete: false,
    read_only: true,
    can_edit_title: false,
    title_sync_state: "unsupported",
    as_of: source.as_of,
    updated_at: "2026-11-02T10:12:00Z"
  },
  {
    host_id: "host-default",
    thread_id: "thread-3",
    project_id: "codex-project",
    project_name: "来源同步",
    conversation_title: "等待绑定的完整历史",
    codex_title: "等待绑定的完整历史",
    preview: "历史与文件材料已完整，可以按项目权限建立固定关联",
    cwd: "/workspace/loomhelm",
    source_kind: "main",
    source_status: "active",
    history_state: "complete",
    files_complete: true,
    read_only: true,
    can_edit_title: false,
    title_sync_state: "synced",
    as_of: source.as_of,
    updated_at: "2026-11-02T10:08:00Z"
  }
];

function detailFor(conversation: CodexConversation): CodexConversationDetail {
  return {
    conversation,
    history: conversation.thread_id === "thread-1" || conversation.thread_id === "thread-3" ? history : [],
    files: conversation.thread_id === "thread-1" || conversation.thread_id === "thread-3"
      ? [{ path: "docs/source-sync.md", content_type: "text/markdown", size: 1280, sha256: "demo-sha256", complete: true }]
      : [{ path: "pending/attachment.bin", content_type: "application/octet-stream", size: 0, sha256: "", complete: false }]
  };
}

export function createCodexDemoApi(): GeneratedApiClient {
  let currentTitle = conversations[0].conversation_title;

  return {
    listCodexSources: async () => ({ items: [source] }),
    listCodexConversations: async () => ({
      items: conversations.map((conversation) => conversation.thread_id === "thread-1" ? { ...conversation, conversation_title: currentTitle, codex_title: currentTitle } : conversation),
      has_more: false,
      as_of: source.as_of,
      snapshot_state: "complete"
    }),
    getCodexConversation: async ({ thread_id }: GetCodexConversationParams) => {
      const conversation = conversations.find((item) => item.thread_id === thread_id);
      if (!conversation) throw new Error("演示对话不存在");
      return detailFor(conversation.thread_id === "thread-1" ? { ...conversation, conversation_title: currentTitle, codex_title: currentTitle } : conversation);
    },
    updateCodexConversationTitle: async ({ body }: UpdateCodexConversationTitleParams) => {
      currentTitle = body.title.trim();
      const conversation = conversations[0];
      return { conversation: { ...conversation, conversation_title: currentTitle, codex_title: currentTitle, title_sync_state: "synced" } };
    },
    bindCodexConversation: async ({ thread_id, body }: BindCodexConversationParams) => {
      const index = conversations.findIndex((conversation) => conversation.thread_id === thread_id);
      if (index < 0) throw new Error("演示对话不存在");
      const conversation = { ...conversations[index], bound_task_id: body.task_id, read_only: true, can_edit_title: false };
      conversations[index] = conversation;
      return { conversation };
    },
    syncCodex: async () => ({ operation_id: "demo-sync", state: "syncing", as_of: source.as_of })
  } as unknown as GeneratedApiClient;
}
