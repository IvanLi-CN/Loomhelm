import { ApiClientError, type GeneratedApiClient } from "@loomhelm/api-client";
import type { Session } from "@loomhelm/protocol";

export type SessionReadClient = Pick<GeneratedApiClient, "getSession">;

export interface SessionRequestToken {
  key: string;
  sessionId: string;
  generation: number;
  requestId: number;
  baselineSequence?: number;
  baselineVersion?: number;
}

export type SessionRequestAdmission =
  | { accepted: true; token: SessionRequestToken }
  | { accepted: false; reason: "pending" | "stale_session"; token?: SessionRequestToken };

export class SessionRequestFence {
  private activeSessionId: string | undefined;
  private generation = 0;
  private requestId = 0;
  private readonly current = new Map<string, SessionRequestToken>();

  activateSession(sessionId: string): number {
    if (this.activeSessionId === sessionId) return this.generation;
    this.activeSessionId = sessionId;
    this.generation += 1;
    this.current.clear();
    return this.generation;
  }

  begin(key: string, sessionId: string, baselineSequence?: number, baselineVersion?: number): SessionRequestAdmission {
    if (this.activeSessionId === undefined) this.activateSession(sessionId);
    if (this.activeSessionId !== sessionId) return { accepted: false, reason: "stale_session" };

    const pending = this.current.get(key);
    if (pending !== undefined) return { accepted: false, reason: "pending", token: pending };

    const token: SessionRequestToken = {
      key,
      sessionId,
      generation: this.generation,
      requestId: ++this.requestId,
      baselineSequence,
      baselineVersion
    };
    this.current.set(key, token);
    return { accepted: true, token };
  }

  finish(token: SessionRequestToken): boolean {
    if (!this.isCurrent(token)) return false;
    this.current.delete(token.key);
    return true;
  }

  isCurrent(token: SessionRequestToken): boolean {
    const current = this.current.get(token.key);
    return current?.requestId === token.requestId && current.sessionId === token.sessionId && current.generation === token.generation;
  }
}

export type SessionReadState = "received" | "pending" | "unknown";
export type SessionReadReason = "pending" | "stale_session" | "stale_response" | "foreign_response" | "transport" | "forbidden" | "not_found";

export interface SessionReadResult {
  state: SessionReadState;
  session?: Session;
  request?: SessionRequestToken;
  reason?: SessionReadReason;
}

export class SessionClientAdapter {
  private readonly requests = new SessionRequestFence();
  private readonly pendingReads = new Map<string, { key: symbol; promise: Promise<SessionReadResult> }>();

  constructor(private readonly client: SessionReadClient) {}

  selectSession(sessionId: string): number {
    return this.requests.activateSession(sessionId);
  }

  async readSession(sessionId: string): Promise<SessionReadResult> {
    const admission = this.requests.begin("session.read", sessionId);
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

    const requestKey = Symbol(sessionId);
    const pendingRead = (async (): Promise<SessionReadResult> => {
      try {
        const response = await Promise.resolve().then(() => this.client.getSession({ session_id: sessionId }));
        if (!this.requests.isCurrent(admission.token)) return { state: "unknown", reason: "stale_response", request: admission.token };
        if (response.session.id !== sessionId) {
          this.requests.finish(admission.token);
          return { state: "unknown", reason: "foreign_response", request: admission.token };
        }
        this.requests.finish(admission.token);
        return { state: "received", session: response.session, request: admission.token };
      } catch (error) {
        if (!this.requests.isCurrent(admission.token)) return { state: "unknown", reason: "stale_response", request: admission.token };
        this.requests.finish(admission.token);
        const reason = error instanceof ApiClientError && error.status === 403
          ? "forbidden"
          : error instanceof ApiClientError && error.status === 404
            ? "not_found"
            : "transport";
        return { state: "unknown", reason, request: admission.token };
      } finally {
        if (this.pendingReads.get(sessionId)?.key === requestKey) this.pendingReads.delete(sessionId);
      }
    })();
    this.pendingReads.set(sessionId, { key: requestKey, promise: pendingRead });
    return pendingRead;
  }
}
