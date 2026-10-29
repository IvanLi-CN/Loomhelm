import { ApiClientError, type GeneratedApiClient } from "@loomhelm/api-client";
import type { Run } from "@loomhelm/protocol";

import { SessionRequestFence, type SessionRequestToken } from "./session-client-adapter";

export type SessionRunHistoryClient = Pick<GeneratedApiClient, "listSessionRuns">;

export type SessionRunHistoryReadState = "received" | "pending" | "unknown";
export type SessionRunHistoryReadReason = "pending" | "stale_session" | "stale_response" | "foreign_response" | "invalid_response" | "transport" | "forbidden" | "not_found";

export interface SessionRunHistoryReadResult {
  state: SessionRunHistoryReadState;
  request?: SessionRequestToken;
  runs?: readonly Run[];
  reason?: SessionRunHistoryReadReason;
}

export interface SessionRunHistoryReadOptions {
  forceRefresh?: boolean;
}

interface CachedSessionRunHistory {
  runs: readonly Run[];
  resumeCursor?: string;
}

function accessFailureReason(error: unknown): "forbidden" | "not_found" | "transport" {
  if (error instanceof ApiClientError && error.status === 403) return "forbidden";
  if (error instanceof ApiClientError && error.status === 404) return "not_found";
  return "transport";
}

export class SessionRunHistoryClientAdapter {
  private readonly requests = new SessionRequestFence();
  private readonly pendingReads = new Map<string, { key: symbol; promise: Promise<SessionRunHistoryReadResult> }>();
  private readonly cachedHistory = new Map<string, CachedSessionRunHistory>();

  constructor(private readonly client: SessionRunHistoryClient) {}

  selectSession(sessionId: string): number {
    const generation = this.requests.activateSession(sessionId);
    for (const [pendingSessionId, pending] of this.pendingReads) {
      if (pendingSessionId !== sessionId) this.pendingReads.delete(pendingSessionId);
    }
    return generation;
  }

  async readRuns(sessionId: string, { forceRefresh = false }: SessionRunHistoryReadOptions = {}): Promise<SessionRunHistoryReadResult> {
    const admission = this.requests.begin("session.runs.read", sessionId);
    if (!admission.accepted) {
      if (admission.reason === "pending") {
        const pendingRead = this.pendingReads.get(sessionId)?.promise;
        if (pendingRead) return pendingRead;
      }
      return {
        state: admission.reason === "pending" ? "pending" : "unknown",
        request: admission.token,
        reason: admission.reason
      };
    }

    const cached = this.cachedHistory.get(sessionId);

    const requestKey = Symbol(sessionId);
    const pendingRead = (async (): Promise<SessionRunHistoryReadResult> => {
      const resumeCursor = forceRefresh ? undefined : cached?.resumeCursor;
      const runsById = new Map<string, Run>(resumeCursor && cached ? cached.runs.map((run) => [run.id, run]) : []);
      const seenCursors = new Set<string>();
      let afterCursor: string | undefined = resumeCursor;
      try {
        for (let pageNumber = 0; pageNumber < 1000; pageNumber += 1) {
          if (!this.requests.isCurrent(admission.token)) return { state: "unknown", reason: "stale_response", request: admission.token };
          const page = await this.client.listSessionRuns({ session_id: sessionId, limit: 200, ...(afterCursor ? { after_cursor: afterCursor } : {}) });
          if (!this.requests.isCurrent(admission.token)) return { state: "unknown", reason: "stale_response", request: admission.token };
          if (typeof page.has_more !== "boolean") {
            this.requests.finish(admission.token);
            return { state: "unknown", reason: "invalid_response", request: admission.token };
          }
          if (!Array.isArray(page.items) || page.items.some((run) => run.session_id !== sessionId)) {
            this.requests.finish(admission.token);
            return { state: "unknown", reason: "foreign_response", request: admission.token };
          }
          page.items.forEach((run) => runsById.set(run.id, run));
          if (!page.has_more) {
            const runs = [...runsById.values()].sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
            this.cachedHistory.set(sessionId, { runs, resumeCursor: afterCursor });
            this.requests.finish(admission.token);
            return { state: "received", request: admission.token, runs };
          }
          const nextCursor = page.next_cursor?.trim();
          if (!nextCursor || seenCursors.has(nextCursor)) {
            this.requests.finish(admission.token);
            return { state: "unknown", reason: "invalid_response", request: admission.token };
          }
          seenCursors.add(nextCursor);
          afterCursor = nextCursor;
        }
        this.requests.finish(admission.token);
        return { state: "unknown", reason: "invalid_response", request: admission.token };
      } catch (error) {
        if (!this.requests.isCurrent(admission.token)) return { state: "unknown", reason: "stale_response", request: admission.token };
        this.requests.finish(admission.token);
        return { state: "unknown", reason: accessFailureReason(error), request: admission.token };
      } finally {
        if (this.pendingReads.get(sessionId)?.key === requestKey) this.pendingReads.delete(sessionId);
      }
    })();
    this.pendingReads.set(sessionId, { key: requestKey, promise: pendingRead });
    return pendingRead;
  }
}
