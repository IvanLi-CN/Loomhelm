import {
  createAuthenticatedApiClient,
  type AuthenticatedApiClientOptions,
  type AuthenticatedApiClient,
  type GeneratedApiClient
} from "@loomhelm/api-client";

export type ProductionAuthStatus = "loading" | "authenticated" | "unauthenticated" | "error";

export interface ProductionApiAssembly {
  client: GeneratedApiClient;
  auth: {
    status: ProductionAuthStatus;
    principalId?: string;
    workspaceId?: string;
    message?: string;
  };
  permissions: {
    canWrite: boolean;
    canManageProjects: boolean;
    isReadOnly: boolean;
  };
}

export interface ProductionApiAssemblyOptions {
  auth: ProductionApiAssembly["auth"];
  permissions: ProductionApiAssembly["permissions"];
  client?: GeneratedApiClient;
  clientOptions?: WebApiClientOptions;
}

export interface WebApiClientOptions {
  baseUrl?: string;
  fetch?: AuthenticatedApiClientOptions["fetch"];
  headers?: HeadersInit;
  credentials?: RequestCredentials;
  accessToken?: AuthenticatedApiClientOptions["accessToken"];
  browserProtection?: AuthenticatedApiClientOptions["browserProtection"];
  csrfToken?: NonNullable<AuthenticatedApiClientOptions["csrf"]>["getToken"];
  csrfHeaderName?: string;
  onBrowserSession?: AuthenticatedApiClientOptions["onBrowserSession"];
  onUnauthorized?: AuthenticatedApiClientOptions["onUnauthorized"];
}

export function readMetaCsrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content || undefined;
}

export function createWebApiClient(options: WebApiClientOptions = {}): AuthenticatedApiClient {
  return createAuthenticatedApiClient({
    baseUrl: options.baseUrl ?? import.meta.env.VITE_API_BASE_URL,
    fetch: options.fetch,
    headers: options.headers,
    credentials: options.credentials,
    accessToken: options.accessToken,
    browserProtection: options.browserProtection,
    csrf: options.browserProtection === "same_origin" ? undefined : {
      getToken: options.csrfToken ?? readMetaCsrfToken,
      headerName: options.csrfHeaderName
    },
    onBrowserSession: options.onBrowserSession,
    onUnauthorized: options.onUnauthorized
  });
}

export function createProductionApiAssembly({ auth, permissions, client, clientOptions }: ProductionApiAssemblyOptions): ProductionApiAssembly {
  return {
    client: client ?? createWebApiClient(clientOptions),
    auth,
    permissions
  };
}
