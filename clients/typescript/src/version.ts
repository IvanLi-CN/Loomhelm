import { buildInfo } from './build-info.ts';
export { buildInfo };
export const versionHeader = 'X-Loomhelm-Version';
export class ProductVersionError extends Error {
  readonly code = 'PRODUCT_VERSION_INCOMPATIBLE';
  constructor() { super('Update the client before reconnecting; local mode and state remain available.'); }
}
export async function checkServerVersion(baseUrl: string, fetcher: typeof fetch = fetch): Promise<void> {
  if (buildInfo.version === 'dev') return;
  const response = await fetcher(new URL('/version', baseUrl), { cache: 'no-store', redirect: 'error' });
  const value: unknown = await response.json().catch(() => { throw new ProductVersionError(); });
  if (!response.ok || !value || typeof value !== 'object' || !('version' in value) || !('policy' in value) || value.version !== buildInfo.version || value.policy !== buildInfo.policy) throw new ProductVersionError();
}
export async function versionedFetch(baseUrl: string, input: string | URL, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<Response> {
  const destination = new URL(input, baseUrl);
  if (destination.origin !== new URL(baseUrl).origin) throw new Error('Cross-origin client request rejected');
  await checkServerVersion(baseUrl, fetcher);
  const headers = new Headers(init.headers);
  headers.set(versionHeader, buildInfo.version);
  const response = await fetcher(destination, { ...init, headers, redirect: 'error' });
  if (response.status === 426) throw new ProductVersionError();
  return response;
}
