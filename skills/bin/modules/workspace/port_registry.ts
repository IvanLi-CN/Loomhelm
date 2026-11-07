import {
  DEFAULT_BLOCK_SIZE,
  DEFAULT_START_BASE,
  DEFAULT_STEP,
  DEFAULT_TTL_HOURS,
  RegistryError,
  assertTcpPort,
  parseIntValue,
  type LeaseRow,
} from "./port_registry_shared";
import { selectPort, upsertRow } from "./port_allocator";
import { PortRegistryAllocation } from "./port_registry_allocation";

export * from "./port_registry_shared";
export * from "./port_allocator";
export { PortRegistryStore } from "./port_registry_store";

function assertLeaseOwnership(
  row: LeaseRow | undefined,
  expected: { port?: number; pid?: number | null },
): void {
  if (!row)
    throw new RegistryError("lease ownership changed or lease is missing");
  if (
    expected.port !== undefined &&
    parseIntValue(row.port, "port") !== expected.port
  )
    throw new RegistryError("lease ownership changed: port no longer matches");
  if (
    expected.pid !== undefined &&
    row.pid !== (expected.pid === null ? "" : String(expected.pid))
  )
    throw new RegistryError("lease ownership changed: pid no longer matches");
}

export class PortRegistry extends PortRegistryAllocation {
  async register(input: {
    scopeId: string;
    service: string;
    port: number;
    project?: string;
    repoRoot?: string;
    branch?: string;
    worktreePath?: string;
    portBase?: number;
    blockSize?: number;
    agentSession?: string;
    pid?: number;
    expectedPid?: number | null;
    createIfMissing?: boolean;
    refreshClaimedAt?: boolean;
    ttlHours?: number;
    lockTimeoutSec?: number;
  }): Promise<Record<string, unknown>> {
    const blockSize = input.blockSize ?? DEFAULT_BLOCK_SIZE;
    if (blockSize <= 0)
      throw new RegistryError(`invalid block_size: ${blockSize} (must be > 0)`);
    const port = assertTcpPort(input.port);
    const base = input.portBase ?? port - (port % blockSize);
    assertTcpPort(base, "port_base");
    const service = input.service.trim().toLowerCase();
    return this.withLockedRows(input.lockTimeoutSec ?? 10, async (rows) => {
      const removed = await this.collectGc(
        rows,
        input.ttlHours ?? DEFAULT_TTL_HOURS,
      );
      if (input.expectedPid !== undefined) {
        const current = rows.find(
          (row) => row.scope_id === input.scopeId && row.service === service,
        );
        if (!current && input.createIfMissing && input.expectedPid === null) {
          // A system service may be offline with no active reservation.
        } else {
          if (!current || parseIntValue(current.port, "port") !== port)
            throw new RegistryError(
              "lease ownership changed: port no longer matches",
            );
          const expectedPid =
            input.expectedPid === null ? "" : String(input.expectedPid);
          if (current.pid !== expectedPid)
            throw new RegistryError(
              "lease ownership changed: pid no longer matches",
            );
        }
      }
      for (const row of rows) {
        if (
          !(row.scope_id === input.scopeId && row.service === service) &&
          parseIntValue(row.port, "port") === port
        )
          throw new RegistryError(
            `port ${port} already leased by ${row.scope_id}/${row.service}`,
          );
      }
      const sameLease = rows.some(
        (row) =>
          row.scope_id === input.scopeId &&
          row.service === service &&
          parseIntValue(row.port, "port") === port,
      );
      if ((await this.options.portListening(port)) && !sameLease)
        throw new RegistryError(
          `port ${port} is currently LISTENing; refuse to register blindly`,
        );
      const payload: Partial<LeaseRow> = {
        scope_id: input.scopeId,
        project: input.project ?? "",
        repo_root: input.repoRoot ?? "",
        branch: input.branch ?? "",
        worktree_path: input.worktreePath ?? "",
        service,
        port: String(port),
        port_base: String(base),
        block_size: String(blockSize),
        agent_session: input.agentSession ?? "",
        pid: input.pid === undefined ? "" : String(input.pid),
      };
      const [row, created] = upsertRow(
        rows,
        payload,
        input.refreshClaimedAt ?? false,
        this.now(),
      );
      return {
        changed: true,
        value: {
          action: "registered",
          scope_id: row.scope_id,
          service: row.service,
          port,
          port_base: Number(row.port_base) || null,
          block_size: Number(row.block_size),
          claimed_at: row.claimed_at,
          last_seen_at: row.last_seen_at,
          created,
          gc_removed: removed.length,
        },
      };
    });
  }

  async claimAndRun<T>(
    input: {
      scopeId: string;
      service: string;
      port: number;
      agentSession?: string;
      pid: number;
      ttlHours?: number;
      lockTimeoutSec?: number;
    },
    action: () => Promise<T> | T,
  ): Promise<T> {
    const port = assertTcpPort(input.port);
    const service = input.service.trim().toLowerCase();
    return this.withLockedRows(input.lockTimeoutSec ?? 10, async (rows) => {
      await this.collectGc(rows, input.ttlHours ?? DEFAULT_TTL_HOURS);
      const current = rows.find(
        (row) => row.scope_id === input.scopeId && row.service === service,
      );
      if (!current || parseIntValue(current.port, "port") !== port)
        throw new RegistryError("lease is missing or no longer matches");
      if (current.pid)
        throw new RegistryError(
          `lease is already owned by pid ${current.pid}; refuse duplicate startup`,
        );
      if (await this.options.portListening(port))
        throw new RegistryError(
          `port ${port} is currently LISTENing; refuse duplicate startup`,
        );

      // Keep the registry lock while the wrapper binds its listener. This
      // prevents another registry operation from collecting the startup claim.
      const value = await action();
      if (!(await this.options.portListening(port)))
        throw new RegistryError(
          `port ${port} did not become LISTENing during startup claim`,
        );
      const payload: Partial<LeaseRow> = {
        scope_id: input.scopeId,
        service,
        port: String(port),
        pid: String(input.pid),
        agent_session: input.agentSession ?? "",
      };
      upsertRow(rows, payload, false, this.now());
      return { changed: true, value };
    });
  }

  async heartbeat(input: {
    scopeId: string;
    service: string;
    agentSession?: string;
    pid?: number;
    expectedPid?: number;
    port?: number;
    ttlHours?: number;
    lockTimeoutSec?: number;
  }): Promise<Record<string, unknown>> {
    const service = input.service.trim().toLowerCase();
    return this.withLockedRows(input.lockTimeoutSec ?? 10, async (rows) => {
      const removed = await this.collectGc(
        rows,
        input.ttlHours ?? DEFAULT_TTL_HOURS,
      );
      const row = rows.find(
        (item) => item.scope_id === input.scopeId && item.service === service,
      );
      if (!row)
        throw new RegistryError(
          `lease not found for ${input.scopeId}/${service}`,
        );
      const expected: { port?: number; pid?: number } = {};
      if (input.port !== undefined) expected.port = input.port;
      if (input.expectedPid !== undefined) expected.pid = input.expectedPid;
      assertLeaseOwnership(row, expected);
      row.last_seen_at = this.now();
      if (input.pid !== undefined) row.pid = String(input.pid);
      if (input.agentSession !== undefined)
        row.agent_session = input.agentSession;
      return {
        changed: true,
        value: {
          action: "heartbeat",
          scope_id: row.scope_id,
          service,
          last_seen_at: row.last_seen_at,
          gc_removed: removed.length,
        },
      };
    });
  }

  async releaseService(
    scopeId: string,
    serviceValue: string,
    ttlHours = DEFAULT_TTL_HOURS,
    lockTimeoutSec = 10,
    expected?: { port?: number; pid?: number | null },
  ): Promise<Record<string, unknown>> {
    const service = serviceValue.trim().toLowerCase();
    return this.withLockedRows(lockTimeoutSec, async (rows) => {
      const removed = await this.collectGc(rows, ttlHours);
      if (
        expected &&
        (expected.port !== undefined || expected.pid !== undefined)
      )
        assertLeaseOwnership(
          rows.find(
            (row) => row.scope_id === scopeId && row.service === service,
          ),
          expected,
        );
      const before = rows.length;
      rows.splice(
        0,
        rows.length,
        ...rows.filter(
          (row) => !(row.scope_id === scopeId && row.service === service),
        ),
      );
      return {
        changed: before !== rows.length || removed.length > 0,
        value: {
          action: "released-service",
          scope_id: scopeId,
          service,
          released: before - rows.length,
          gc_removed: removed.length,
        },
      };
    });
  }

  async releaseScope(
    scopeId: string,
    ttlHours = DEFAULT_TTL_HOURS,
    lockTimeoutSec = 10,
  ): Promise<Record<string, unknown>> {
    return this.withLockedRows(lockTimeoutSec, async (rows) => {
      const removed = await this.collectGc(rows, ttlHours);
      const before = rows.length;
      rows.splice(
        0,
        rows.length,
        ...rows.filter((row) => row.scope_id !== scopeId),
      );
      return {
        changed: before !== rows.length || removed.length > 0,
        value: {
          action: "released-scope",
          scope_id: scopeId,
          released: before - rows.length,
          gc_removed: removed.length,
        },
      };
    });
  }

  async inspect(
    filters: Partial<{
      scopeId: string;
      project: string;
      repoRoot: string;
      branch: string;
      worktreePath: string;
      service: string;
      port: number;
    }>,
    ttlHours = DEFAULT_TTL_HOURS,
    lockTimeoutSec = 10,
  ): Promise<Record<string, unknown>> {
    return this.withLockedRows(lockTimeoutSec, async (rows) => {
      const removed = await this.collectGc(rows, ttlHours);
      const service = filters.service?.trim().toLowerCase();
      const filtered = rows
        .filter(
          (row) =>
            (!filters.scopeId || row.scope_id === filters.scopeId) &&
            (!filters.project || row.project === filters.project) &&
            (!filters.repoRoot || row.repo_root === filters.repoRoot) &&
            (!filters.branch || row.branch === filters.branch) &&
            (!filters.worktreePath ||
              row.worktree_path === filters.worktreePath) &&
            (!service || row.service === service) &&
            (filters.port === undefined ||
              parseIntValue(row.port, "port") === filters.port),
        )
        .sort((a, b) => b.claimed_at.localeCompare(a.claimed_at));
      return {
        changed: removed.length > 0,
        value: {
          action: "inspect",
          count: filtered.length,
          rows: filtered,
          gc_removed: removed.length,
        },
      };
    });
  }

  async gc(
    ttlHours = DEFAULT_TTL_HOURS,
    lockTimeoutSec = 10,
  ): Promise<Record<string, unknown>> {
    return this.withLockedRows(lockTimeoutSec, async (rows) => {
      const removed = await this.collectGc(rows, ttlHours);
      return {
        changed: removed.length > 0,
        value: {
          action: "gc",
          ttl_hours: ttlHours,
          removed: removed.length,
          rows: removed,
        },
      };
    });
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const cli = await import("./port_registry_cli");
  return cli.main(argv);
}

if (import.meta.main) process.exitCode = await main();
