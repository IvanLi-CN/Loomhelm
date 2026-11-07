import { HostingError } from "./types";
import type { ProviderResponse } from "./backend";

export function providerRecord(
  payload: unknown,
  operation: string,
): Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload))
    throw new HostingError(
      "invalid_provider_response",
      "provider response is not an object",
      operation,
    );
  return payload as Record<string, unknown>;
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function providerSha(value: unknown): string {
  return /^[0-9a-f]{40}$/i.test(stringValue(value))
    ? stringValue(value).toLowerCase()
    : "";
}

export function unsupportedResponse(response: ProviderResponse): boolean {
  return [404, 405, 501].includes(response.status ?? -1);
}

export function requiredShaValue(
  value: string,
  name: string,
  operation: string,
): string {
  if (!/^[0-9a-f]{40}$/i.test(value.trim()))
    throw new HostingError(
      "invalid_sha",
      `--${name} must be a 40-character commit SHA`,
      operation,
    );
  return value.trim().toLowerCase();
}
