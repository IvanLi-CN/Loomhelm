import { z } from "zod";
import { requireCondition } from "./errors";

export const API_VERSION = 1;
export const FRONTEND_CONTRACT = 1;
export const AGENT_TTL_MS = 60 * 60_000;
export const BROWSER_TTL_MS = 5 * 60_000;
export const compatibility = {
  api_versions: [API_VERSION],
  frontend_contracts: [FRONTEND_CONTRACT],
  readable: [
    "schema-1/legacy",
    "schema-1/contract-1",
    "schema-2/contract-1",
    "schema-2/contract-2",
  ],
  writable: ["schema-2/contract-2"],
};

export const releaseManifestSchema = z
  .object({
    schema_version: z.literal(1),
    build_id: z.string().regex(/^[a-f0-9]{64}$/),
    source_sha: z.string().regex(/^[a-f0-9]{40}$/),
    service_version: z.string().min(1),
    platform: z.enum([
      "darwin-arm64",
      "darwin-x64",
      "linux-x64",
      "linux-arm64",
    ]),
    api_versions: z.array(z.number().int().positive()).min(1),
    frontend_contracts: z.array(z.number().int().positive()).min(1),
    readable: z.array(z.string()).min(1),
    writable: z.array(z.string()).min(1),
    files: z.record(
      z.string().regex(/^(viewer|viewer\.mjs|posix\.node|dist\/(index\.html|app\.js|app\.css))$/),
      z.string().regex(/^[a-f0-9]{64}$/),
    ),
  })
  .strict();
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export const configSchema = z
  .object({
    schema_version: z.literal(1),
    port: z.number().int().min(10000).max(65535),
    registry_dir: z.string().startsWith("/"),
    current_build: z.string().regex(/^[a-f0-9]{64}$/),
    previous_build: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    agent_ttl_ms: z
      .number()
      .int()
      .min(1000)
      .max(24 * 60 * 60_000)
      .default(AGENT_TTL_MS),
  })
  .strict();
export type ServiceConfig = z.infer<typeof configSchema>;

export function ledgerContract(value: unknown): string {
  const ledger = value as Record<string, unknown> | null;
  return (
    `schema-${ledger?.schema_version}/` +
    (ledger?.contract_version === undefined
      ? "legacy"
      : `contract-${ledger.contract_version}`)
  );
}

export function requireLedgerCompatibility(
  value: unknown,
  mode: "read" | "write" = "read",
): void {
  const supported =
    mode === "read" ? compatibility.readable : compatibility.writable;
  requireCondition(
    supported.includes(ledgerContract(value)),
    "INCOMPATIBLE_LEDGER",
    "Ledger schema/contract is not supported; explicit migration is required",
  );
}

export function requireApi(version: number): void {
  requireCondition(
    compatibility.api_versions.includes(version),
    "INCOMPATIBLE_API",
    "Installed viewer does not support the requested API; explicit maintenance is required",
  );
}
