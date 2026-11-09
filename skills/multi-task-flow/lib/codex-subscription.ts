import type { JsonRecord } from "../lib/codex-socket";

type Request = (method: string, params: JsonRecord) => Promise<JsonRecord>;
/** Connection-local subscriptions; never creates a turn or changes configuration. */
export class LoadedThreadSubscriptions {
  private wanted = new Map<string, object>();
  private joined = new Set<string>();
  private pending = new Map<string, Promise<void>>();
  private generation = 0;
  constructor(private request: Request) {}
  retain(threads: Iterable<string>): void {
    this.wanted = new Map(
      [...threads].map((thread) => [thread, this.wanted.get(thread) ?? {}]),
    );
    for (const thread of this.joined)
      if (!this.wanted.has(thread)) {
        this.joined.delete(thread);
        void this.request("thread/unsubscribe", { threadId: thread }).catch(
          () => {},
        );
      }
  }
  close(): void {
    this.generation++;
    this.wanted.clear();
    this.joined.clear();
  }
  ensure(thread: string): Promise<void> {
    if (!this.wanted.has(thread) || this.joined.has(thread))
      return Promise.resolve();
    const existing = this.pending.get(thread);
    if (existing) return existing;
    const pending = this.join(thread).finally(() =>
      this.pending.delete(thread),
    );
    this.pending.set(thread, pending);
    return pending;
  }
  private async join(thread: string): Promise<void> {
    const generation = this.generation;
    const binding = this.wanted.get(thread);
    const valid = () =>
      generation === this.generation && this.wanted.get(thread) === binding;
    let cursor: string | undefined;
    const seen = new Set<string>();
    while (valid()) {
      const page = await this.request("thread/loaded/list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!valid()) return;
      if (!Array.isArray(page.data))
        throw new Error("Unsupported loaded thread page");
      if (page.data.includes(thread)) {
        // No overrides, history, path, user input, or turn/start. Rejoin the loaded session.
        await this.request("thread/resume", {
          threadId: thread,
          excludeTurns: true,
        });
        if (valid()) this.joined.add(thread);
        else if (generation === this.generation)
          await this.request("thread/unsubscribe", { threadId: thread });
        return;
      }
      const next = page.nextCursor;
      if (typeof next !== "string" || !next || seen.has(next)) return;
      seen.add(next);
      cursor = next;
    }
  }
}
