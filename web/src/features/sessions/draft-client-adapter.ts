import { ApiClientError, type GeneratedApiClient } from "@loomhelm/api-client";
import type { Draft, ModificationOrder } from "@loomhelm/protocol";

import { SessionRequestFence, type SessionRequestToken } from "./session-client-adapter";

export type DraftClient = Pick<GeneratedApiClient, "getDraft" | "updateDraft">;

export type DraftReadState = "received" | "pending" | "unknown";
export type DraftReadReason = "pending" | "stale_session" | "stale_response" | "foreign_response" | "invalid_response" | "transport" | "forbidden" | "not_found" | "conflict";

export interface DraftReadResult {
  state: DraftReadState;
  draft?: Draft;
  request?: SessionRequestToken;
  reason?: DraftReadReason;
}

export interface DraftClientAdapterOptions {
  clientId: string;
  readSequence?: (sessionId: string) => number | undefined;
  writeSequence?: (sessionId: string, sequence: number) => void;
  createMutationId?: () => string;
}

function mutationId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return `draft-${globalThis.crypto.randomUUID()}`;
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function errorReason(error: unknown): DraftReadReason {
  if (error instanceof ApiClientError && error.status === 403) return "forbidden";
  if (error instanceof ApiClientError && error.status === 404) return "not_found";
  if (error instanceof ApiClientError && error.status === 409) return "conflict";
  return "transport";
}

function validDraft(value: unknown, sessionId: string): value is Draft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<Draft>;
  const order = draft.modification_order;
  return draft.session_id === sessionId && typeof draft.content === "string" && typeof draft.revision === "number" && Number.isInteger(draft.revision) && draft.revision >= 0 && !!order && Number.isInteger(order.physical_millis) && order.physical_millis >= 0 && Number.isInteger(order.logical_counter) && order.logical_counter >= 0 && typeof order.client_id === "string" && typeof draft.updated_at === "string";
}

export class DraftClientAdapter {
  private readonly requests = new SessionRequestFence();
  private readonly pendingReads = new Map<string, { key: symbol; promise: Promise<DraftReadResult> }>();
  private readonly pendingUpdates = new Map<string, { key: symbol; promise: Promise<DraftReadResult> }>();
  private readonly sequences = new Map<string, number>();
  private readonly modificationOrders = new Map<string, ModificationOrder>();

  constructor(private readonly client: DraftClient, private readonly options: DraftClientAdapterOptions) {}

  selectSession(sessionId: string): number {
    const generation = this.requests.activateSession(sessionId);
    for (const pendingSessionId of this.pendingReads.keys()) {
      if (pendingSessionId !== sessionId) this.pendingReads.delete(pendingSessionId);
    }
    for (const pendingSessionId of this.pendingUpdates.keys()) {
      if (pendingSessionId !== sessionId) this.pendingUpdates.delete(pendingSessionId);
    }
    return generation;
  }

  async readDraft(sessionId: string): Promise<DraftReadResult> {
    const admission = this.requests.begin("draft.read", sessionId);
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
    const pendingRead = (async (): Promise<DraftReadResult> => {
      try {
        const response = await Promise.resolve().then(() => this.client.getDraft({ session_id: sessionId }));
        if (!this.requests.isCurrent(admission.token)) return { state: "unknown", reason: "stale_response", request: admission.token };
        if (!validDraft(response.draft, sessionId)) {
          this.requests.finish(admission.token);
          return { state: "unknown", reason: "foreign_response", request: admission.token };
        }
        this.rememberSequence(sessionId, response.draft);
        this.requests.finish(admission.token);
        return { state: "received", draft: response.draft, request: admission.token };
      } catch (error) {
        if (!this.requests.isCurrent(admission.token)) return { state: "unknown", reason: "stale_response", request: admission.token };
        this.requests.finish(admission.token);
        return { state: "unknown", reason: errorReason(error), request: admission.token };
      } finally {
        if (this.pendingReads.get(sessionId)?.key === requestKey) this.pendingReads.delete(sessionId);
      }
    })();
    this.pendingReads.set(sessionId, { key: requestKey, promise: pendingRead });
    return pendingRead;
  }

  async updateDraft(sessionId: string, content: string): Promise<DraftReadResult> {
    const admission = this.requests.begin("draft.update", sessionId);
    if (!admission.accepted) {
      if (admission.reason === "pending") {
        const pendingUpdate = this.pendingUpdates.get(sessionId)?.promise;
        if (pendingUpdate) return pendingUpdate;
      }
      return {
        state: admission.reason === "pending" ? "pending" : "unknown",
        request: admission.token,
        reason: admission.reason
      };
    }

    const clientSequence = this.nextSequence(sessionId);
    const modificationOrder = this.nextModificationOrder(sessionId);
    const requestKey = Symbol(sessionId);
    const pendingUpdate = (async (): Promise<DraftReadResult> => {
      try {
        const response = await Promise.resolve().then(() => this.client.updateDraft({
          session_id: sessionId,
          body: {
            client_id: this.options.clientId,
            client_sequence: clientSequence,
            content,
            modification_order: modificationOrder,
            mutation_id: (this.options.createMutationId ?? mutationId)()
          }
        }));
        if (!this.requests.isCurrent(admission.token)) return { state: "unknown", reason: "stale_response", request: admission.token };
        if (!validDraft(response.draft, sessionId)) {
          this.requests.finish(admission.token);
          return { state: "unknown", reason: "foreign_response", request: admission.token };
        }
        this.rememberSequence(sessionId, response.draft);
        this.requests.finish(admission.token);
        return { state: "received", draft: response.draft, request: admission.token };
      } catch (error) {
        if (!this.requests.isCurrent(admission.token)) return { state: "unknown", reason: "stale_response", request: admission.token };
        this.requests.finish(admission.token);
        return { state: "unknown", reason: errorReason(error), request: admission.token };
      } finally {
        if (this.pendingUpdates.get(sessionId)?.key === requestKey) this.pendingUpdates.delete(sessionId);
      }
    })();
    this.pendingUpdates.set(sessionId, { key: requestKey, promise: pendingUpdate });
    return pendingUpdate;
  }

  private nextSequence(sessionId: string): number {
    const current = this.sequences.get(sessionId) ?? this.options.readSequence?.(sessionId) ?? 0;
    const next = Math.max(0, current) + 1;
    this.sequences.set(sessionId, next);
    this.options.writeSequence?.(sessionId, next);
    return next;
  }

  private rememberSequence(sessionId: string, draft: Draft): void {
    this.rememberModificationOrder(sessionId, draft);
    if (draft.client_id !== this.options.clientId || typeof draft.client_sequence !== "number" || !Number.isInteger(draft.client_sequence) || draft.client_sequence < 0) return;
    const current = this.sequences.get(sessionId) ?? this.options.readSequence?.(sessionId) ?? 0;
    if (draft.client_sequence <= current) return;
    this.sequences.set(sessionId, draft.client_sequence);
    this.options.writeSequence?.(sessionId, draft.client_sequence);
  }

  private nextModificationOrder(sessionId: string): ModificationOrder {
    const current = this.modificationOrders.get(sessionId);
    const physicalMillis = Date.now();
    const next = !current || physicalMillis > current.physical_millis
      ? { physical_millis: physicalMillis, logical_counter: 0, client_id: this.options.clientId }
      : { physical_millis: current.physical_millis, logical_counter: current.logical_counter + 1, client_id: this.options.clientId };
    this.modificationOrders.set(sessionId, next);
    return next;
  }

  private rememberModificationOrder(sessionId: string, draft: Draft): void {
    const order = draft.modification_order;
    if (!Number.isInteger(order.physical_millis) || order.physical_millis < 0 || !Number.isInteger(order.logical_counter) || order.logical_counter < 0 || typeof order.client_id !== "string") return;
    const current = this.modificationOrders.get(sessionId);
    if (!current || compareModificationOrder(order, current) > 0) this.modificationOrders.set(sessionId, order);
  }
}

function compareModificationOrder(left: ModificationOrder, right: ModificationOrder): number {
  if (left.physical_millis !== right.physical_millis) return left.physical_millis < right.physical_millis ? -1 : 1;
  if (left.logical_counter !== right.logical_counter) return left.logical_counter < right.logical_counter ? -1 : 1;
  if (left.client_id === right.client_id) return 0;
  return left.client_id < right.client_id ? -1 : 1;
}
