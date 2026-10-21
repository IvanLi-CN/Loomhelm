import {
  createAuthenticatedApiClient,
  type AuthenticatedApiClientOptions,
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

export interface WebApiClientOptions {
  baseUrl?: string;
  fetch?: AuthenticatedApiClientOptions["fetch"];
  headers?: HeadersInit;
  credentials?: RequestCredentials;
  accessToken?: AuthenticatedApiClientOptions["accessToken"];
  csrfToken?: NonNullable<AuthenticatedApiClientOptions["csrf"]>["getToken"];
  csrfHeaderName?: string;
  onUnauthorized?: AuthenticatedApiClientOptions["onUnauthorized"];
}

export function readMetaCsrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content || undefined;
}

export function createWebApiClient(options: WebApiClientOptions = {}): GeneratedApiClient {
  return createAuthenticatedApiClient({
    baseUrl: options.baseUrl ?? import.meta.env.VITE_API_BASE_URL,
    fetch: options.fetch,
    headers: options.headers,
    credentials: options.credentials,
    accessToken: options.accessToken,
    csrf: {
      getToken: options.csrfToken ?? readMetaCsrfToken,
      headerName: options.csrfHeaderName
    },
    onUnauthorized: options.onUnauthorized
  });
}

export const generatedApiClient: GeneratedApiClient | null = null;
