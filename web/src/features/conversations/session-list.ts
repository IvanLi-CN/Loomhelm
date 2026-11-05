import type { Session } from "@loomhelm/protocol";

import { readAllCursorPages } from "@/features/projects/production-source";

export const SESSION_PAGE_LIMIT = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function isSessionSummary(value: unknown): value is Session {
  if (!isRecord(value)) return false;
  return typeof value.created_at === "string"
    && typeof value.external_thread_ref === "string"
    && typeof value.id === "string"
    && (value.path === "new" || value.path === "existing_active")
    && (value.project_id === undefined || typeof value.project_id === "string")
    && (value.state === "starting" || value.state === "active" || value.state === "reconciling" || value.state === "disconnected" || value.state === "closed" || value.state === "unsupported")
    && (value.task_id === undefined || typeof value.task_id === "string")
    && typeof value.updated_at === "string";
}

export interface SessionListReader {
  listSessions: (request: { after_cursor?: string; limit?: number }) => Promise<{
    has_more: boolean;
    items: readonly Session[];
    next_cursor?: string;
  }>;
}

export function listAllSessions(api: SessionListReader): Promise<readonly Session[]> {
  return readAllCursorPages(
    "sessions",
    (after_cursor) => api.listSessions({ after_cursor, limit: SESSION_PAGE_LIMIT }),
    SESSION_PAGE_LIMIT,
    isSessionSummary
  );
}
