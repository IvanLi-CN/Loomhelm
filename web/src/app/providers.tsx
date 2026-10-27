import { ApiClientError, type AuthenticatedApiClient, type BrowserSessionBootstrap } from "@loomhelm/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";

import {
  createProductionApiAssembly,
  type ProductionApiAssembly
} from "@/lib/api/client";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 30_000
    }
  }
});

const ProductionApiContext = createContext<ProductionApiAssembly | null>(null);

export const PRODUCTION_AUTH_INVALIDATED_EVENT = "loomhelm:production-auth-invalidated";
const PRODUCTION_AUTH_INVALIDATION_CHANNEL = "loomhelm-production-auth-invalidated";
const PRODUCTION_AUTH_INVALIDATION_STORAGE_KEY = "loomhelm.production-auth-invalidated";

interface ProductionAuthInvalidationSignal {
  nonce: string;
  reason: "session-invalidated";
}

function parseProductionAuthInvalidationSignal(value: unknown): ProductionAuthInvalidationSignal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const signal = value as Partial<ProductionAuthInvalidationSignal>;
  return signal.reason === "session-invalidated" && typeof signal.nonce === "string" && signal.nonce.length > 0
    ? { nonce: signal.nonce, reason: signal.reason }
    : undefined;
}

export function publishProductionAuthInvalidation(): void {
  if (typeof window === "undefined") return;
  const signal: ProductionAuthInvalidationSignal = {
    nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    reason: "session-invalidated"
  };
  window.dispatchEvent(new CustomEvent<ProductionAuthInvalidationSignal>(PRODUCTION_AUTH_INVALIDATED_EVENT, { detail: signal }));
  try {
    window.localStorage.setItem(PRODUCTION_AUTH_INVALIDATION_STORAGE_KEY, JSON.stringify(signal));
  } catch {
    // BroadcastChannel remains available when localStorage is blocked.
  }
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(PRODUCTION_AUTH_INVALIDATION_CHANNEL);
    channel.postMessage(signal);
    channel.close();
  }
}

const emptyPermissions: ProductionApiAssembly["permissions"] = {
  canWrite: false,
  canManageProjects: false,
  isReadOnly: true
};

export interface ProductionAuthActions {
  login: () => void;
  logout: () => Promise<{ ok: true } | { ok: false; message: string }>;
  logoutPending: boolean;
}

const defaultAuthActions: ProductionAuthActions = {
  login: () => {
    if (typeof window !== "undefined") window.location.assign("/api/v1/auth/oidc/start");
  },
  logout: async () => ({ ok: false, message: "浏览器认证入口尚未接入。" }),
  logoutPending: false
};

const ProductionAuthContext = createContext<ProductionAuthActions>(defaultAuthActions);

export function isPrincipalQuery(query: { queryKey: readonly unknown[] }, principalId: string): boolean {
  return query.queryKey[0] === "loomhelm" && query.queryKey[1] === principalId;
}

export async function clearPrincipalQueries(client: QueryClient, principalId: string): Promise<void> {
  const predicate = (query: { queryKey: readonly unknown[] }) => isPrincipalQuery(query, principalId);
  await client.cancelQueries({ predicate });
  client.removeQueries({ predicate });
}

function errorMessage(error: unknown, operation: string): string {
  if (error instanceof ApiClientError) {
    return error.status === 401 ? "浏览器会话已失效，请重新登录。" : `${operation}失败（HTTP ${error.status}）。`;
  }
  return error instanceof Error ? `${operation}失败：${error.message}` : `${operation}失败。`;
}

export function createLoadingProductionAssembly(client: AuthenticatedApiClient, sessionGeneration = 0): ProductionApiAssembly {
  return createProductionApiAssembly({
    client,
    auth: { status: "loading", sessionGeneration },
    permissions: emptyPermissions
  });
}

export function createAuthenticatedProductionAssembly(client: AuthenticatedApiClient, session: BrowserSessionBootstrap, sessionGeneration = 0): ProductionApiAssembly {
  return createProductionApiAssembly({
    client: client.bindBrowserSession({ principalId: session.user_id, epoch: sessionGeneration }),
    auth: {
      status: "authenticated",
      principalId: session.user_id,
      workspaceId: "default",
      sessionGeneration
    },
    permissions: {
      // The Server permits an authenticated browser to create a project; project-scoped edits still use member roles in the source.
      canWrite: true,
      canManageProjects: true,
      isReadOnly: false
    }
  });
}

export async function commitProductionAssembly(
  next: ProductionApiAssembly,
  getCurrentSessionGeneration: () => number,
  previous: ProductionApiAssembly | null,
  clearPrincipalCache: (principalId: string) => Promise<void>,
  apply: (assembly: ProductionApiAssembly) => void
): Promise<boolean> {
  const previousPrincipalId = previous?.auth.principalId;
  if (previousPrincipalId && previousPrincipalId !== next.auth.principalId) await clearPrincipalCache(previousPrincipalId);
  if ((next.auth.sessionGeneration ?? 0) !== getCurrentSessionGeneration()) return false;
  apply(next);
  return true;
}

export function createUnauthenticatedProductionAssembly(client: AuthenticatedApiClient, message?: string, sessionGeneration = 0): ProductionApiAssembly {
  return createProductionApiAssembly({
    client,
    auth: { status: "unauthenticated", message, sessionGeneration },
    permissions: emptyPermissions
  });
}

export function createErrorProductionAssembly(client: AuthenticatedApiClient, message: string, sessionGeneration = 0): ProductionApiAssembly {
  return createProductionApiAssembly({
    client,
    auth: { status: "error", message, sessionGeneration },
    permissions: emptyPermissions
  });
}

export function createProductionAuthFailureAssembly(client: AuthenticatedApiClient, error: unknown, sessionGeneration = 0): ProductionApiAssembly {
  if (error instanceof ApiClientError && error.status === 401) {
    return createUnauthenticatedProductionAssembly(client, "当前浏览器没有有效会话。", sessionGeneration);
  }
  return createErrorProductionAssembly(client, errorMessage(error, "验证浏览器会话"), sessionGeneration);
}

interface AppProvidersProps {
  apiAssembly?: ProductionApiAssembly | null;
  productionClient?: AuthenticatedApiClient;
}

export function AppProviders({ children, apiAssembly = null, productionClient }: PropsWithChildren<AppProvidersProps>) {
  const initialAssembly = productionClient ? createLoadingProductionAssembly(productionClient) : apiAssembly;
  const [productionApi, setProductionApi] = useState<ProductionApiAssembly | null>(initialAssembly);
  const [logoutPending, setLogoutPending] = useState(false);
  const assemblyRef = useRef(initialAssembly);
  const sessionGenerationRef = useRef(initialAssembly?.auth.sessionGeneration ?? 0);
  const lastResumeValidationRef = useRef(0);
  const seenInvalidationSignalsRef = useRef(new Set<string>());

  const clearPrincipalCache = useCallback((principalId: string) => clearPrincipalQueries(queryClient, principalId), []);

  const commitAssembly = useCallback(async (next: ProductionApiAssembly) => {
    return commitProductionAssembly(
      next,
      () => sessionGenerationRef.current,
      assemblyRef.current,
      clearPrincipalCache,
      (assembly) => {
        assemblyRef.current = assembly;
        setProductionApi(assembly);
      }
    );
  }, [clearPrincipalCache]);

  const bootstrapForGeneration = useCallback((generation: number) => {
    if (!productionClient) return;
    void productionClient.bootstrapBrowserSession()
      .then((session) => {
        if (generation === sessionGenerationRef.current) void commitAssembly(createAuthenticatedProductionAssembly(productionClient, session, generation));
      })
      .catch((error: unknown) => {
        if (generation === sessionGenerationRef.current) void commitAssembly(createProductionAuthFailureAssembly(productionClient, error, generation));
      });
  }, [commitAssembly, productionClient]);

  const invalidateAndRevalidate = useCallback(() => {
    if (!productionClient) return;
    productionClient.invalidateBrowserSession();
    const generation = sessionGenerationRef.current + 1;
    sessionGenerationRef.current = generation;
    void commitAssembly(createLoadingProductionAssembly(productionClient, generation)).then(() => {
      if (generation === sessionGenerationRef.current) bootstrapForGeneration(generation);
    });
  }, [bootstrapForGeneration, commitAssembly, productionClient]);

  useEffect(() => {
    if (!productionClient) return;
    let active = true;
    const generation = sessionGenerationRef.current;
    void productionClient.bootstrapBrowserSession()
      .then((session) => {
        if (active && generation === sessionGenerationRef.current) void commitAssembly(createAuthenticatedProductionAssembly(productionClient, session, generation));
      })
      .catch((error: unknown) => {
        if (active && generation === sessionGenerationRef.current) void commitAssembly(createProductionAuthFailureAssembly(productionClient, error, generation));
      });
    return () => {
      active = false;
    };
  }, [commitAssembly, productionClient]);

  useEffect(() => {
    if (!productionClient || typeof window === "undefined") return;
    const handleSignal = (signal: ProductionAuthInvalidationSignal | undefined) => {
      if (signal) {
        if (seenInvalidationSignalsRef.current.has(signal.nonce)) return;
        seenInvalidationSignalsRef.current.add(signal.nonce);
      }
      invalidateAndRevalidate();
    };
    const handleInvalidated = (event: Event) => {
      const detail = event instanceof CustomEvent ? parseProductionAuthInvalidationSignal(event.detail) : undefined;
      handleSignal(detail);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== PRODUCTION_AUTH_INVALIDATION_STORAGE_KEY) return;
      let value: unknown;
      try {
        value = event.newValue ? JSON.parse(event.newValue) : undefined;
      } catch {
        return;
      }
      const signal = parseProductionAuthInvalidationSignal(value);
      handleSignal(signal);
    };
    const handleBroadcast = (event: MessageEvent<unknown>) => {
      const signal = parseProductionAuthInvalidationSignal(event.data);
      handleSignal(signal);
    };
    let channel: BroadcastChannel | undefined;
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(PRODUCTION_AUTH_INVALIDATION_CHANNEL);
      channel.addEventListener("message", handleBroadcast);
    }
    window.addEventListener(PRODUCTION_AUTH_INVALIDATED_EVENT, handleInvalidated);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(PRODUCTION_AUTH_INVALIDATED_EVENT, handleInvalidated);
      window.removeEventListener("storage", handleStorage);
      channel?.removeEventListener("message", handleBroadcast);
      channel?.close();
    };
  }, [invalidateAndRevalidate, productionClient]);

  useEffect(() => {
    if (!productionClient || typeof window === "undefined") return;
    const revalidateOnResume = () => {
      if (document.visibilityState === "hidden" || assemblyRef.current?.auth.status !== "authenticated") return;
      const now = Date.now();
      if (now - lastResumeValidationRef.current < 1000) return;
      lastResumeValidationRef.current = now;
      invalidateAndRevalidate();
    };
    document.addEventListener("visibilitychange", revalidateOnResume);
    window.addEventListener("focus", revalidateOnResume);
    return () => {
      document.removeEventListener("visibilitychange", revalidateOnResume);
      window.removeEventListener("focus", revalidateOnResume);
    };
  }, [invalidateAndRevalidate, productionClient]);

  const authActions = useMemo<ProductionAuthActions>(() => ({
    login: defaultAuthActions.login,
    logout: async () => {
      if (!productionClient) return { ok: false, message: "浏览器认证入口尚未接入。" };
      setLogoutPending(true);
      try {
        await productionClient.logoutBrowserSession();
        publishProductionAuthInvalidation();
        return { ok: true };
      } catch (error) {
        // A completed server logout can still lose its response. Reconcile every tab before another principal can reuse protected cache.
        publishProductionAuthInvalidation();
        return { ok: false, message: errorMessage(error, "退出登录") };
      } finally {
        setLogoutPending(false);
      }
    },
    logoutPending
  }), [invalidateAndRevalidate, logoutPending, productionClient]);
  const contextAssembly = productionClient ? productionApi : apiAssembly;

  return (
    <QueryClientProvider client={queryClient}>
      <ProductionApiContext.Provider value={contextAssembly}>
        <ProductionAuthContext.Provider value={authActions}>{children}</ProductionAuthContext.Provider>
      </ProductionApiContext.Provider>
    </QueryClientProvider>
  );
}

export function useOptionalProductionApi(): ProductionApiAssembly | null {
  return useContext(ProductionApiContext);
}

export function useProductionAuthActions(): ProductionAuthActions {
  return useContext(ProductionAuthContext);
}
