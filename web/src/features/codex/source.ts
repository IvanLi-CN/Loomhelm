import type { GeneratedApiClient, ListCodexConversationsParams } from "@loomhelm/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CodexConversation, CodexConversationDetail, CodexSource, CodexSyncResponse, CodexTitleUpdateRequest } from "@loomhelm/protocol";
import type { CodexConversationListResponse } from "@loomhelm/protocol";

import { useOptionalProductionApi } from "@/app/providers";
import { useOptionalProjectTaskSource } from "@/features/tasks/source";

export const codexQueryKeys = {
  overview: (principalId: string, sessionGeneration: number, search: string, includeArchived: boolean, bound: boolean | undefined = undefined) => ["loomhelm", principalId, sessionGeneration, "codex", "overview", search, includeArchived, bound ?? "all"] as const,
  detail: (principalId: string, sessionGeneration: number, hostId: string, threadId: string) => ["loomhelm", principalId, sessionGeneration, "codex", "conversation", hostId, threadId] as const
};

const codexConversationPageSize = 100;

export async function listAllCodexConversations(
  client: Pick<GeneratedApiClient, "listCodexConversations">,
  params: Omit<ListCodexConversationsParams, "after_cursor"> = {}
): Promise<CodexConversationListResponse> {
  const items: CodexConversation[] = [];
  let afterCursor: string | undefined;
  let firstPage: CodexConversationListResponse | undefined;
  const seenCursors = new Set<string>();

  for (;;) {
    const page = await client.listCodexConversations({ ...params, after_cursor: afterCursor, limit: params.limit ?? codexConversationPageSize });
    firstPage ??= page;
    items.push(...page.items);
    if (!page.has_more) {
      return { as_of: firstPage.as_of, has_more: false, items, next_cursor: undefined, snapshot_state: firstPage.snapshot_state };
    }
    const nextCursor = page.next_cursor?.trim();
    if (!nextCursor || seenCursors.has(nextCursor)) throw new Error("Codex 对话分页游标未前进");
    seenCursors.add(nextCursor);
    afterCursor = nextCursor;
  }
}

export function isTopLevelCodexConversation(conversation: CodexConversation): boolean {
  return conversation.source_kind === "main" && !conversation.bound_task_id && !conversation.bound_session_id;
}

export function findBoundCodexConversation(conversations: readonly CodexConversation[], sessionId: string | undefined): CodexConversation | undefined {
  if (!sessionId) return undefined;
  return conversations.find((conversation) => conversation.source_kind === "main" && conversation.bound_session_id === sessionId);
}

function requestID(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useCodexOverview(search: string, includeArchived: boolean, bound?: boolean) {
  const assembly = useOptionalProductionApi();
  const principalId = assembly?.auth.principalId ?? "anonymous";
  const sessionGeneration = assembly?.auth.sessionGeneration ?? 0;
  const enabled = assembly?.auth.status === "authenticated";
  return useQuery({
    queryKey: codexQueryKeys.overview(principalId, sessionGeneration, search, includeArchived, bound),
    queryFn: async () => {
      if (!assembly) throw new Error("浏览器会话尚未就绪");
      const [sources, conversations] = await Promise.all([
        assembly.client.listCodexSources(),
        listAllCodexConversations(assembly.client, { bound, search: search.trim() || undefined, include_archived: includeArchived })
      ]);
      return { sources: sources.items, conversations: conversations.items, asOf: conversations.as_of, snapshotState: conversations.snapshot_state };
    },
    enabled,
    refetchInterval: 30_000
  });
}

export function useCodexConversationDetail(hostId: string, threadId: string) {
  const assembly = useOptionalProductionApi();
  const principalId = assembly?.auth.principalId ?? "anonymous";
  const sessionGeneration = assembly?.auth.sessionGeneration ?? 0;
  return useQuery<CodexConversationDetail>({
    queryKey: codexQueryKeys.detail(principalId, sessionGeneration, hostId, threadId),
    queryFn: () => {
      if (!assembly) throw new Error("浏览器会话尚未就绪");
      return assembly.client.getCodexConversation({ host_id: hostId, thread_id: threadId });
    },
    enabled: assembly?.auth.status === "authenticated" && Boolean(hostId && threadId),
    refetchInterval: 30_000
  });
}

export function useCodexTitleMutation(hostId: string, threadId: string) {
  const assembly = useOptionalProductionApi();
  const queryClient = useQueryClient();
  const principalId = assembly?.auth.principalId ?? "anonymous";
  const sessionGeneration = assembly?.auth.sessionGeneration ?? 0;
  return useMutation({
    mutationFn: (body: Omit<CodexTitleUpdateRequest, "request_id"> & { request_id?: string }) => {
      if (!assembly) throw new Error("浏览器会话尚未就绪");
      return assembly.client.updateCodexConversationTitle({
        host_id: hostId,
        thread_id: threadId,
        body: { ...body, request_id: body.request_id ?? requestID("codex-title") }
      });
    },
    onSuccess: async (response) => {
      queryClient.setQueryData(codexQueryKeys.detail(principalId, sessionGeneration, hostId, threadId), (current: CodexConversationDetail | undefined) => current ? { ...current, conversation: response.conversation } : current);
      await queryClient.invalidateQueries({ queryKey: ["loomhelm", principalId, sessionGeneration, "codex", "overview"] });
    }
  });
}

export function useCodexBindConversation(hostId: string, threadId: string) {
  const assembly = useOptionalProductionApi();
  const queryClient = useQueryClient();
  const principalId = assembly?.auth.principalId ?? "anonymous";
  const sessionGeneration = assembly?.auth.sessionGeneration ?? 0;
  return useMutation({
    mutationFn: (body: { task_id: string; expected_as_of?: string }) => {
      if (!assembly) throw new Error("浏览器会话尚未就绪");
      return assembly.client.bindCodexConversation({
        host_id: hostId,
        thread_id: threadId,
        body: {
          request_id: requestID("codex-bind"),
          task_id: body.task_id,
          confirm_share: true,
          expected_as_of: body.expected_as_of
        }
      });
    },
    onSuccess: async (response) => {
      queryClient.setQueryData(codexQueryKeys.detail(principalId, sessionGeneration, hostId, threadId), (current: CodexConversationDetail | undefined) => current ? { ...current, conversation: response.conversation } : current);
      await queryClient.invalidateQueries({ queryKey: ["loomhelm", principalId, sessionGeneration, "codex", "overview"] });
    }
  });
}

export function useCodexSync() {
  const assembly = useOptionalProductionApi();
  const queryClient = useQueryClient();
  const principalId = assembly?.auth.principalId ?? "anonymous";
  const sessionGeneration = assembly?.auth.sessionGeneration ?? 0;
  return useMutation<CodexSyncResponse>({
    mutationFn: () => {
      if (!assembly) throw new Error("浏览器会话尚未就绪");
      return assembly.client.syncCodex({ body: { request_id: requestID("codex-sync") } });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["loomhelm", principalId, sessionGeneration, "codex"] });
    }
  });
}

export function useTaskTitleReplacement(taskId: string | undefined) {
  const taskSource = useOptionalProjectTaskSource();
  const task = taskSource?.getTask(taskId);
  const canWrite = task ? taskSource?.getProjectPermissions(task.projectId).canWrite === true : false;
  return { taskSource, task, canWrite };
}

export function applyTaskTitleUpdate(taskSource: ReturnType<typeof useOptionalProjectTaskSource>, taskId: string, title: string): Promise<{ ok: boolean; message?: string }> {
  if (!taskSource) return Promise.resolve({ ok: false, message: "任务数据尚未加载。" });
  return taskSource.updateTask(taskId, { title }).then((result) => result.ok ? { ok: true } : { ok: false, message: result.message });
}

export function conversationLabel(conversation: CodexConversation): string {
  return conversation.conversation_title || conversation.codex_title || conversation.preview || "自动标题";
}

export function codexRouteKey(hostId: string, threadId: string): string {
  return `codex:${encodeURIComponent(hostId)}:${encodeURIComponent(threadId)}`;
}

export function parseCodexRouteKey(value: string): { hostId: string; threadId: string } | undefined {
  if (!value.startsWith("codex:")) return undefined;
  const parts = value.split(":");
  if (parts.length !== 3) return undefined;
  try {
    const hostId = decodeURIComponent(parts[1]);
    const threadId = decodeURIComponent(parts[2]);
    return hostId && threadId ? { hostId, threadId } : undefined;
  } catch {
    return undefined;
  }
}

export function sourceStateLabel(source: CodexSource | undefined): string {
  if (!source) return "来源未发现";
  if (source.state === "online") return source.sync_state === "syncing" ? "同步中" : "在线";
  if (source.state === "unavailable") return "来源不可用";
  return "来源离线";
}
