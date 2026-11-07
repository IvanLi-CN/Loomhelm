import { createHash } from "node:crypto";
import {
  FIELDS,
  RegistryError,
  assertTcpPort,
  parseIntValue,
  portListening,
  serviceOffset,
  type LeaseRow,
} from "./port_registry_shared";

export function stableScopeCandidateBases(
  scopeId: string,
  startBase: number,
  step: number,
  usedBases: Set<number>,
): number[] {
  const candidates: number[] = [];
  for (let base = startBase; base <= 65535; base += step)
    if (!usedBases.has(base)) candidates.push(base);
  return candidates.sort((a, b) =>
    createHash("sha256")
      .update(`${scopeId}\0${a}`)
      .digest("hex")
      .localeCompare(
        createHash("sha256").update(`${scopeId}\0${b}`).digest("hex"),
      ),
  );
}

export async function selectPort(
  rows: LeaseRow[],
  scopeId: string,
  serviceValue: string,
  startBase: number,
  step: number,
  blockSize: number,
  probe: (port: number) => Promise<boolean> | boolean = portListening,
): Promise<[number, number]> {
  const service = serviceValue.trim().toLowerCase();
  const existing = rows.find(
    (row) => row.scope_id === scopeId && row.service === service,
  );
  if (existing) {
    const port = parseIntValue(existing.port, "port");
    return [
      port,
      existing.port_base
        ? parseIntValue(existing.port_base, "port_base")
        : port - (port % Math.max(blockSize, 1)),
    ];
  }
  const usedPorts = new Set(rows.map((row) => parseIntValue(row.port, "port")));
  const usedBases = new Set(
    rows.flatMap((row) =>
      row.port_base ? [parseIntValue(row.port_base, "port_base")] : [],
    ),
  );
  const existingBases = rows
    .filter((row) => row.scope_id === scopeId && row.port_base)
    .map((row) => parseIntValue(row.port_base, "port_base"))
    .filter((base, index, all) => all.indexOf(base) === index);
  const preferred = serviceOffset(service);
  const offsets = Array.from({ length: blockSize }, (_, index) => index).sort(
    (a, b) => (a === preferred ? -1 : b === preferred ? 1 : a - b),
  );
  for (const base of [
    ...existingBases,
    ...stableScopeCandidateBases(scopeId, startBase, step, usedBases),
  ])
    for (const offset of offsets) {
      const port = base + offset;
      if (
        port >= 1 &&
        port <= 65535 &&
        !usedPorts.has(port) &&
        !(await probe(port))
      )
        return [port, base];
    }
  throw new RegistryError("no available port candidates in configured range");
}

export function upsertRow(
  rows: LeaseRow[],
  payload: Partial<LeaseRow>,
  refreshClaimedAt: boolean,
  now: string,
): [LeaseRow, boolean] {
  const scope = payload.scope_id ?? "";
  const service = (payload.service ?? "").trim().toLowerCase();
  const existing = rows.find(
    (row) => row.scope_id === scope && row.service === service,
  );
  if (existing) {
    if ((payload.port && payload.port !== existing.port) || refreshClaimedAt)
      existing.claimed_at = now;
    for (const field of FIELDS)
      if (field !== "claimed_at" && field !== "last_seen_at" && payload[field])
        existing[field] = payload[field] as string;
    existing.service = service;
    existing.last_seen_at = now;
    return [existing, false];
  }
  const row = Object.fromEntries(
    FIELDS.map((field) => [field, ""]),
  ) as LeaseRow;
  for (const field of FIELDS)
    if (payload[field] !== undefined) row[field] = payload[field] as string;
  row.service = service;
  row.claimed_at = now;
  row.last_seen_at = now;
  rows.push(row);
  return [row, true];
}
