import { z } from "zod";
import { readCodexCapabilities } from "../lib/codex-agent-api";
import { mutateExecutionProfile } from "../lib/profile-mutation";
import { ContractError, requireCondition } from "../lib/errors";
import { validateLedger } from "../lib/schema";
import { requestSchema } from "../lib/engine";
import { readBodyWithinLimit } from "../lib/server-files";
import type { DashboardOptions } from "../lib/server-contract";
import type { LedgerStore } from "../lib/store";

export async function handleProfileRequest(
  request: Request,
  options: DashboardOptions,
  store: LedgerStore,
  responseHeaders: Record<string, string>,
  onRevision: (revision: number) => void,
): Promise<Response> {
  const headers = responseHeaders;
  if (request.method === "GET") {
    const ledger = validateLedger(store.read());
    return Response.json(
      {
        default_profile: ledger.config.execution_profile,
        read_only:
          options.readOnly === true || !ledger.config.execution_profile,
        capabilities: await (
          options.getProfileCapabilities ?? readCodexCapabilities
        )(),
      },
      { headers: responseHeaders },
    );
  }
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers });
  requireCondition(
    !options.readOnly,
    "READ_ONLY_SOURCE",
    "External source viewers are read-only",
    3,
  );
  const body = await readBodyWithinLimit(request, 16 * 1024);
  if (body === null)
    return Response.json(
      { error: "request_body_too_large" },
      { status: 413, headers },
    );
  const parsed = requestSchema.parse(JSON.parse(body));
  requireCondition(
    parsed.run_id === options.runId,
    "RUN_MISMATCH",
    "Request refers to another run",
    3,
  );
  const command =
    parsed.payload.recommend === true
      ? "execution-profile-recommend"
      : parsed.payload.target_type === "run"
        ? "execution-profile-default-update"
        : "execution-profile-update";
  const result = await mutateExecutionProfile(
    store,
    command,
    parsed,
    options.getProfileCapabilities ?? readCodexCapabilities,
  );
  const updated = validateLedger(store.read());
  onRevision(updated.revision);
  return Response.json(result, { headers: responseHeaders });
}

export function profileErrorResponse(
  error: unknown,
  headers: Record<string, string>,
): Response {
  const code =
    error instanceof ContractError
      ? error.code
      : error instanceof z.ZodError || error instanceof SyntaxError
        ? "INVALID_INPUT"
        : "CAPABILITIES_UNAVAILABLE";
  const status = ["FORBIDDEN", "ACTOR_MISMATCH", "READ_ONLY_SOURCE"].includes(
    code,
  )
    ? 403
    : [
          "REVISION_CONFLICT",
          "PROFILE_FROZEN",
          "PROFILE_MIGRATION_REQUIRED",
        ].includes(code)
      ? 409
      : code === "CAPABILITIES_UNAVAILABLE"
        ? 503
        : 400;
  return Response.json(
    {
      error: code,
      message: error instanceof Error ? error.message : String(error),
    },
    { status, headers },
  );
}
