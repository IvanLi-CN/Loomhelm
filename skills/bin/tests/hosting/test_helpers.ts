import type {
  HostingBackend,
  ProviderResponse,
} from "../../modules/hosting/backend";
import type { RepositoryBinding } from "../../modules/hosting/types";

export const head = "a".repeat(40);

export function fakeBackend(
  binding: RepositoryBinding,
  responses: Array<ProviderResponse | Error>,
): HostingBackend & {
  calls: Array<{ endpoint: string; options: unknown }>;
} {
  const calls: Array<{ endpoint: string; options: unknown }> = [];
  return {
    binding,
    calls,
    async request(endpoint, options = {}) {
      calls.push({ endpoint, options });
      const result = responses.shift();
      if (!result) throw new Error(`unexpected request ${endpoint}`);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

export function response(payload: unknown, status = 200): ProviderResponse {
  return {
    status,
    payload,
    exitCode: status >= 400 ? 1 : 0,
    observedAt: "2026-10-30T00:00:00.000Z",
  };
}
