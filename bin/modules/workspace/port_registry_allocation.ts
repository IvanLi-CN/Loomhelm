import {
  DEFAULT_BLOCK_SIZE,
  DEFAULT_START_BASE,
  DEFAULT_STEP,
  DEFAULT_TTL_HOURS,
  RegistryError,
  assertTcpPort,
  type LeaseRow,
} from "./port_registry_shared";
import { selectPort, upsertRow } from "./port_allocator";
import { PortRegistryStore } from "./port_registry_store";

export class PortRegistryAllocation extends PortRegistryStore {
  async allocate(input: {
    scopeId: string;
    service: string;
    project: string;
    repoRoot: string;
    branch: string;
    worktreePath: string;
    startBase?: number;
    step?: number;
    blockSize?: number;
    agentSession?: string;
    pid?: number;
    ttlHours?: number;
    lockTimeoutSec?: number;
  }): Promise<Record<string, unknown>> {
    const startBase = input.startBase ?? DEFAULT_START_BASE;
    const step = input.step ?? DEFAULT_STEP;
    const blockSize = input.blockSize ?? DEFAULT_BLOCK_SIZE;
    if (step <= 0 || blockSize <= 0)
      throw new RegistryError("step and block_size must be > 0");
    assertTcpPort(startBase, "start_base");
    const service = input.service.trim().toLowerCase();
    return this.withLockedRows(input.lockTimeoutSec ?? 10, async (rows) => {
      const gcRemoved = await this.collectGc(
        rows,
        input.ttlHours ?? DEFAULT_TTL_HOURS,
      );
      const [port, base] = await selectPort(
        rows,
        input.scopeId,
        service,
        startBase,
        step,
        blockSize,
        this.options.portListening,
      );
      const payload: Partial<LeaseRow> = {
        scope_id: input.scopeId,
        project: input.project,
        repo_root: input.repoRoot,
        branch: input.branch,
        worktree_path: input.worktreePath,
        service,
        block_size: String(blockSize),
        agent_session: input.agentSession ?? "",
        pid: input.pid === undefined ? "" : String(input.pid),
        port: String(port),
        port_base: String(base),
      };
      const [row, created] = upsertRow(rows, payload, false, this.now());
      row.port = String(port);
      row.port_base = String(base);
      row.block_size = String(blockSize);
      return {
        changed: true,
        value: {
          action: "allocated",
          scope_id: row.scope_id,
          service: row.service,
          port,
          port_base: base,
          block_size: blockSize,
          claimed_at: row.claimed_at,
          last_seen_at: row.last_seen_at,
          gc_removed: gcRemoved.length,
          created,
        },
      };
    });
  }

  async suggest(input: {
    scopeId: string;
    service: string;
    startBase?: number;
    step?: number;
    blockSize?: number;
    ttlHours?: number;
    lockTimeoutSec?: number;
  }): Promise<Record<string, unknown>> {
    const startBase = input.startBase ?? DEFAULT_START_BASE;
    const step = input.step ?? DEFAULT_STEP;
    const blockSize = input.blockSize ?? DEFAULT_BLOCK_SIZE;
    if (step <= 0 || blockSize <= 0)
      throw new RegistryError("step and block_size must be > 0");
    assertTcpPort(startBase, "start_base");
    const service = input.service.trim().toLowerCase();
    return this.withLockedRows(input.lockTimeoutSec ?? 10, async (rows) => {
      const removed = await this.collectGc(
        rows,
        input.ttlHours ?? DEFAULT_TTL_HOURS,
      );
      const [port, base] = await selectPort(
        rows,
        input.scopeId,
        service,
        startBase,
        step,
        blockSize,
        this.options.portListening,
      );
      return {
        changed: false,
        value: {
          action: "suggested",
          scope_id: input.scopeId,
          service,
          port,
          port_base: base,
          block_size: blockSize,
          gc_removed_preview: removed.length,
          note: "non-mutating recommendation",
        },
      };
    });
  }
}
