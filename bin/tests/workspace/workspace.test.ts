import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { evaluateCloseoutGate } from "../../modules/workspace/closeout_gate";
import {
  inspectContext,
  validateCandidate,
  type CandidateRunner,
} from "../../modules/workspace/candidate_context";
import { evaluateLocalMergeCloseoutGate } from "../../modules/workspace/local_merge_closeout_gate";
import { buildLocalMergeCloseoutContext } from "../../modules/workspace/local_merge_closeout_context";
import {
  CommandError,
  EXIT_BLOCKED,
  EXIT_ELIGIBLE,
  EXIT_INDETERMINATE,
  EXIT_INPUT_STALE,
  evaluate,
  parsePorcelainV2,
  type MergeRunner,
} from "../../modules/workspace/merge_preflight";
import { defaultPrFacts } from "../../modules/workspace/merge_preflight_model";
import {
  FIELDS,
  PortRegistry,
  selectPort,
  type LeaseRow,
  type LockHandle,
} from "../../modules/workspace/port_registry";
import type { ProcessRequest, ProcessResult } from "../../modules/core/process";
import { parseWorktreePorcelain } from "../../modules/workspace/worktree";

function result(stdout = "", exitCode = 0): ProcessResult {
  return { exitCode, stdout, stderr: "", timedOut: false };
}
async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "bun-workspace-"));
}
function lease(overrides: Partial<LeaseRow> = {}): LeaseRow {
  const row = Object.fromEntries(
    FIELDS.map((field) => [field, ""]),
  ) as LeaseRow;
  Object.assign(
    row,
    {
      scope_id: "scope-a",
      project: "demo",
      repo_root: "/repo",
      branch: "main",
      worktree_path: "/repo",
      service: "web",
      port: "30060",
      port_base: "30060",
      block_size: "10",
      claimed_at: "2026-10-27T00:00:00Z",
      last_seen_at: "2026-10-27T00:00:00Z",
      agent_session: "agent",
      pid: "",
    },
    overrides,
  );
  return row;
}
const testLocks = new Map<string, boolean>();
function testLockFactory(path: string): LockHandle | null {
  if (testLocks.get(path)) return null;
  testLocks.set(path, true);
  return {
    release: () => {
      testLocks.delete(path);
    },
  };
}
function registry(root: string): PortRegistry {
  return new PortRegistry(root, {
    lockFactory: testLockFactory,
    portListening: () => false,
    processAlive: () => false,
    now: () => new Date("2026-10-27T00:00:00Z"),
  });
}
function allocation(scopeId: string, service = "web") {
  return {
    scopeId,
    service,
    project: "demo",
    repoRoot: "/repo",
    branch: "feature/test",
    worktreePath: `/repo/${scopeId}`,
    startBase: 20000,
    step: 10,
    blockSize: 10,
  };
}

describe("workspace port leases", () => {
  test("native flock serializes competing allocations", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), ".bun-workspace-native-")),
    );
    try {
      const options = { portListening: () => false, processAlive: () => false };
      const first = new PortRegistry(join(root, "registry"), options);
      const second = new PortRegistry(join(root, "registry"), options);
      const [a, b] = await Promise.all([
        first.allocate(allocation("scope-a")),
        second.allocate(allocation("scope-b")),
      ]);
      expect(a.port).not.toBe(b.port);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("concurrent allocations serialize and never duplicate a port", async () => {
    const root = await temporaryDirectory();
    try {
      const store = registry(join(root, "registry"));
      const [first, second] = await Promise.all([
        store.allocate(allocation("scope-a")),
        store.allocate(allocation("scope-b")),
      ]);
      expect(first.port).not.toBe(second.port);
      const rows = await store.readRows();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.port)).size).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reuses a scope lease and keeps service offsets in its block", async () => {
    const root = await temporaryDirectory();
    try {
      const store = registry(join(root, "registry"));
      const web = await store.allocate(allocation("scope-a", "web"));
      const api = await store.allocate(allocation("scope-a", "api"));
      const again = await store.allocate(allocation("scope-a", "web"));
      expect(web.created).toBe(true);
      expect(again.created).toBe(false);
      expect(api.port_base).toBe(web.port_base);
      expect(api.port).toBe(Number(web.port) + 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("releasing one scope does not touch another scope", async () => {
    const root = await temporaryDirectory();
    try {
      const store = registry(join(root, "registry"));
      await store.allocate(allocation("scope-a"));
      await store.allocate(allocation("scope-b"));
      const released = await store.releaseScope("scope-a");
      const rows = await store.readRows();
      expect(released.released).toBe(1);
      expect(rows.map((row) => row.scope_id)).toEqual(["scope-b"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("garbage-collects a dead pid lease before allocation", async () => {
    const root = await temporaryDirectory();
    try {
      const store = registry(join(root, "registry"));
      await store.ensureLayout();
      await store.atomicWrite([
        lease({ port: "20000", port_base: "20000", pid: "99999" }),
      ]);
      const allocated = await store.allocate(allocation("scope-b"));
      const rows = await store.readRows();
      expect(allocated.gc_removed).toBe(1);
      expect(rows.map((row) => row.scope_id)).toEqual(["scope-b"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("binds a pid on a lease that was registered without one", async () => {
    const root = await temporaryDirectory();
    try {
      const store = registry(join(root, "registry"));
      await store.register({
        scopeId: "scope-a",
        service: "web",
        port: 20000,
      });
      await store.heartbeat({
        scopeId: "scope-a",
        service: "web",
        port: 20000,
        pid: 111,
        agentSession: "native-session",
      });
      await expect(store.readRows()).resolves.toEqual([
        expect.objectContaining({
          scope_id: "scope-a",
          service: "web",
          port: "20000",
          pid: "111",
          agent_session: "native-session",
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("records the pid only after the listener binds", async () => {
    const root = await temporaryDirectory();
    try {
      let listening = false;
      const store = new PortRegistry(join(root, "registry"), {
        lockFactory: testLockFactory,
        portListening: () => listening,
        processAlive: () => true,
      });
      await store.register({
        scopeId: "scope-a",
        service: "web",
        port: 20000,
      });
      let rowsDuringStart: LeaseRow[] = [];
      await expect(
        store.claimAndRun(
          { scopeId: "scope-a", service: "web", port: 20000, pid: 111 },
          async () => {
            rowsDuringStart = await store.readRows();
            listening = true;
            return "started";
          },
        ),
      ).resolves.toBe("started");
      expect(rowsDuringStart[0]?.pid).toBe("");
      await expect(store.readRows()).resolves.toEqual([
        expect.objectContaining({
          scope_id: "scope-a",
          service: "web",
          port: "20000",
          pid: "111",
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects duplicate startup without replacing an active owner", async () => {
    const root = await temporaryDirectory();
    try {
      let listening = false;
      const store = new PortRegistry(join(root, "registry"), {
        lockFactory: testLockFactory,
        portListening: () => listening,
        processAlive: () => true,
      });
      await store.register({
        scopeId: "scope-a",
        service: "web",
        port: 20000,
        pid: 111,
      });
      listening = true;
      await expect(
        store.claimAndRun(
          { scopeId: "scope-a", service: "web", port: 20000, pid: 222 },
          () => "must-not-run",
        ),
      ).rejects.toThrow("already owned by pid 111");
      await expect(store.readRows()).resolves.toEqual([
        expect.objectContaining({
          scope_id: "scope-a",
          service: "web",
          port: "20000",
          pid: "111",
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not let a replaced service lease be changed by the old owner", async () => {
    const root = await temporaryDirectory();
    try {
      let leasePhase = 0;
      const store = new PortRegistry(join(root, "registry"), {
        lockFactory: testLockFactory,
        portListening: (port) =>
          leasePhase === 1
            ? port === 20000
            : leasePhase === 2 && port === 20010,
        processAlive: () => true,
      });
      await store.register({
        scopeId: "scope-a",
        service: "web",
        port: 20000,
        pid: 111,
      });
      leasePhase = 1;
      await store.register({
        scopeId: "scope-a",
        service: "web",
        port: 20010,
        pid: 222,
      });
      leasePhase = 2;
      await expect(
        store.heartbeat({
          scopeId: "scope-a",
          service: "web",
          port: 20000,
          pid: 111,
          expectedPid: 111,
        }),
      ).rejects.toThrow("lease ownership changed");
      await expect(
        store.releaseService("scope-a", "web", 24, 10, {
          port: 20000,
          pid: 111,
        }),
      ).rejects.toThrow("lease ownership changed");
      await expect(store.readRows()).resolves.toEqual([
        expect.objectContaining({
          scope_id: "scope-a",
          service: "web",
          port: "20010",
          pid: "222",
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a same-port lease owned by a different pid", async () => {
    const root = await temporaryDirectory();
    try {
      let portListening = false;
      const store = new PortRegistry(join(root, "registry"), {
        lockFactory: testLockFactory,
        portListening: () => portListening,
        processAlive: () => true,
      });
      await store.register({
        scopeId: "scope-a",
        service: "web",
        port: 20000,
        pid: 222,
      });
      portListening = true;
      await expect(
        store.heartbeat({
          scopeId: "scope-a",
          service: "web",
          port: 20000,
          pid: 111,
          expectedPid: 111,
        }),
      ).rejects.toThrow("lease ownership changed");
      await expect(
        store.releaseService("scope-a", "web", 24, 10, {
          port: 20000,
          pid: 111,
        }),
      ).rejects.toThrow("lease ownership changed");
      await expect(store.readRows()).resolves.toEqual([
        expect.objectContaining({
          scope_id: "scope-a",
          service: "web",
          port: "20000",
          pid: "222",
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not overwrite a lease replaced after inspection", async () => {
    const root = await temporaryDirectory();
    try {
      let portListening = false;
      const store = new PortRegistry(join(root, "registry"), {
        lockFactory: testLockFactory,
        portListening: () => portListening,
        processAlive: () => true,
      });
      await store.register({
        scopeId: "scope-a",
        service: "web",
        port: 20000,
        pid: 222,
      });
      portListening = true;
      await expect(
        store.register({
          scopeId: "scope-a",
          service: "web",
          port: 20000,
          pid: 333,
          expectedPid: 111,
        }),
      ).rejects.toThrow("lease ownership changed");
      await expect(store.readRows()).resolves.toEqual([
        expect.objectContaining({
          scope_id: "scope-a",
          service: "web",
          port: "20000",
          pid: "222",
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("stable scope suggestions spread foreign scopes above the default base", async () => {
    const first = await selectPort(
      [],
      "scope-alpha",
      "web",
      10000,
      10,
      10,
      () => false,
    );
    const second = await selectPort(
      [
        lease({
          scope_id: "foreign",
          port: String(first[0]),
          port_base: String(first[1]),
        }),
      ],
      "scope-alpha",
      "web",
      10000,
      10,
      10,
      () => false,
    );
    expect(first[0]).toBeGreaterThanOrEqual(10000);
    expect(second[1]).not.toBe(first[1]);
  });
});

function contextRunner(
  candidate: string,
  runtime: string,
  failure = false,
): { runner: CandidateRunner; requests: ProcessRequest[] } {
  const requests: ProcessRequest[] = [];
  const common = "/repo/.git";
  const runner: CandidateRunner = async (request) => {
    requests.push(request);
    if (request.command !== "git") return result("", failure ? 1 : 0);
    const args = (request.args ?? []).join(" ");
    const root = request.cwd === candidate ? candidate : runtime;
    if (args === "rev-parse --show-toplevel") return result(`${root}\n`);
    if (args === "rev-parse --git-dir")
      return result(
        `${request.cwd === candidate ? `${common}/worktrees/candidate` : common}\n`,
      );
    if (args === "rev-parse --git-common-dir") return result(`${common}\n`);
    if (args === "remote get-url origin")
      return result("git@github.com:IvanLi-CN/dot-codex.git\n");
    return result("");
  };
  return { runner, requests };
}

async function makeDotCodexPair(): Promise<{
  root: string;
  candidate: string;
  runtime: string;
}> {
  const root = await temporaryDirectory();
  const candidate = join(root, "candidate");
  const runtime = join(root, "runtime");
  for (const directory of [candidate, runtime]) {
    await mkdir(join(directory, "agents"), { recursive: true });
    await mkdir(join(directory, "skills"), { recursive: true });
    await writeFile(join(directory, "config.toml"), "[test]\n");
  }
  return { root, candidate, runtime };
}

describe("candidate context protections", () => {
  test("allows a linked candidate only with the matching runtime repository", async () => {
    const pair = await makeDotCodexPair();
    try {
      const { runner } = contextRunner(pair.candidate, pair.runtime);
      const context = await inspectContext(pair.candidate, "write", {
        runner,
        environ: { CODEX_HOME: pair.runtime },
      });
      expect(context.write_allowed).toBe(true);
      expect(context.candidate_root).toBe(pair.candidate);
      expect(context.runtime_home).toBe(pair.runtime);
      const runtime = await inspectContext(pair.runtime, "read", {
        runner,
        environ: { CODEX_HOME: pair.runtime },
      });
      expect(runtime.write_allowed).toBe(false);
    } finally {
      await rm(pair.root, { recursive: true, force: true });
    }
  });

  test("removes runtime and Git context from fixed checks", async () => {
    const pair = await makeDotCodexPair();
    try {
      const { runner, requests } = contextRunner(pair.candidate, pair.runtime);
      const validation = await validateCandidate(pair.candidate, {
        runner,
        environ: { CODEX_HOME: pair.runtime, GIT_DIR: "/foreign" },
        fixedChecks: () => [{ name: "fixed", argv: ["bun", "test"] }],
      });
      expect(validation.ok).toBe(true);
      const fixed = requests.find((request) => request.command === "bun");
      expect(fixed?.env?.CODEX_HOME).toBeUndefined();
      expect(fixed?.env?.GIT_DIR).toBeUndefined();
      expect(fixed?.env?.HOME).not.toBe(pair.runtime);
    } finally {
      await rm(pair.root, { recursive: true, force: true });
    }
  });

  test("stops fixed validation at the first failing entrypoint", async () => {
    const pair = await makeDotCodexPair();
    try {
      const { runner: baseRunner } = contextRunner(
        pair.candidate,
        pair.runtime,
      );
      let calls = 0;
      const runner: CandidateRunner = async (request) => {
        if (request.command === "bun") {
          calls += 1;
          return result("failure", 7);
        }
        return baseRunner(request);
      };
      const validation = await validateCandidate(pair.candidate, {
        runner,
        environ: { CODEX_HOME: pair.runtime },
        fixedChecks: () => [
          { name: "first", argv: ["bun", "first"] },
          { name: "second", argv: ["bun", "second"] },
        ],
      });
      expect(validation.ok).toBe(false);
      expect(calls).toBe(1);
      expect(validation.checks as unknown[]).toHaveLength(1);
    } finally {
      await rm(pair.root, { recursive: true, force: true });
    }
  });
});

const cleanContext = {
  result: "merged",
  desired_closeout_status: "完成",
  pending_user_decision: false,
  blocking_reason: "",
  local_branch: { status: "不存在", is_pr_head: true, name: "th/example" },
  pr_worktree: { status: "不存在", is_clean: null, path: "/tmp/example" },
  pr_worktree_required: "yes",
  remote_branch: { status: "不存在", source_repo_unavailable: false },
  port_lease: { status: "不存在", scope_resolved: true },
  required_pr_worktree_paths: ["/tmp/example"],
  observed_worktree_paths: ["/tmp/main"],
  codex_managed_worktree_paths: [],
};
const localContext = {
  desired_closeout_status: "完成",
  pending_cleanup_action: "none",
  dirty_worktree_policy: "preserved_unrelated",
  topic_branch_action: "deleted_forced",
  blocking_reason: "",
  base_branch: "main",
  current_branch: "main",
  worktree_clean: "no",
  topic_branch: "th/example",
  topic_branch_present: "no",
  head_sha: "a".repeat(40),
  base_head_sha: "b".repeat(40),
  optional_push_status: "未请求",
  merge_worktree: { path: "/repo/.wt/merge", status: "removed" },
  observed_worktree_paths: ["/repo"],
};

describe("cleanup gates", () => {
  test("accepts complete PR cleanup only when every required state is closed", () => {
    const result = evaluateCloseoutGate(cleanContext);
    expect(result.allowed_complete).toBe(true);
    expect(result.violations).toEqual([]);
  });
  test("protects native Worktrees and unresolved port leases", () => {
    const result = evaluateCloseoutGate({
      ...cleanContext,
      observed_worktree_paths: ["/tmp/main", "/tmp/task"],
      codex_managed_worktree_paths: ["/tmp/task"],
      port_lease: { status: "存在", scope_resolved: true },
    });
    const codes = (result.violations as Array<{ code: string }>).map(
      (item) => item.code,
    );
    expect(codes).toContain("CODEX_MANAGED_WORKTREE_ARCHIVE_REQUIRED");
    expect(codes).toContain("PORT_LEASE_STILL_EXISTS");
    expect(result.allowed_complete).toBe(false);
  });
  test("keeps dirty PR worktrees on the user-decision path", () => {
    const result = evaluateCloseoutGate({
      ...cleanContext,
      pr_worktree: { status: "存在", is_clean: false, path: "/tmp/example" },
    });
    expect(
      (result.violations as Array<{ code: string }>).map((item) => item.code),
    ).toContain("PR_WORKTREE_EXISTS_DIRTY");
  });
  test("allows unrelated dirty state for local merge and blocks a non-base branch", () => {
    expect(evaluateLocalMergeCloseoutGate(localContext).allowed_complete).toBe(
      true,
    );
    const result = evaluateLocalMergeCloseoutGate({
      ...localContext,
      current_branch: "th/example",
    });
    expect(
      (result.violations as Array<{ code: string }>).map((item) => item.code),
    ).toContain("CURRENT_BRANCH_NOT_BASE");
  });
  test("parses live worktree rows and context facts", async () => {
    expect(
      parseWorktreePorcelain(
        "worktree /repo\nbranch refs/heads/main\n\nworktree /repo/.wt/merge\nbranch refs/heads/tmp\n",
      ),
    ).toHaveLength(2);
    const runner: CandidateRunner = async (request) => {
      const args = (request.args ?? []).join(" ");
      if (args === "worktree list --porcelain")
        return result("worktree /repo\nbranch refs/heads/main\n");
      if (args === "rev-parse --abbrev-ref HEAD") return result("main\n");
      if (args === "status --porcelain") return result(" M config.toml\n");
      if (args === "rev-parse HEAD") return result("a\n");
      return result("b\n");
    };
    const context = await buildLocalMergeCloseoutContext(
      {
        repoRoot: "/repo",
        baseBranch: "main",
        topicBranch: "",
        mergeWorktreePath: "/repo/.wt/merge",
      },
      { runner },
    );
    expect(context.topic_branch_present).toBe("unknown");
    expect((context.merge_worktree as { status: string }).status).toBe(
      "removed",
    );
  });
});

function mergeRunner(
  root: string,
  status = "",
  localOid = "a".repeat(40),
): MergeRunner {
  return async (request) => {
    const args = (request.args ?? []).join(" ");
    if (args === "rev-parse --show-toplevel") return result(`${root}\n`);
    if (args === "rev-parse --is-inside-work-tree") return result("true\n");
    if (args.startsWith("rev-parse --verify --end-of-options HEAD"))
      return result(`${localOid}\n`);
    if (args.includes("@{upstream}")) return result("", 1);
    if (args.startsWith("status --porcelain")) return result(status);
    return result("");
  };
}
function prFacts(
  head = "a".repeat(40),
  state = "OPEN",
): Record<string, unknown> {
  return {
    provider: "github",
    number: 1,
    state,
    baseRefName: "main",
    baseRefOid: "b".repeat(40),
    baseRepository: "IvanLi-CN/dot-codex",
    headRefName: "feature/test",
    headRefOid: head,
    headRepository: { nameWithOwner: "IvanLi-CN/dot-codex" },
    url: "https://github.com/IvanLi-CN/dot-codex/pull/1",
    isCrossRepository: false,
  };
}

describe("read-only merge preflight", () => {
  test("uses the provider web URL when the API also returns url", async () => {
    const requests: ProcessRequest[] = [];
    const facts = await defaultPrFacts(
      "IvanLi-CN/dot-codex",
      1,
      "/repo",
      async (request) => {
        requests.push(request);
        if (request.command === "git")
          return result("https://github.com/IvanLi-CN/dot-codex.git\n");
        return result(
          JSON.stringify({
            number: 1,
            state: "OPEN",
            url: "https://api.github.com/repos/IvanLi-CN/dot-codex/pulls/1",
            html_url: "https://github.com/IvanLi-CN/dot-codex/pull/1",
            base: {
              ref: "main",
              sha: "b".repeat(40),
              repo: { full_name: "IvanLi-CN/dot-codex" },
            },
            head: {
              ref: "feature/test",
              sha: "a".repeat(40),
              repo: { full_name: "IvanLi-CN/dot-codex" },
            },
          }),
        );
      },
    );
    expect(facts.url).toBe("https://github.com/IvanLi-CN/dot-codex/pull/1");
    expect(requests.map((request) => request.command)).toEqual(["git", "gh"]);
  });

  test("accepts a clean exact head and locks the live head", async () => {
    const root = await temporaryDirectory();
    try {
      const [payload, code] = await evaluate(
        { repo: "IvanLi-CN/dot-codex", pr: 1, candidateRoot: root },
        { runner: mergeRunner(root), getPrFacts: async () => prFacts() },
      );
      expect(code).toBe(EXIT_ELIGIBLE);
      expect(payload.outcome).toBe("eligible");
      expect((payload.merge_guard as { locked_head: string }).locked_head).toBe(
        "a".repeat(40),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("classifies dirty worktrees as blocked and snapshots as stale", async () => {
    const root = await temporaryDirectory();
    try {
      const [blocked, blockedCode] = await evaluate(
        { repo: "IvanLi-CN/dot-codex", pr: 1, candidateRoot: root },
        {
          runner: mergeRunner(root, "? untracked file"),
          getPrFacts: async () => prFacts(),
        },
      );
      expect(blockedCode).toBe(EXIT_BLOCKED);
      expect(blocked.reason_codes).toEqual(["worktree_dirty"]);
      const [stale, staleCode] = await evaluate(
        {
          repo: "IvanLi-CN/dot-codex",
          pr: 1,
          candidateRoot: root,
          expectedHead: "c".repeat(40),
        },
        { runner: mergeRunner(root), getPrFacts: async () => prFacts() },
      );
      expect(staleCode).toBe(EXIT_INPUT_STALE);
      expect(stale.reason_codes).toContain("expected_head_mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("closed PRs and unavailable required reads fail closed", async () => {
    const root = await temporaryDirectory();
    try {
      const [closed, closedCode] = await evaluate(
        { repo: "IvanLi-CN/dot-codex", pr: 1, candidateRoot: root },
        {
          runner: mergeRunner(root),
          getPrFacts: async () => prFacts("a".repeat(40), "CLOSED"),
        },
      );
      expect(closedCode).toBe(EXIT_BLOCKED);
      expect(closed.reason_codes).toContain("pr_not_open");
      const [unknown, unknownCode] = await evaluate(
        { repo: "IvanLi-CN/dot-codex", pr: 1, candidateRoot: root },
        {
          runner: mergeRunner(root),
          getPrFacts: async () => {
            throw new CommandError(["provider"], root, null, "unavailable");
          },
        },
      );
      expect(unknownCode).toBe(EXIT_INDETERMINATE);
      expect(unknown.reason_codes).toEqual(["pr_facts_unavailable"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("malformed provider facts fail closed before eligibility", async () => {
    const root = await temporaryDirectory();
    try {
      const malformed = prFacts();
      malformed.number = 2;
      malformed.baseRepository = "other/repository";
      malformed.url = "https://github.com/other/repository/pull/2";
      malformed.baseRefOid = "not-a-sha";
      const [payload, code] = await evaluate(
        { repo: "IvanLi-CN/dot-codex", pr: 1, candidateRoot: root },
        { runner: mergeRunner(root), getPrFacts: async () => malformed },
      );
      expect(code).toBe(EXIT_INDETERMINATE);
      expect(payload.reason_codes).toContain("pr_facts_incomplete");
      expect(payload.outcome).toBe("indeterminate");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test("parses untracked, submodule, and rename paths without mutating commands", () => {
    const records = parsePorcelainV2(
      "? file with spaces\n1 .M S.. 100644 100644 100644 a b module\n2 R. N... 100644 100644 100644 a b\tnew name\told name",
    );
    expect(records.map((record) => record.kind)).toEqual([
      "untracked",
      "submodule",
      "tracked_rename",
    ]);
    expect(records[2]?.original_path).toBe("old name");
    expect(records[2]?.path).toBe("new name");
  });
});
