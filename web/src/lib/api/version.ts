export interface ProductBuild { version: string; source_sha: string; policy: string }
declare const __LOOMHELM_BUILD__: ProductBuild;
export const productBuild: Readonly<ProductBuild> = Object.freeze(typeof __LOOMHELM_BUILD__ === 'undefined' ? { version: 'dev', source_sha: 'unknown', policy: 'loomhelm-manual-v1' } : __LOOMHELM_BUILD__);

export function versionedWebFetch(fetcher: typeof fetch, baseUrl?: string): typeof fetch {
  return async (input, init = {}) => {
    if (productBuild.version === 'dev') return fetcher(input, init);
    const base = new URL(baseUrl || '/', globalThis.location?.origin);
    const destination = new URL(input instanceof Request ? input.url : String(input), base);
    if (destination.origin !== base.origin) throw new Error('跨来源业务请求已拒绝。');
    const status = await fetcher(new URL('/version', base), { cache: 'no-store', credentials: 'omit', redirect: 'error' });
    const info = await status.json() as Partial<ProductBuild>;
    if (!status.ok || info.version !== productBuild.version || info.policy !== productBuild.policy) {
      throw new Error('当前页面版本与服务端不兼容，请保存输入后通过更新提示升级。');
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    headers.set('X-Loomhelm-Version', productBuild.version);
    const response = await fetcher(input, { ...init, headers, redirect: 'error' });
    if (response.status === 426) throw new Error('服务端版本已更新，请保存输入后升级页面再重试。');
    return response;
  };
}
