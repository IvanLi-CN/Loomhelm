import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cloneReportFile,
  runSandboxedCommand,
  sandboxAvailable,
} from "../../modules/visual/isolation";
import { htmlReportIssue } from "../../modules/visual/report_artifacts";
import { renameNoReplace } from "../../modules/visual/secure_io";

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("visual native isolation adapter", () => {
  test("native isolation capability is verified on macOS and fails closed elsewhere", () => {
    const root = tempRoot("visual-native-");
    const source = join(root, "source");
    const clone = join(root, "clone");
    writeFileSync(source, "report");
    if (process.platform === "darwin") {
      expect(sandboxAvailable()).toBe(true);
      cloneReportFile(source, clone);
      expect(lstatSync(clone).isFile()).toBe(true);
      expect(lstatSync(clone).nlink).toBe(1);
      expect(readFileSync(clone, "utf8")).toBe("report");
    } else {
      expect(sandboxAvailable()).toBe(false);
      expect(() => cloneReportFile(source, clone)).toThrow("unavailable");
    }
  });

  test.skipIf(!sandboxAvailable())(
    "sandbox reads snapshot links and stops detached descendants",
    async () => {
      const root = tempRoot("visual-sandbox-descendants-");
      const actual = join(root, "actual");
      mkdirSync(actual);
      mkdirSync(join(root, "expected"));
      const source = join(root, "snapshot.png");
      writeFileSync(source, "snapshot");
      symlinkSync(source, join(actual, "page.png"));
      const readRuntime = join(root, "read-runtime");
      runSandboxedCommand(root, ["/bin/cat", join(actual, "page.png")], {
        runtimeDir: readRuntime,
        env: { PATH: "/bin:/usr/bin" },
        allowNetwork: false,
        label: "snapshot-read",
        workingDirectory: root,
      });
      expect(
        readFileSync(join(readRuntime, "snapshot-read.stdout.log"), "utf8"),
      ).toBe("snapshot");
      const marker = join(root, "late-marker");
      const childPidPath = join(root, "child.pid");
      const script = `(i=0; while [ "$i" -lt 100000000 ]; do i=$((i+1)); done; echo late > ${JSON.stringify(marker)}) >/dev/null 2>&1 & echo $! > ${JSON.stringify(childPidPath)}; exit 0`;
      runSandboxedCommand(root, ["/bin/bash", "-c", script], {
        runtimeDir: join(root, "descendant-runtime"),
        env: { PATH: "/bin:/usr/bin" },
        allowNetwork: false,
        label: "detached-child",
        workingDirectory: root,
      });
      await Bun.sleep(50);
      let childAlive = false;
      if (existsSync(childPidPath)) {
        const childPid = Number(readFileSync(childPidPath, "utf8").trim());
        if (Number.isInteger(childPid) && childPid > 0) {
          try {
            process.kill(childPid, 0);
            childAlive = true;
            process.kill(childPid, "SIGKILL");
          } catch {}
        }
      }
      expect(childAlive).toBe(false);
      expect(existsSync(marker)).toBe(false);
    },
  );

  test.skipIf(!sandboxAvailable())(
    "sandbox cleanup does not kill unrelated staging users",
    async () => {
      const root = tempRoot("visual-sandbox-unrelated-");
      const runtime = join(root, "runtime");
      mkdirSync(runtime);
      const unrelated = spawn("/bin/sleep", ["3"], {
        cwd: root,
        stdio: "ignore",
      });
      try {
        await Bun.sleep(20);
        runSandboxedCommand(root, ["/bin/echo", "ok"], {
          runtimeDir: runtime,
          env: { PATH: "/bin:/usr/bin" },
          allowNetwork: false,
          label: "unrelated-process",
          workingDirectory: root,
        });
        expect(unrelated.pid).toBeDefined();
        expect(() => process.kill(unrelated.pid ?? -1, 0)).not.toThrow();
      } finally {
        if (unrelated.pid && !unrelated.killed)
          try {
            process.kill(unrelated.pid, "SIGKILL");
          } catch {}
        unrelated.unref();
      }
    },
  );

  test.skipIf(!sandboxAvailable())(
    "sandbox startup failures do not target the caller process group",
    () => {
      const root = tempRoot("visual-sandbox-startup-");
      const missingDirectory = join(root, "missing");
      expect(() =>
        runSandboxedCommand(root, ["/bin/echo", "ok"], {
          runtimeDir: join(root, "runtime"),
          env: { PATH: "/bin:/usr/bin" },
          allowNetwork: false,
          label: "startup-failure",
          workingDirectory: missingDirectory,
        }),
      ).toThrow("failed to start");
      expect(process.pid).toBeGreaterThan(0);
    },
  );

  test.skipIf(!sandboxAvailable())(
    "sandbox preserves target signal failures",
    () => {
      const root = tempRoot("visual-sandbox-signal-");
      expect(() =>
        runSandboxedCommand(
          root,
          [process.execPath, "-e", 'process.kill(process.pid, "SIGTERM")'],
          {
            runtimeDir: join(root, "runtime"),
            env: { PATH: "/bin:/usr/bin" },
            allowNetwork: false,
            label: "signal-failure",
            workingDirectory: root,
          },
        ),
      ).toThrow("terminated by SIGTERM");
    },
  );

  test.skipIf(!sandboxAvailable())(
    "sandbox preserves SIGPIPE target failures",
    () => {
      const root = tempRoot("visual-sandbox-sigpipe-");
      expect(() =>
        runSandboxedCommand(root, ["/bin/bash", "-c", "kill -PIPE $$"], {
          runtimeDir: join(root, "runtime"),
          env: { PATH: "/bin:/usr/bin" },
          allowNetwork: false,
          label: "sigpipe-failure",
          workingDirectory: root,
        }),
      ).toThrow("terminated by SIGPIPE");
    },
  );

  test.skipIf(!sandboxAvailable())(
    "sandbox log files do not delay process-group cleanup",
    async () => {
      const root = tempRoot("visual-sandbox-log-fd-");
      const runtime = join(root, "runtime");
      mkdirSync(runtime);
      const marker = join(root, "late-marker");
      const childScript = `await Bun.sleep(500); await Bun.write(${JSON.stringify(marker)}, "late");`;
      const parentScript = `const { spawn } = await import("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "inherit" }).unref();`;
      runSandboxedCommand(root, [process.execPath, "-e", parentScript], {
        runtimeDir: runtime,
        env: { PATH: "/usr/bin:/bin" },
        allowNetwork: false,
        label: "log-fd-cleanup",
        workingDirectory: root,
      });
      expect(existsSync(marker)).toBe(false);
      await Bun.sleep(650);
      expect(existsSync(marker)).toBe(false);
    },
  );

  test.skipIf(!sandboxAvailable())(
    "sandbox monitor ignores staging Bun configuration",
    () => {
      const root = tempRoot("visual-sandbox-monitor-config-");
      const marker = join(root, "monitor-preload-marker");
      writeFileSync(join(root, "bunfig.toml"), 'preload = ["./preload.js"]\n');
      writeFileSync(
        join(root, "preload.js"),
        `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(marker)}, "loaded");`,
      );
      runSandboxedCommand(root, ["/bin/echo", "ok"], {
        runtimeDir: join(root, "runtime"),
        env: { PATH: "/bin:/usr/bin" },
        allowNetwork: false,
        label: "monitor-config",
        workingDirectory: root,
      });
      expect(existsSync(marker)).toBe(false);
    },
  );

  test.skipIf(!sandboxAvailable())(
    "sandbox timeout retains target diagnostics",
    () => {
      const root = tempRoot("visual-sandbox-timeout-");
      expect(() =>
        runSandboxedCommand(
          root,
          ["/bin/bash", "-c", "echo timeout >&2; while :; do :; done"],
          {
            runtimeDir: join(root, "runtime"),
            env: { PATH: "/bin:/usr/bin" },
            allowNetwork: false,
            label: "timeout",
            workingDirectory: root,
            timeoutMs: 500,
          },
        ),
      ).toThrow("timed out: timeout");
    },
  );

  test("HTML reports require an exact, duplicate-free comparison set", () => {
    const root = tempRoot("visual-html-report-");
    const report = join(root, "report.html");
    writeFileSync(
      report,
      `<html><div id="app"></div><script>window['__reg__'] = ${JSON.stringify({
        actualDir: "./actual",
        expectedDir: "./expected",
        diffDir: "./diff",
        newItems: [],
        deletedItems: [],
        hasNew: false,
        hasDeleted: false,
        hasFailed: true,
        hasPassed: false,
        failedItems: [
          { raw: "page.png", encoded: "page.png" },
          { raw: "page.png", encoded: "page.png" },
        ],
        passedItems: [],
      })};</script><script>function renderReport(){ return 'rendered reg-cli application'; }</script></html>`,
    );
    expect(
      htmlReportIssue(report, {
        actualItems: ["page.png", "other.png"],
        expectedItems: ["page.png", "other.png"],
        failedItems: ["page.png", "other.png"],
        passedItems: [],
        diffItems: ["page.png", "other.png"],
      }),
    ).toContain("exactly");
    const commented = join(root, "commented.html");
    writeFileSync(
      commented,
      `<!-- <div id="app"></div><script>window['__reg__'] = {};</script><script>render()</script> -->`,
    );
    expect(
      htmlReportIssue(commented, {
        actualItems: [],
        expectedItems: [],
        failedItems: [],
        passedItems: [],
        diffItems: [],
      }),
    ).toContain("missing");
    const unclosed = join(root, "unclosed.html");
    writeFileSync(
      unclosed,
      `<!-- <div id="app"></div><script>window['__reg__'] = {};</script>`,
    );
    expect(
      htmlReportIssue(unclosed, {
        actualItems: [],
        expectedItems: [],
        failedItems: [],
        passedItems: [],
        diffItems: [],
      }),
    ).toContain("missing");
    const fakeMount = join(root, "fake-mount.html");
    writeFileSync(
      fakeMount,
      `<div data-note=" id='app'" title=">"></div><script>const markup = '<div id="app"></div>';</script>`,
    );
    expect(
      htmlReportIssue(fakeMount, {
        actualItems: [],
        expectedItems: [],
        failedItems: [],
        passedItems: [],
        diffItems: [],
      }),
    ).toContain("missing");
    const realMount = join(root, "real-mount.html");
    writeFileSync(
      realMount,
      `<div title=">" id=app></div><script>window['__reg__'] = ${JSON.stringify(
        {
          actualDir: "./actual",
          expectedDir: "./expected",
          diffDir: "./diff",
          newItems: [],
          deletedItems: [],
          hasNew: false,
          hasDeleted: false,
          hasFailed: false,
          hasPassed: false,
          failedItems: [],
          passedItems: [],
        },
      )};</script><script>function renderReport(){ return 'rendered reg-cli application'; }</script>`,
    );
    expect(
      htmlReportIssue(realMount, {
        actualItems: [],
        expectedItems: [],
        failedItems: [],
        passedItems: [],
        diffItems: [],
      }),
    ).toBeUndefined();
    const fakeScript = join(root, "fake-script.html");
    writeFileSync(
      fakeScript,
      `<div id="app"></div><script-placeholder>window['__reg__'] = {};</script-placeholder><script-placeholder>function renderReport(){ return 'rendered'; }</script-placeholder>`,
    );
    expect(
      htmlReportIssue(fakeScript, {
        actualItems: [],
        expectedItems: [],
        failedItems: [],
        passedItems: [],
        diffItems: [],
      }),
    ).toContain("missing");
    const splitMount = join(root, "split-mount.html");
    writeFileSync(
      splitMount,
      `<di<!-- comment -->v id="app"></div><script>window['__reg__'] = {};</script><script>function renderReport(){ return 'rendered'; }</script>`,
    );
    expect(
      htmlReportIssue(splitMount, {
        actualItems: [],
        expectedItems: [],
        failedItems: [],
        passedItems: [],
        diffItems: [],
      }),
    ).toContain("missing");
    const scriptComment = join(root, "script-comment.html");
    writeFileSync(
      scriptComment,
      `<script><!-- legacy comment\nvar unused=1;</script><!-- <div id="app"></div> -->`,
    );
    expect(
      htmlReportIssue(scriptComment, {
        actualItems: [],
        expectedItems: [],
        failedItems: [],
        passedItems: [],
        diffItems: [],
      }),
    ).toContain("missing");
  });

  test.skipIf(!["darwin", "linux"].includes(process.platform))(
    "atomic publication rename never replaces an existing destination",
    () => {
      const root = tempRoot("visual-publication-race-");
      const source = join(root, ".publication");
      const destination = join(root, "report");
      mkdirSync(source);
      mkdirSync(destination);
      expect(() => renameNoReplace(source, destination)).toThrow(
        "destination already exists",
      );
      expect(lstatSync(source).isDirectory()).toBe(true);
      expect(lstatSync(destination).isDirectory()).toBe(true);
    },
  );
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
