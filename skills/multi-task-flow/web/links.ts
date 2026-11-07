/** Build the native Codex deep link used by the dashboard and Markdown exports. */
export function conversationUrl(threadId: string): string | null {
  const normalized = threadId.trim();
  if (!normalized) throw new Error("A conversation ID is required");
  // Synthetic example IDs must never invoke the native application.
  if (normalized.startsWith("mock-thread-")) return null;
  return `codex://threads/${encodeURIComponent(normalized)}`;
}
