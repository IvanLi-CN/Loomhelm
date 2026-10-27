import type { GeneratedApiClient } from "@loomhelm/api-client";
import type { Approval, ApprovalDecision, ResolveApprovalRequest } from "@loomhelm/protocol";

import {
  ControlOperationGuard,
  getClientCommandState,
  getControlGate,
  type ClientCommandResult
} from "../sessions/control-operation-model";
import type { ConnectionAvailability } from "../sessions/session-model";

export type ApprovalClient = Pick<GeneratedApiClient, "resolveApproval">;

export interface ApprovalResolutionInput {
  sessionId: string;
  approval: Pick<Approval, "id" | "run_id" | "revision" | "status">;
  commandId: string;
  decision: ApprovalDecision;
}

export interface ApprovalResolutionOptions {
  connection?: ConnectionAvailability;
  readOnly?: boolean;
}

export class ApprovalClientAdapter {
  private readonly operations = new ControlOperationGuard();

  constructor(private readonly client: ApprovalClient) {}

  selectSession(sessionId: string): number {
    return this.operations.activateSession(sessionId);
  }

  async resolve({ sessionId, approval, commandId, decision }: ApprovalResolutionInput, { connection = "online", readOnly = false }: ApprovalResolutionOptions = {}): Promise<ClientCommandResult> {
    const gate = getControlGate({ connection, readOnly, approvalStatus: approval.status });
    if (!gate.allowed) return { state: "unknown", commandId, reason: gate.blockReason ?? "unknown" };

    const body: ResolveApprovalRequest = { command_id: commandId, decision, revision: approval.revision };
    const admission = this.operations.begin({
      operationKey: `approval.resolve:${approval.id}:${approval.revision}`,
      command: { command_id: commandId, session_id: sessionId, run_id: approval.run_id }
    }, gate);
    if (!admission.accepted) {
      return {
        state: admission.reason === "duplicate" ? "pending" : "unknown",
        commandId,
        reason: admission.reason === "duplicate" ? "duplicate" : admission.reason === "stale_session" ? "stale_session" : admission.gate.blockReason ?? "unknown"
      };
    }

    try {
      const response = await this.client.resolveApproval({ approval_id: approval.id, run_id: approval.run_id, body });
      const accepted = this.operations.acceptResponse(admission.token, response.ack);
      if (!accepted.accepted) return { state: "unknown", commandId, reason: accepted.reason === "stale" ? "stale_response" : "mismatched_response" };
      return { state: getClientCommandState(response.ack.state), commandId, ack: response.ack };
    } catch {
      if (!this.operations.isCurrent(admission.token)) return { state: "unknown", commandId, reason: "stale_response" };
      this.operations.release(admission.token);
      return { state: "unknown", commandId, reason: "transport" };
    }
  }
}
