/** Build the native Codex deep link used by the dashboard and Markdown exports. */
export function conversationUrl(threadId: string): string {
  const normalized = threadId.trim();
  if (!normalized) throw new Error("A conversation ID is required");
  return `codex://threads/${encodeURIComponent(normalized)}`;
}
