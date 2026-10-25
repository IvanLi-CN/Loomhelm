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
  cursorSequence?: number;
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
  cursorSequences: ReadonlyMap<string, number>;
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

function latestEvent(events: readonly Event[]): Event | undefined {
  return events.reduce<Event | undefined>((latest, event) => latest === undefined || event.sequence > latest.sequence ? event : latest, undefined);
}

function getPagePosition(page: EventPage): { cursor: string; sequence: number } | undefined {
  const latest = latestEvent(page.events);
  if (latest === undefined) return undefined;
  const last = page.events[page.events.length - 1];
  // F05 pages are ordered by sequence; malformed order must not make an opaque cursor move backward.
  const cursor = page.next_cursor !== undefined && last.sequence === latest.sequence ? page.next_cursor : latest.cursor;
  return { cursor, sequence: latest.sequence };
}

export function applyEvent(state: EventStreamState, event: Event): EventApplication {
  if (!eventBelongsToScope(event, state.scope)) return { state, result: "foreign" };

  const eventKey = getEventIdentityKey(event, state.scope);
  if (state.eventKeys.has(eventKey)) return { state, result: "duplicate" };

  const eventKeys = new Set(state.eventKeys);
  eventKeys.add(eventKey);
  const events = [...state.events, event].sort((left, right) => left.sequence - right.sequence);
  const advancesCursor = state.cursorSequence === undefined || event.sequence > state.cursorSequence;
  return {
    state: {
      ...state,
      cursor: advancesCursor ? event.cursor : state.cursor,
      cursorSequence: advancesCursor ? event.sequence : state.cursorSequence,
      events,
      eventKeys
    },
    result: "accepted"
  };
}

export function applyEventPage(state: EventStreamState, page: EventPage): EventPageApplication {
  const baselineSequence = state.cursorSequence;
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

  const pagePosition = getPagePosition(page);
  if (foreign > 0) {
    current = { ...current, cursor: state.cursor, cursorSequence: baselineSequence };
  } else if (pagePosition !== undefined && (baselineSequence === undefined || pagePosition.sequence > baselineSequence)) {
    current = { ...current, cursor: pagePosition.cursor, cursorSequence: pagePosition.sequence };
  }
  return { state: current, accepted, duplicates, foreign };
}

export function createRecoveryCursorState(): RecoveryCursorState {
  return { entries: new Map<string, string>(), cursorSequences: new Map<string, number>() };
}

export function getRecoveryCursor(state: RecoveryCursorState, subscription: EventSubscription): string | undefined {
  return state.entries.get(getEventSubscriptionKey(subscription));
}

export function rememberRecoveryCursor(state: RecoveryCursorState, subscription: EventSubscription, cursor: string): RecoveryCursorState {
  const key = getEventSubscriptionKey(subscription);
  const entries = new Map(state.entries);
  const cursorSequences = new Map(state.cursorSequences);
  entries.set(key, cursor);
  cursorSequences.delete(key);
  return { entries, cursorSequences };
}

export function advanceRecoveryCursor(state: RecoveryCursorState, subscription: EventSubscription, page: EventPage): RecoveryCursorState {
  if (page.events.length === 0 || page.events.some((event) => !eventBelongsToScope(event, subscription.scope))) return state;

  const position = getPagePosition(page);
  if (position === undefined) return state;

  const key = getEventSubscriptionKey(subscription);
  const previousSequence = state.cursorSequences.get(key);
  if (previousSequence !== undefined && position.sequence <= previousSequence) return state;

  const entries = new Map(state.entries);
  const cursorSequences = new Map(state.cursorSequences);
  entries.set(key, position.cursor);
  cursorSequences.set(key, position.sequence);
  return { entries, cursorSequences };
}
