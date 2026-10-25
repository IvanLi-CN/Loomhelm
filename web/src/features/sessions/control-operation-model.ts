import type { Approval, Command, CommandAck, Event, Run, Session } from "@loomhelm/protocol";

import type { ConnectionAvailability } from "./session-model";

export interface ControlGateInput {
  connection?: ConnectionAvailability;
  readOnly?: boolean;
  sessionState?: Session["state"];
  commandState?: CommandAck["state"];
  runStatus?: Run["status"];
  approvalStatus?: Approval["status"];
  eventType?: Event["type"];
  uncertain?: boolean;
  inProgress?: boolean;
}

export type ControlBlockReason = "read_only" | "offline" | "reconnecting" | "unknown" | "session_unavailable" | "not_actionable" | "in_progress";

export interface ControlGate {
  allowed: boolean;
  blockReason?: ControlBlockReason;
  queue: false;
  replay: false;
}

function blocked(blockReason: ControlBlockReason): ControlGate {
  return { allowed: false, blockReason, queue: false, replay: false };
}

export function getControlGate({ connection = "online", readOnly = false, sessionState, commandState, runStatus, approvalStatus, eventType, uncertain = false, inProgress = false }: ControlGateInput = {}): ControlGate {
  if (readOnly) return blocked("read_only");
  if (connection === "offline") return blocked("offline");
  if (connection === "reconnecting") return blocked("reconnecting");
  if (uncertain || eventType === "unknown" || commandState === "unknown" || runStatus === "unknown") return blocked("unknown");
  if (sessionState !== undefined && sessionState !== "active") return blocked("session_unavailable");
  if (approvalStatus !== undefined && approvalStatus !== "pending") return blocked("not_actionable");
  if (inProgress) return blocked("in_progress");
  return { allowed: true, queue: false, replay: false };
}

export type CommandIdentity = Pick<Command, "command_id" | "session_id" | "run_id">;

export interface ControlOperation {
  operationKey: string;
  command: CommandIdentity;
}

export interface OperationToken {
  operationKey: string;
  commandId: string;
  sessionId: string;
  generation: number;
  nonce: number;
}

export type BeginOperationResult =
  | { accepted: true; token: OperationToken }
  | { accepted: false; reason: "blocked" | "duplicate" | "stale_session"; gate: ControlGate };

export type OperationResponseResult =
  | { accepted: true; state: CommandAck["state"]; inProgress: boolean }
  | { accepted: false; reason: "stale" | "mismatched_command" | "not_in_flight" };

function operationIdentity(operation: ControlOperation): string {
  return JSON.stringify([operation.operationKey, operation.command.run_id ?? null]);
}

function commandIsInProgress(state: CommandAck["state"]): boolean {
  return state === "accepted" || state === "executing";
}

export class ControlOperationGuard {
  private activeSessionId: string | undefined;
  private generation = 0;
  private nonce = 0;
  private readonly inFlight = new Map<string, OperationToken>();

  activateSession(sessionId: string): number {
    if (this.activeSessionId === sessionId) return this.generation;
    this.activeSessionId = sessionId;
    this.generation += 1;
    this.inFlight.clear();
    return this.generation;
  }

  begin(operation: ControlOperation, gate: ControlGate = getControlGate()): BeginOperationResult {
    if (!gate.allowed) return { accepted: false, reason: "blocked", gate };
    if (this.activeSessionId === undefined) this.activateSession(operation.command.session_id);
    if (this.activeSessionId !== operation.command.session_id) return { accepted: false, reason: "stale_session", gate };

    const key = operationIdentity(operation);
    if (this.inFlight.has(key)) return { accepted: false, reason: "duplicate", gate };

    const token: OperationToken = {
      operationKey: key,
      commandId: operation.command.command_id,
      sessionId: operation.command.session_id,
      generation: this.generation,
      nonce: ++this.nonce
    };
    this.inFlight.set(key, token);
    return { accepted: true, token };
  }

  acceptResponse(token: OperationToken, ack: CommandAck): OperationResponseResult {
    if (!this.isCurrent(token)) return { accepted: false, reason: "stale" };
    if (ack.command_id !== token.commandId) return { accepted: false, reason: "mismatched_command" };

    const inProgress = commandIsInProgress(ack.state);
    if (!inProgress) this.inFlight.delete(token.operationKey);
    return { accepted: true, state: ack.state, inProgress };
  }

  release(token: OperationToken): boolean {
    if (!this.isCurrent(token)) return false;
    this.inFlight.delete(token.operationKey);
    return true;
  }

  isCurrent(token: OperationToken): boolean {
    const current = this.inFlight.get(token.operationKey);
    return current?.nonce === token.nonce && this.activeSessionId === token.sessionId && this.generation === token.generation;
  }
}

export function createControlOperationGuard(): ControlOperationGuard {
  return new ControlOperationGuard();
}
