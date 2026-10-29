import type { GeneratedApiClient } from "@loomhelm/api-client";
import type { CommandAck, EventPage, InterruptRunRequest, SubmitRunRequest } from "@loomhelm/protocol";

import {
  ControlOperationGuard,
  getClientCommandState,
  getControlGate,
  type ClientCommandReason,
  type ClientCommandResult
} from "../sessions/control-operation-model";
import {
  advanceRecoveryCursor,
  applyEventPage,
  createRecoveryCursorState,
  createEventStreamState,
  eventBelongsToScope,
  getEventSubscriptionKey,
  getRecoveryCursor,
  getRecoveryCursorSequence,
  rememberRecoveryCursor,
  type EventStreamScope,
  type EventStreamState,
  type EventSubscription,
  type RecoveryCursorState
} from "../sessions/event-stream-model";
import { SessionRequestFence, type SessionRequestToken } from "../sessions/session-client-adapter";
import type { ConnectionAvailability } from "../sessions/session-model";

export type RunClient = Pick<GeneratedApiClient, "submitRun" | "interruptRun" | "listRunEvents">;

export interface CommandControlOptions {
  connection?: ConnectionAvailability;
  readOnly?: boolean;
}

export interface RunEventSubscription {
  id: string;
  sessionId: string;
  runId: string;
}

export interface OpaqueCursorBaseline {
  cursor: string;
  sequence: number;
}

export interface RunEventReadOptions {
  connection?: ConnectionAvailability;
  limit?: number;
}

export type RunEventReadState = "received" | "pending" | "unknown";
export type RunEventReadReason = "pending" | "stale_session" | "stale_response" | "foreign_response" | "transport" | "offline" | "reconnecting" | "unknown";

export interface RunEventReadResult {
  state: RunEventReadState;
  request?: SessionRequestToken;
  page?: EventPage;
  stream?: EventStreamState;
  reason?: RunEventReadReason;
}

function toEventSubscription(subscription: RunEventSubscription): EventSubscription {
  return { id: subscription.id, scope: { sessionId: subscription.sessionId, runId: subscription.runId } };
}

function toScope(subscription: RunEventSubscription): EventStreamScope {
  return { sessionId: subscription.sessionId, runId: subscription.runId };
}

function getCommandFailureReason(reason: "blocked" | "duplicate" | "stale_session" | "uncertain", blockReason?: ClientCommandReason): ClientCommandReason {
  if (reason === "blocked") return blockReason ?? "unknown";
  if (reason === "uncertain") return "unknown";
  return reason;
}

export class RunClientAdapter {
  private readonly requests = new SessionRequestFence();
  private readonly operations = new ControlOperationGuard();
  private recovery: RecoveryCursorState = createRecoveryCursorState();
  private readonly streams = new Map<string, EventStreamState>();
  private readonly streamVersions = new Map<string, number>();

  constructor(private readonly client: RunClient) {}

  selectSession(sessionId: string): number {
    const generation = this.requests.activateSession(sessionId);
    this.operations.activateSession(sessionId);
    return generation;
  }

  getRecoveryCursorBaseline(subscription: RunEventSubscription): OpaqueCursorBaseline | undefined {
    const eventSubscription = toEventSubscription(subscription);
    const cursor = getRecoveryCursor(this.recovery, eventSubscription);
    const sequence = getRecoveryCursorSequence(this.recovery, eventSubscription);
    return cursor === undefined || sequence === undefined ? undefined : { cursor, sequence };
  }

  seedRecoveryCursor(subscription: RunEventSubscription, baseline: OpaqueCursorBaseline): boolean {
    const eventSubscription = toEventSubscription(subscription);
    const key = getEventSubscriptionKey(eventSubscription);
    const existingSequence = Math.max(
      getRecoveryCursorSequence(this.recovery, eventSubscription) ?? Number.NEGATIVE_INFINITY,
      this.streams.get(key)?.cursorSequence ?? Number.NEGATIVE_INFINITY
    );
    if (baseline.sequence <= existingSequence) return false;

    this.recovery = rememberRecoveryCursor(this.recovery, eventSubscription, baseline.cursor, baseline.sequence);
    const stream = this.streams.get(key);
    if (stream === undefined) this.streams.set(key, createEventStreamState(toScope(subscription), baseline.cursor, baseline.sequence));
    else this.streams.set(key, { ...stream, cursor: baseline.cursor, cursorSequence: baseline.sequence });
    this.streamVersions.set(key, (this.streamVersions.get(key) ?? 0) + 1);
    return true;
  }

  getStreamState(subscription: RunEventSubscription): EventStreamState | undefined {
    return this.streams.get(getEventSubscriptionKey(toEventSubscription(subscription)));
  }

  async readRunEvents(subscription: RunEventSubscription, { connection = "online", limit }: RunEventReadOptions = {}): Promise<RunEventReadResult> {
    const eventSubscription = toEventSubscription(subscription);
    const gate = getControlGate({ connection });
    if (!gate.allowed) return { state: "unknown", reason: gate.blockReason === "offline" ? "offline" : gate.blockReason === "reconnecting" ? "reconnecting" : "unknown" };

    const key = getEventSubscriptionKey(eventSubscription);
    const stream = this.streams.get(key) ?? createEventStreamState(toScope(subscription), getRecoveryCursor(this.recovery, eventSubscription), getRecoveryCursorSequence(this.recovery, eventSubscription));
    const streamVersion = this.streamVersions.get(key) ?? 0;
    const admission = this.requests.begin(`run.events:${key}`, subscription.sessionId, stream.cursorSequence, streamVersion);
    if (!admission.accepted) {
      return {
        state: admission.reason === "pending" ? "pending" : "unknown",
        request: admission.token,
        reason: admission.reason
      };
    }

    const afterCursor = getRecoveryCursor(this.recovery, eventSubscription);
    const request = {
      run_id: subscription.runId,
      ...(afterCursor === undefined ? {} : { after_cursor: afterCursor }),
      ...(limit === undefined ? {} : { limit })
    };

    try {
      const page = await this.client.listRunEvents(request);
      const requestIsCurrent = this.requests.isCurrent(admission.token);
      const currentVersion = this.streamVersions.get(key) ?? 0;
      if (!requestIsCurrent) return { state: "unknown", reason: "stale_response", request: admission.token };
      if (currentVersion !== admission.token.baselineVersion) {
        this.requests.finish(admission.token);
        return { state: "unknown", reason: "stale_response", request: admission.token };
      }
      if (page.events.some((event) => !eventBelongsToScope(event, toScope(subscription)))) {
        this.requests.finish(admission.token);
        return { state: "unknown", reason: "foreign_response", page, request: admission.token };
      }

      const currentStream = this.streams.get(key) ?? stream;
      const applied = applyEventPage(currentStream, page);
      this.streams.set(key, applied.state);
      this.streamVersions.set(key, streamVersion + 1);
      this.requests.finish(admission.token);

      this.recovery = advanceRecoveryCursor(this.recovery, eventSubscription, page);
      return { state: "received", page, stream: applied.state, request: admission.token };
    } catch {
      if (!this.requests.isCurrent(admission.token)) return { state: "unknown", reason: "stale_response", request: admission.token };
      this.requests.finish(admission.token);
      return { state: "unknown", reason: "transport", request: admission.token };
    }
  }

  async submitRun(sessionId: string, body: SubmitRunRequest, { connection = "online", readOnly = false }: CommandControlOptions = {}): Promise<ClientCommandResult> {
    return this.executeCommand(
      `run.submit:${body.command_id}`,
      { command_id: body.command_id, session_id: sessionId },
      { connection, readOnly },
      () => this.client.submitRun({ session_id: sessionId, body })
    );
  }

  async interruptRun(sessionId: string, runId: string, body: InterruptRunRequest, { connection = "online", readOnly = false }: CommandControlOptions = {}): Promise<ClientCommandResult> {
    return this.executeCommand(
      `run.interrupt:${runId}`,
      { command_id: body.command_id, session_id: sessionId, run_id: runId },
      { connection, readOnly },
      () => this.client.interruptRun({ run_id: runId, body })
    );
  }

  private async executeCommand(operationKey: string, command: { command_id: string; session_id: string; run_id?: string }, options: CommandControlOptions, request: () => Promise<{ ack: CommandAck }>): Promise<ClientCommandResult> {
    const gate = getControlGate(options);
    if (!gate.allowed) return { state: "unknown", commandId: command.command_id, reason: gate.blockReason ?? "unknown" };

    const admission = this.operations.begin({ operationKey, command }, gate);
    if (!admission.accepted) {
      return {
        state: admission.reason === "duplicate" ? "pending" : "unknown",
        commandId: command.command_id,
        reason: getCommandFailureReason(admission.reason, admission.gate.blockReason)
      };
    }

    try {
      const response = await request();
      const accepted = this.operations.acceptResponse(admission.token, response.ack);
      if (!accepted.accepted) return { state: "unknown", commandId: command.command_id, reason: accepted.reason === "stale" ? "stale_response" : "mismatched_response" };
      return { state: getClientCommandState(response.ack.state), commandId: command.command_id, ack: response.ack };
    } catch {
      if (!this.operations.isCurrent(admission.token)) return { state: "unknown", commandId: command.command_id, reason: "stale_response" };
      this.operations.markUncertain(admission.token);
      return { state: "unknown", commandId: command.command_id, reason: "transport" };
    }
  }

  resolveUncertainSubmit(commandId: string): boolean {
    return this.operations.resolveUncertain(`run.submit:${commandId}`, commandId);
  }

  resolveUncertainInterrupt(runId: string, commandId: string): boolean {
    return this.operations.resolveUncertain(`run.interrupt:${runId}`, commandId, runId);
  }
}
