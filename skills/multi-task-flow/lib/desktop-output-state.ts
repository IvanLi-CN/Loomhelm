import { record, type JsonRecord } from "../lib/codex-socket";

type Path = Array<string | number>;
const safe = (key: string | number) =>
  !["__proto__", "prototype", "constructor"].includes(String(key));
// Preserve platform indexes while retaining public assistant content only.
function item(value: unknown): unknown {
  const source = record(value);
  if (source?.type !== "agentMessage") return null;
  return Object.fromEntries(
    ["type", "id", "text", "phase", "completedAtMs"]
      .filter((k) => k in source)
      .map((k) => [k, source[k]]),
  );
}
function turn(value: unknown): unknown {
  const source = record(value);
  if (!source) return null;
  return {
    turnId: source.turnId,
    id: source.id,
    status: source.status,
    completedItemIds: source.completedItemIds,
    items: Array.isArray(source.items) ? source.items.map(item) : [],
  };
}
function state(value: unknown): JsonRecord {
  const source = record(value) ?? {};
  const history = record(record(source.turnHistory)?.history);
  const entities = record(history?.entitiesByKey) ?? {};
  return {
    turns: Array.isArray(source.turns) ? source.turns.map(turn) : [],
    turnHistory: {
      history: {
        islands: history?.islands ?? [],
        entitiesByKey: Object.fromEntries(
          Object.entries(entities)
            .filter(([k]) => safe(k))
            .map(([k, v]) => [k, turn(v)]),
        ),
      },
    },
  };
}
function project(path: Path, value: unknown): unknown {
  const last = path.at(-1);
  if (!path.length) return state(value);
  if (last === "turns") return Array.isArray(value) ? value.map(turn) : [];
  if (last === "turnHistory") return state({ turnHistory: value }).turnHistory;
  if (last === "history")
    return record(state({ turnHistory: { history: value } }).turnHistory)
      ?.history;
  if (last === "entitiesByKey")
    return record(
      record(
        state({ turnHistory: { history: { entitiesByKey: value } } })
          .turnHistory,
      )?.history,
    )?.entitiesByKey;
  if (path.at(-2) === "entitiesByKey" || path.at(-2) === "turns")
    return turn(value);
  if (last === "items") return Array.isArray(value) ? value.map(item) : [];
  if (path.at(-2) === "items") return item(value);
  return value;
}
function patch(root: JsonRecord, change: JsonRecord): JsonRecord {
  if (
    !Array.isArray(change.path) ||
    !change.path.every(
      (k) => (typeof k === "string" || Number.isInteger(k)) && safe(k),
    )
  )
    throw new Error("Invalid desktop patch path");
  const path = change.path as Path;
  if (!path.length) return state(change.value);
  if (!["turns", "turnHistory"].includes(String(path[0]))) return root;
  let target: any = root;
  for (const key of path.slice(0, -1)) {
    if (target === null) return root; // Tool, user, and reasoning item placeholders.
    if (!target || typeof target !== "object" || !Object.hasOwn(target, key))
      throw new Error("Desktop patch gap");
    target = target[key];
  }
  if (target === null) return root;
  if (!target || typeof target !== "object")
    throw new Error("Invalid desktop patch target");
  const key = path.at(-1)!;
  if (
    path.includes("items") &&
    path.at(-2) !== "items" &&
    !["type", "id", "text", "phase", "completedAtMs"].includes(String(key))
  )
    return root;
  if (change.op === "remove") {
    if (Array.isArray(target)) target.splice(Number(key), 1);
    else delete target[key];
  } else if (change.op === "add" || change.op === "replace") {
    const value = project(path, change.value);
    if (Array.isArray(target)) {
      if (
        !Number.isInteger(key) ||
        Number(key) < 0 ||
        Number(key) > target.length
      )
        throw new Error("Invalid desktop array index");
      if (change.op === "add") target.splice(Number(key), 0, value);
      else target[Number(key)] = value;
    } else target[key] = value;
  } else throw new Error("Unsupported desktop patch");
  return root;
}
export class DesktopOutputState {
  revision: number | null = null;
  private value: JsonRecord = {};
  update(
    change: JsonRecord,
  ): { turnId: string; item: JsonRecord; complete: boolean } | null {
    if (!Number.isSafeInteger(change.revision))
      throw new Error("Invalid desktop revision");
    if (this.revision !== null && Number(change.revision) <= this.revision)
      return null;
    if (change.type === "snapshot")
      this.value = state(change.conversationState);
    else if (
      change.type === "patches" &&
      change.baseRevision === this.revision &&
      Array.isArray(change.patches)
    ) {
      for (const p of change.patches) {
        const value = record(p);
        if (!value) throw new Error("Invalid desktop patch");
        this.value = patch(this.value, value);
      }
    } else throw new Error("Desktop revision gap");
    this.revision = Number(change.revision);
    const history = record(record(this.value.turnHistory)?.history);
    const entities = record(history?.entitiesByKey) ?? {};
    const islands = Array.isArray(history?.islands) ? history.islands : [];
    const ordered = islands.flatMap((i) =>
      Array.isArray(record(i)?.entries)
        ? (record(i)!.entries as unknown[]).map(
            (e) => entities[String(record(e)?.value)],
          )
        : [],
    );
    const turns = ordered.length
      ? ordered
      : Array.isArray(this.value.turns)
        ? this.value.turns
        : [];
    for (const entry of [...turns].reverse()) {
      const t = record(entry);
      if (!t || !Array.isArray(t.items)) continue;
      for (const v of [...t.items].reverse()) {
        const i = record(v);
        if (
          i?.type !== "agentMessage" ||
          typeof i.id !== "string" ||
          typeof i.text !== "string" ||
          !i.text.trim()
        )
          continue;
        const turnId = typeof t.turnId === "string" ? t.turnId : t.id;
        if (typeof turnId !== "string") continue;
        return {
          turnId,
          item: i,
          complete:
            typeof i.completedAtMs === "number" ||
            record(t.completedItemIds)?.[i.id] === true ||
            t.status === "completed",
        };
      }
    }
    return null;
  }
}
