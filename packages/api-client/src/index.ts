import type { LoomhelmApiClient } from "./generated";

export * from "./generated";

export type GeneratedApiClient = LoomhelmApiClient;

export type ApiClientFactory<TClient = GeneratedApiClient> = () => TClient;

export function createApiClient<TClient>(factory: ApiClientFactory<TClient>): TClient {
  return factory();
}
