import { createGeneratedApiClient, type LoomhelmApiClient } from "./generated";

export * from "./generated";

export type GeneratedApiClient = LoomhelmApiClient;

export type ApiClientFactory<TClient = GeneratedApiClient> = () => TClient;

export function createApiClient<TClient>(factory: ApiClientFactory<TClient>): TClient {
  return factory();
}

export type CsrfTokenReader = () => string | undefined | Promise<string | undefined>;
export type AccessTokenReader = () => string | undefined | Promise<string | undefined>;

export interface AuthenticatedApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
  credentials?: RequestCredentials;
  accessToken?: AccessTokenReader;
  csrf?: {
    getToken: CsrfTokenReader;
    headerName?: string;
  };
  onUnauthorized?: (response: Response) => void | Promise<void>;
}

export class ApiClientConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiClientConfigurationError";
  }
}

const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isMutationMethod(method: string | undefined): boolean {
  return mutationMethods.has((method ?? "GET").toUpperCase());
}

export function createAuthenticatedApiClient(options: AuthenticatedApiClientOptions = {}): GeneratedApiClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new ApiClientConfigurationError("a fetch implementation is required");

  const fetchWithAuthentication: typeof globalThis.fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    const method = (init.method ?? "GET").toString().toUpperCase();
    const accessToken = await options.accessToken?.();
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);

    if (isMutationMethod(method)) {
      if (!options.csrf) {
        throw new ApiClientConfigurationError("CSRF transport is not configured for an API mutation");
      }
      const csrfToken = await options.csrf.getToken();
      if (!csrfToken) {
        throw new ApiClientConfigurationError("CSRF token is unavailable for an API mutation");
      }
      headers.set(options.csrf.headerName ?? "X-CSRF-Token", csrfToken);
    }

    const response = await fetcher(input, {
      ...init,
      credentials: options.credentials ?? "include",
      headers
    });

    if (response.status === 401 && options.onUnauthorized) {
      try {
        await options.onUnauthorized(response.clone());
      } catch {
        // Preserve the generated client's ApiClientError as the request result.
      }
    }
    return response;
  };

  return createGeneratedApiClient({
    baseUrl: options.baseUrl,
    fetch: fetchWithAuthentication,
    headers: options.headers
  });
}
