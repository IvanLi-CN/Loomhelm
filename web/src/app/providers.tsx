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

function isPrincipalQuery(query: { queryKey: readonly unknown[] }, principalId: string): boolean {
  return query.queryKey[0] === "loomhelm" && query.queryKey[1] === principalId;
}

function errorMessage(error: unknown, operation: string): string {
  if (error instanceof ApiClientError) {
    return error.status === 401 ? "浏览器会话已失效，请重新登录。" : `${operation}失败（HTTP ${error.status}）。`;
  }
  return error instanceof Error ? `${operation}失败：${error.message}` : `${operation}失败。`;
}

export function createLoadingProductionAssembly(client: AuthenticatedApiClient): ProductionApiAssembly {
  return createProductionApiAssembly({
    client,
    auth: { status: "loading" },
    permissions: emptyPermissions
  });
}

export function createAuthenticatedProductionAssembly(client: AuthenticatedApiClient, session: BrowserSessionBootstrap): ProductionApiAssembly {
  return createProductionApiAssembly({
    client,
    auth: {
      status: "authenticated",
      principalId: session.user_id,
      workspaceId: "default"
    },
    permissions: {
      // The Server permits an authenticated browser to create a project; project-scoped edits still use member roles in the source.
      canWrite: true,
      canManageProjects: true,
      isReadOnly: false
    }
  });
}

export function createUnauthenticatedProductionAssembly(client: AuthenticatedApiClient, message?: string): ProductionApiAssembly {
  return createProductionApiAssembly({
    client,
    auth: { status: "unauthenticated", message },
    permissions: emptyPermissions
  });
}

export function createErrorProductionAssembly(client: AuthenticatedApiClient, message: string): ProductionApiAssembly {
  return createProductionApiAssembly({
    client,
    auth: { status: "error", message },
    permissions: emptyPermissions
  });
}

export function createProductionAuthFailureAssembly(client: AuthenticatedApiClient, error: unknown): ProductionApiAssembly {
  if (error instanceof ApiClientError && error.status === 401) {
    return createUnauthenticatedProductionAssembly(client, "当前浏览器没有有效会话。");
  }
  return createErrorProductionAssembly(client, errorMessage(error, "验证浏览器会话"));
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

  const clearPrincipalQueries = useCallback((principalId: string) => {
    void queryClient.cancelQueries({ predicate: (query) => isPrincipalQuery(query, principalId) }).then(() => {
      queryClient.removeQueries({ predicate: (query) => isPrincipalQuery(query, principalId) });
    });
  }, []);

  const commitAssembly = useCallback((next: ProductionApiAssembly) => {
    const previousPrincipalId = assemblyRef.current?.auth.principalId;
    if (previousPrincipalId && previousPrincipalId !== next.auth.principalId) clearPrincipalQueries(previousPrincipalId);
    assemblyRef.current = next;
    setProductionApi(next);
  }, [clearPrincipalQueries]);

  useEffect(() => {
    if (!productionClient) return;
    let active = true;
    void productionClient.bootstrapBrowserSession()
      .then((session) => {
        if (active) commitAssembly(createAuthenticatedProductionAssembly(productionClient, session));
      })
      .catch((error: unknown) => {
        if (!active) return;
        commitAssembly(createProductionAuthFailureAssembly(productionClient, error));
      });
    return () => {
      active = false;
    };
  }, [commitAssembly, productionClient]);

  useEffect(() => {
    if (!productionClient || typeof window === "undefined") return;
    const handleInvalidated = () => commitAssembly(createUnauthenticatedProductionAssembly(productionClient, "浏览器会话已失效，请重新登录。"));
    window.addEventListener(PRODUCTION_AUTH_INVALIDATED_EVENT, handleInvalidated);
    return () => window.removeEventListener(PRODUCTION_AUTH_INVALIDATED_EVENT, handleInvalidated);
  }, [commitAssembly, productionClient]);

  const authActions = useMemo<ProductionAuthActions>(() => ({
    login: defaultAuthActions.login,
    logout: async () => {
      if (!productionClient) return { ok: false, message: "浏览器认证入口尚未接入。" };
      setLogoutPending(true);
      try {
        await productionClient.logoutBrowserSession();
        commitAssembly(createUnauthenticatedProductionAssembly(productionClient, "已退出当前浏览器会话。"));
        return { ok: true };
      } catch (error) {
        return { ok: false, message: errorMessage(error, "退出登录") };
      } finally {
        setLogoutPending(false);
      }
    },
    logoutPending
  }), [commitAssembly, logoutPending, productionClient]);
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
