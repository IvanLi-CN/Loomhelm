import type { GeneratedApiClient } from "@loomhelm/api-client";
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
export type SessionReadReason = "pending" | "stale_session" | "stale_response" | "foreign_response" | "transport";

export interface SessionReadResult {
  state: SessionReadState;
  session?: Session;
  request?: SessionRequestToken;
  reason?: SessionReadReason;
}

export class SessionClientAdapter {
  private readonly requests = new SessionRequestFence();

  constructor(private readonly client: SessionReadClient) {}

  selectSession(sessionId: string): number {
    return this.requests.activateSession(sessionId);
  }

  async readSession(sessionId: string): Promise<SessionReadResult> {
    const admission = this.requests.begin("session.read", sessionId);
    if (!admission.accepted) {
      return {
        state: admission.reason === "pending" ? "pending" : "unknown",
        request: admission.token,
        reason: admission.reason
      };
    }

    try {
      const response = await this.client.getSession({ session_id: sessionId });
      if (!this.requests.isCurrent(admission.token)) return { state: "unknown", reason: "stale_response", request: admission.token };
      if (response.session.id !== sessionId) {
        this.requests.finish(admission.token);
        return { state: "unknown", reason: "foreign_response", request: admission.token };
      }
      this.requests.finish(admission.token);
      return { state: "received", session: response.session, request: admission.token };
    } catch {
      if (!this.requests.isCurrent(admission.token)) return { state: "unknown", reason: "stale_response", request: admission.token };
      this.requests.finish(admission.token);
      return { state: "unknown", reason: "transport", request: admission.token };
    }
  }
}
