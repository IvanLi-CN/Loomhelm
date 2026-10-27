import { createGeneratedApiClient, type LoomhelmApiClient } from "./generated";

export * from "./generated";

export type GeneratedApiClient = LoomhelmApiClient;

export type BrowserSessionBootstrap = Awaited<ReturnType<LoomhelmApiClient["getBrowserSession"]>>;

export type BrowserProtectionMode = "same_origin";

export const EXPECTED_PRINCIPAL_HEADER = "X-Loomhelm-Expected-Principal";

export interface AuthenticatedApiClient extends GeneratedApiClient {
  bootstrapBrowserSession: () => Promise<BrowserSessionBootstrap>;
  invalidateBrowserSession: () => void;
  bindBrowserSession: (binding: BrowserSessionBinding) => GeneratedApiClient;
}

export interface BrowserSessionBinding {
  principalId: string;
  epoch: number;
}

interface ActiveBrowserSessionBinding extends BrowserSessionBinding {
  clientEpoch: number;
}

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
  browserProtection?: BrowserProtectionMode;
  csrf?: {
    getToken: CsrfTokenReader;
    headerName?: string;
  };
  onBrowserSession?: (session: BrowserSessionBootstrap) => void | Promise<void>;
  onUnauthorized?: (response: Response) => void | Promise<void>;
}

export class ApiClientConfigurationError extends Error {
  readonly requestSent: boolean;

  constructor(message: string, requestSent = false) {
    super(message);
    this.name = "ApiClientConfigurationError";
    this.requestSent = requestSent;
  }
}

const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isMutationMethod(method: string | undefined): boolean {
  return mutationMethods.has((method ?? "GET").toUpperCase());
}

function validateBrowserSession(value: unknown): BrowserSessionBootstrap {
  if (!value || typeof value !== "object") {
    throw new ApiClientConfigurationError("browser session bootstrap is not an object");
  }
  const session = value as Partial<BrowserSessionBootstrap>;
  if (typeof session.user_id !== "string" || session.user_id.trim().length === 0) {
    throw new ApiClientConfigurationError("browser session bootstrap has no valid user_id");
  }
  if (session.csrf_protection !== "same_origin") {
    throw new ApiClientConfigurationError("browser session bootstrap does not declare same_origin protection");
  }
  return { user_id: session.user_id, csrf_protection: "same_origin" };
}

function validateSameOriginBaseUrl(baseUrl?: string): void {
  if (baseUrl === undefined || typeof location === "undefined") return;
  let resolved: URL;
  try {
    resolved = new URL(baseUrl, location.origin);
  } catch {
    throw new ApiClientConfigurationError("same_origin browser protection requires a valid API base URL");
  }
  if (resolved.origin !== location.origin) {
    throw new ApiClientConfigurationError("same_origin browser protection requires the API base URL to share the page origin");
  }
}

function hasAuthorizationHeader(headers?: HeadersInit): boolean {
  if (!headers) return false;
  try {
    return new Headers(headers).has("authorization");
  } catch {
    throw new ApiClientConfigurationError("same_origin browser protection requires valid request headers");
  }
}

function validateBrowserSessionBinding(binding: BrowserSessionBinding): void {
  if (typeof binding.principalId !== "string" || binding.principalId.trim().length === 0) {
    throw new ApiClientConfigurationError("browser session binding requires a principal");
  }
  if (!Number.isInteger(binding.epoch) || binding.epoch < 0) {
    throw new ApiClientConfigurationError("browser session binding requires a nonnegative epoch");
  }
}

export function createAuthenticatedApiClient(options: AuthenticatedApiClientOptions = {}): AuthenticatedApiClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new ApiClientConfigurationError("a fetch implementation is required");
  const sameOriginProtection = options.browserProtection === "same_origin";
  if (sameOriginProtection) validateSameOriginBaseUrl(options.baseUrl);
  if (sameOriginProtection && (options.accessToken || hasAuthorizationHeader(options.headers))) {
    throw new ApiClientConfigurationError("same_origin protection cannot be combined with bearer access token transport");
  }
  if (sameOriginProtection && options.csrf) {
    throw new ApiClientConfigurationError("same_origin protection cannot be combined with token CSRF transport");
  }

  let browserSession: BrowserSessionBootstrap | undefined;
  let bootstrapPromise: Promise<BrowserSessionBootstrap> | undefined;
  let browserSessionGeneration = 0;

  const invalidateBrowserSession = (): void => {
    browserSessionGeneration += 1;
    browserSession = undefined;
    bootstrapPromise = undefined;
  };

  const notifyUnauthorized = async (response: Response, notifyAuthAssembly = true): Promise<void> => {
    if (response.status !== 401) return;
    invalidateBrowserSession();
    if (!notifyAuthAssembly || !options.onUnauthorized) return;
    try {
      await options.onUnauthorized(response.clone());
    } catch {
      // Preserve the generated client's ApiClientError as the request result.
    }
  };

  const fetchBrowserSession: typeof globalThis.fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    const response = await fetcher(input, {
      ...init,
      credentials: options.credentials ?? "include",
      headers
    });
    await notifyUnauthorized(response, false);
    return response;
  };

  const bootstrapClient = sameOriginProtection
    ? createGeneratedApiClient({ baseUrl: options.baseUrl, fetch: fetchBrowserSession, headers: undefined })
    : undefined;

  const bootstrapBrowserSession = async (): Promise<BrowserSessionBootstrap> => {
    if (!sameOriginProtection || !bootstrapClient) {
      throw new ApiClientConfigurationError("same_origin browser protection is not configured");
    }
    if (browserSession) return browserSession;
    if (!bootstrapPromise) {
      const requestGeneration = browserSessionGeneration;
      bootstrapPromise = (async () => {
        const session = validateBrowserSession(await bootstrapClient.getBrowserSession());
        if (requestGeneration !== browserSessionGeneration) {
          throw new ApiClientConfigurationError("browser session bootstrap was invalidated before it completed");
        }
        await options.onBrowserSession?.(session);
        if (requestGeneration !== browserSessionGeneration) {
          throw new ApiClientConfigurationError("browser session bootstrap was invalidated while it was being assembled");
        }
        browserSession = session;
        return session;
      })().finally(() => {
        if (requestGeneration === browserSessionGeneration) bootstrapPromise = undefined;
      });
    }
    return bootstrapPromise;
  };

  const fetchWithAuthentication: typeof globalThis.fetch = async (input, init = {}) => {
    return fetchAuthenticated(input, init);
  };

  const fetchAuthenticated = async (input: RequestInfo | URL, init: RequestInit = {}, binding?: ActiveBrowserSessionBinding): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (sameOriginProtection && headers.has("authorization")) {
      throw new ApiClientConfigurationError("same_origin protection cannot send an Authorization header");
    }
    if (binding && !isCurrentBrowserSessionBinding(binding)) {
      throw new ApiClientConfigurationError("browser session binding is no longer current");
    }
    const method = (init.method ?? "GET").toString().toUpperCase();
    const accessToken = await options.accessToken?.();
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);

    if (sameOriginProtection) {
      if (!browserSession) {
        throw new ApiClientConfigurationError("same_origin browser session bootstrap is required before an API request");
      }
      if (binding) headers.set(EXPECTED_PRINCIPAL_HEADER, binding.principalId);
    } else if (isMutationMethod(method)) {
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

    await notifyUnauthorized(response);
    if (binding && response.status !== 401 && !isCurrentBrowserSessionBinding(binding)) {
      throw new ApiClientConfigurationError("browser session binding was invalidated while the request was in flight", true);
    }
    return response;
  };

  const isCurrentBrowserSessionBinding = (binding: ActiveBrowserSessionBinding): boolean => (
    browserSessionGeneration === binding.clientEpoch
      && browserSession?.user_id === binding.principalId
  );

  const client = createGeneratedApiClient({
    baseUrl: options.baseUrl,
    fetch: fetchWithAuthentication,
    headers: sameOriginProtection ? undefined : options.headers
  });

  if (sameOriginProtection) {
    client.getBrowserSession = () => bootstrapBrowserSession();
  }
  const wrapLogoutWithInvalidation = (boundClient: GeneratedApiClient): GeneratedApiClient => {
    const logoutBrowserSession = boundClient.logoutBrowserSession.bind(boundClient);
    boundClient.logoutBrowserSession = async (request) => {
      try {
        return await logoutBrowserSession(request);
      } finally {
        invalidateBrowserSession();
      }
    };
    return boundClient;
  };

  const bindBrowserSession = (binding: BrowserSessionBinding): GeneratedApiClient => {
    if (!sameOriginProtection) {
      throw new ApiClientConfigurationError("browser session binding requires same_origin protection");
    }
    validateBrowserSessionBinding(binding);
    const immutableBinding = {
      principalId: binding.principalId,
      epoch: binding.epoch,
      clientEpoch: browserSessionGeneration
    };
    return wrapLogoutWithInvalidation(createGeneratedApiClient({
      baseUrl: options.baseUrl,
      fetch: (input, init = {}) => fetchAuthenticated(input, init, immutableBinding),
      headers: undefined
    }));
  };
  wrapLogoutWithInvalidation(client);

  return Object.assign(client, { bootstrapBrowserSession, invalidateBrowserSession, bindBrowserSession });
}
