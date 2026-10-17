/**
 * Stable import boundary for the generated HTTP client.
 *
 * A backend contract and generator are not part of this foundation slice, so
 * this type intentionally carries no endpoint or response assumptions.
 */
export type GeneratedApiClient = unknown;

export type ApiClientFactory<TClient = GeneratedApiClient> = () => TClient;

export function createApiClient<TClient>(factory: ApiClientFactory<TClient>): TClient {
  return factory();
}
