import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, type PropsWithChildren } from "react";

import type { ProductionApiAssembly } from "@/lib/api/client";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 30_000
    }
  }
});

const ProductionApiContext = createContext<ProductionApiAssembly | null>(null);

export function AppProviders({ children, apiAssembly = null }: PropsWithChildren<{ apiAssembly?: ProductionApiAssembly | null }>) {
  return (
    <QueryClientProvider client={queryClient}>
      <ProductionApiContext.Provider value={apiAssembly}>{children}</ProductionApiContext.Provider>
    </QueryClientProvider>
  );
}

export function useOptionalProductionApi(): ProductionApiAssembly | null {
  return useContext(ProductionApiContext);
}
