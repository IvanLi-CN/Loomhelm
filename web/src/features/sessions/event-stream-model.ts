import type { Event, EventPage } from "@loomhelm/protocol";

export interface EventStreamScope {
  sessionId: string;
  runId?: string;
}

export interface EventSubscription {
  id: string;
  scope: EventStreamScope;
}

export interface EventStreamState {
  scope: EventStreamScope;
  events: readonly Event[];
  cursor?: string;
  eventKeys: ReadonlySet<string>;
}

export type EventAcceptance = "accepted" | "duplicate" | "foreign";

export interface EventApplication {
  state: EventStreamState;
  result: EventAcceptance;
}

export interface EventPageApplication {
  state: EventStreamState;
  accepted: number;
  duplicates: number;
  foreign: number;
}

export interface RecoveryCursorState {
  entries: ReadonlyMap<string, string>;
}

function scopeKey(scope: EventStreamScope): string {
  return JSON.stringify([scope.sessionId, scope.runId ?? null]);
}

export function getEventStreamKey(scope: EventStreamScope): string {
  return scopeKey(scope);
}

export function getEventSubscriptionKey(subscription: EventSubscription): string {
  return JSON.stringify([subscription.id, scopeKey(subscription.scope)]);
}

export function eventBelongsToScope(event: Event, scope: EventStreamScope): boolean {
  return event.session_id === scope.sessionId && (scope.runId === undefined || event.run_id === scope.runId);
}

export function getEventIdentityKey(event: Event, scope: EventStreamScope): string {
  return JSON.stringify([scopeKey(scope), event.session_id, event.run_id ?? null, event.event_id]);
}

export function createEventStreamState(scope: EventStreamScope, cursor?: string): EventStreamState {
  return { scope, events: [], cursor, eventKeys: new Set<string>() };
}

export function applyEvent(state: EventStreamState, event: Event): EventApplication {
  if (!eventBelongsToScope(event, state.scope)) return { state, result: "foreign" };

  const eventKey = getEventIdentityKey(event, state.scope);
  if (state.eventKeys.has(eventKey)) return { state, result: "duplicate" };

  const eventKeys = new Set(state.eventKeys);
  eventKeys.add(eventKey);
  const events = [...state.events, event].sort((left, right) => left.sequence - right.sequence);
  return {
    state: { ...state, cursor: event.cursor, events, eventKeys },
    result: "accepted"
  };
}

export function applyEventPage(state: EventStreamState, page: EventPage): EventPageApplication {
  let current = state;
  let accepted = 0;
  let duplicates = 0;
  let foreign = 0;

  for (const event of page.events) {
    const application = applyEvent(current, event);
    current = application.state;
    if (application.result === "accepted") accepted += 1;
    if (application.result === "duplicate") duplicates += 1;
    if (application.result === "foreign") foreign += 1;
  }

  if (page.next_cursor !== undefined && foreign === 0) current = { ...current, cursor: page.next_cursor };
  return { state: current, accepted, duplicates, foreign };
}

export function createRecoveryCursorState(): RecoveryCursorState {
  return { entries: new Map<string, string>() };
}

export function getRecoveryCursor(state: RecoveryCursorState, subscription: EventSubscription): string | undefined {
  return state.entries.get(getEventSubscriptionKey(subscription));
}

export function rememberRecoveryCursor(state: RecoveryCursorState, subscription: EventSubscription, cursor: string): RecoveryCursorState {
  const entries = new Map(state.entries);
  entries.set(getEventSubscriptionKey(subscription), cursor);
  return { entries };
}

export function advanceRecoveryCursor(state: RecoveryCursorState, subscription: EventSubscription, page: EventPage): RecoveryCursorState {
  return page.next_cursor === undefined ? state : rememberRecoveryCursor(state, subscription, page.next_cursor);
}
