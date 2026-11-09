import { execFile } from "node:child_process";

export type PRDetails = { number: number; title: string; url: string; state: string; mergedAt: string | null; mergeable: string; checks: Record<string, unknown>[]; ci: string };
export type PRSnapshot = { data: PRDetails | null; observed_at: string | null; stale: boolean; loading: boolean; error: string | null };
type Query = (args: string[]) => Promise<string>;
const queryGh: Query = args => new Promise((resolve, reject) => {
  execFile("gh", args, { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => error ? reject(new Error("PR 查询失败，请检查 gh 登录、权限或稍后重试")) : resolve(stdout));
});
export function summarizeChecks(checks: Record<string, unknown>[] | null): string {
  if (!checks) return "未知";
  if (!checks.length) return "未配置";
  const values = checks.map(c => String(c.conclusion || c.state || c.status || "UNKNOWN").toUpperCase());
  if (values.some(v => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(v))) return "失败";
  if (values.some(v => ["IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "REQUESTED", "EXPECTED"].includes(v))) return "运行中";
  return values.every(v => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(v)) ? "成功" : "未知";
}
export class PRDetailsCache {
  private entries = new Map<string, { snapshot: PRSnapshot; attempted: number; flight?: Promise<void> }>();
  constructor(private query: Query = queryGh, private now = Date.now) {}
  async read(repository: { host: string; owner: string; name: string }, url: string, force = false): Promise<PRSnapshot> {
    const parsed = new URL(url);
    const path = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/.exec(parsed.pathname);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || !path || parsed.hostname.toLowerCase() !== repository.host.toLowerCase() || path[1]!.toLowerCase() !== repository.owner.toLowerCase() || path[2]!.toLowerCase() !== repository.name.toLowerCase()) throw new Error("PR 与当前仓库不匹配");
    const repo = `${repository.host}/${repository.owner}/${repository.name}`;
    const key = `${repo}/${path[3]}`;
    let entry = this.entries.get(key);
    if (!entry) { entry = { snapshot: { data: null, observed_at: null, stale: true, loading: false, error: null }, attempted: -Infinity }; this.entries.set(key, entry); }
    const age = entry.snapshot.observed_at ? this.now() - Date.parse(entry.snapshot.observed_at) : Infinity;
    if (!entry.flight && this.now() - entry.attempted >= 2000 && (force || age >= 30_000)) {
      entry.attempted = this.now();
      entry.snapshot.loading = true;
      const current = entry;
      current.flight = (async () => {
        try {
          const raw = JSON.parse(await this.query(["pr", "view", path[3]!, "--repo", repo, "--json", "number,title,url,state,mergedAt,mergeable,statusCheckRollup"]));
          if (raw.number !== Number(path[3]) || typeof raw.title !== "string" || raw.url !== parsed.href.replace(/\/$/, "") || !["OPEN", "CLOSED", "MERGED"].includes(raw.state)) throw new Error("Invalid PR response");
          const checks = Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : null;
          current.snapshot = { data: { number: raw.number, title: raw.title, url: raw.url, state: raw.state, mergedAt: raw.mergedAt, mergeable: raw.mergeable ?? "UNKNOWN", checks: checks ?? [], ci: summarizeChecks(checks) }, observed_at: new Date(this.now()).toISOString(), stale: false, loading: false, error: null };
        } catch { current.snapshot = { ...current.snapshot, stale: true, loading: false, error: "PR 查询失败，请检查 gh 登录、权限或稍后重试" }; }
        finally { current.flight = undefined; }
      })();
    }
    if (entry.flight && entry.snapshot.data && !force) return { ...entry.snapshot, stale: true, loading: true };
    if (entry.flight) await entry.flight;
    return { ...entry.snapshot, stale: entry.snapshot.stale || !entry.snapshot.observed_at || this.now() - Date.parse(entry.snapshot.observed_at) >= 30_000 };
  }
}
