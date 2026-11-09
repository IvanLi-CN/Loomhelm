import { randomBytes, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readRegular, withExclusiveLock, writeAtomic } from "../lib/store";
import { safeCompare } from "../lib/server-files";
import { requireCondition } from "../lib/errors";
import type { ServiceState } from "../lib/service-state";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const authSchema = z
  .object({
    credential: z.string().min(32),
    tickets: z.array(
      z
        .object({
          digest: z.string(),
          expires_at: z.number(),
          target: z.string(),
        })
        .strict(),
    ),
    sessions: z.array(
      z.object({ digest: z.string(), expires_at: z.number() }).strict(),
    ),
  })
  .strict();
type AuthData = z.infer<typeof authSchema>;
export class ServiceAuth {
  constructor(readonly state: ServiceState) {}
  private get cookieName(): string {
    return this.state.paths.isolated
      ? "mtf_session_" + hash(this.state.paths.root).slice(0, 12)
      : "mtf_session";
  }
  private transaction<T>(
    fn: (auth: AuthData) => T,
    persist = true,
    create = false,
  ): T {
    this.state.initialize();
    const path = join(this.state.paths.state, "auth.json");
    return withExclusiveLock(join(this.state.paths.state, "auth.lock"), () => {
      requireCondition(
        create || existsSync(path),
        "AUTH_NOT_INITIALIZED",
        "Local credentials are missing; explicit credential maintenance is required",
      );
      const auth = existsSync(path)
        ? authSchema.parse(JSON.parse(readRegular(path)))
        : { credential: token(), tickets: [], sessions: [] };
      const now = Date.now();
      auth.tickets = auth.tickets.filter((item) => item.expires_at > now);
      auth.sessions = auth.sessions.filter((item) => item.expires_at > now);
      const result = fn(auth);
      if (persist || !existsSync(path))
        writeAtomic(path, JSON.stringify(auth) + "\n");
      return result;
    });
  }
  initialize(): void {
    this.transaction(() => {}, true, true);
  }
  credential(): string {
    return this.transaction((auth) => auth.credential, false);
  }
  authorize(request: Request): { kind: "cli" | "browser"; id: string } | null {
    return this.transaction((auth) => {
      const bearer = request.headers.get("authorization");
      if (bearer && safeCompare(bearer, "Bearer " + auth.credential))
        return { kind: "cli", id: "cli" };
      const cookie = request.headers
        .get("cookie")
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(this.cookieName + "="))
        ?.slice(this.cookieName.length + 1);
      const session =
        cookie &&
        auth.sessions.find((item) => safeCompare(item.digest, hash(cookie)));
      return session ? { kind: "browser", id: session.digest } : null;
    }, false);
  }
  ticket(target = "/"): string {
    requireCondition(
      target === "/" ||
        /^\/runs\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/$/.test(target),
      "INVALID_TARGET",
      "Invalid login target",
    );
    const value = token();
    this.transaction((auth) => {
      requireCondition(
        auth.tickets.length < 100,
        "TOO_MANY_TICKETS",
        "Too many outstanding login tickets",
      );
      auth.tickets.push({
        digest: hash(value),
        expires_at: Date.now() + 60_000,
        target,
      });
    });
    return value;
  }
  exchange(value: string): { cookie: string; target: string } {
    return this.transaction((auth) => {
      const index = auth.tickets.findIndex((item) =>
        safeCompare(item.digest, hash(value)),
      );
      requireCondition(
        index >= 0,
        "INVALID_TICKET",
        "Login ticket expired or already used",
      );
      const [ticket] = auth.tickets.splice(index, 1);
      const session = token();
      requireCondition(
        auth.sessions.length < 1000,
        "TOO_MANY_SESSIONS",
        "Too many login sessions",
      );
      auth.sessions.push({
        digest: hash(session),
        expires_at: Date.now() + 30 * 24 * 60 * 60_000,
      });
      return {
        cookie: `${this.cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
        target: ticket!.target,
      };
    });
  }
  rotate(): void {
    this.transaction(
      (auth) => {
        auth.credential = token();
        auth.tickets = [];
        auth.sessions = [];
      },
      true,
      true,
    );
  }
}
