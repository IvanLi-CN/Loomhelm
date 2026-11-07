import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArguments, writeJson } from "../../modules/core/cli";
import { isoTimestamp, systemClock } from "../../modules/core/clock";
import { runProcess } from "../../modules/core/process";
import { sourcePolicyFailure } from "../../modules/core/source_policy";

describe("core adapters", () => {
  test("CLI arguments preserve options and positional tail", () => {
    expect(
      parseArguments([
        "run",
        "--count=3",
        "--filter=a=b",
        "--quiet",
        "--",
        "--literal",
      ]),
    ).toEqual({
      options: new Map<string, string | true>([
        ["count", "3"],
        ["filter", "a=b"],
        ["quiet", true],
      ]),
      positional: ["run", "--literal"],
    });
  });

  test("clock returns an ISO UTC timestamp", () => {
    expect(
      isoTimestamp({
        now: () => new Date("2026-10-27T00:00:00.000Z"),
        sleep: async () => {},
      }),
    ).toBe("2026-10-27T00:00:00.000Z");
  });

  test("clock removes abort listeners after successful sleeps", async () => {
    const signal = new AbortController().signal;
    const remove = signal.removeEventListener.bind(signal);
    let removed = 0;
    const trackRemove: typeof signal.removeEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) => {
      removed += 1;
      if (listener !== null) remove(type, listener, options);
    };
    signal.removeEventListener = trackRemove;
    await systemClock.sleep(0, signal);
    await systemClock.sleep(0, signal);
    expect(removed).toBe(2);
  });

  test("source policy enforces source and test physical-line boundaries", () => {
    const lines = (count: number, separator: string) =>
      Array(count).fill("line").join(separator);
    for (const separator of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
      expect(sourcePolicyFailure("skills/bin/source.ts", lines(400, separator))).toBe(
        null,
      );
      expect(
        sourcePolicyFailure("skills/bin/source.ts", lines(401, separator)),
      ).toContain("401 physical lines exceeds 400");
      expect(
        sourcePolicyFailure("skills/bin/tests/source.test.ts", lines(600, separator)),
      ).toBeNull();
      expect(
        sourcePolicyFailure("skills/bin/tests/source.test.ts", lines(601, separator)),
      ).toContain("601 physical lines exceeds 600");
    }
    expect(
      sourcePolicyFailure("bin\\tests\\source.test.ts", lines(600, "\n")),
    ).toBeNull();
  });

  test("process adapter captures output and exit status", async () => {
    const result = await runProcess({
      command: process.execPath,
      args: [
        "-e",
        'process.stdout.write("out"); process.stderr.write("err"); process.exit(7)',
      ],
    });
    expect(result).toEqual({
      exitCode: 7,
      stdout: "out",
      stderr: "err",
      timedOut: false,
    });
  });

  test.skipIf(process.platform === "win32")(
    "process supervision does not widen an explicit child environment",
    async () => {
      const key = "CODEX_PROCESS_TEST_SECRET";
      const previous = process.env[key];
      process.env[key] = "must-not-leak";
      try {
        const result = await runProcess({
          command: process.execPath,
          args: [
            "-e",
            `process.stdout.write((process.env.${key} ?? "missing") + ":" + (process.env.CODEX_PROCESS_SUPERVISION_TOKEN ? "token" : "no-token"))`,
          ],
          timeoutMs: 1000,
          env: { PATH: process.env.PATH },
        });
        expect(result.stdout).toBe("missing:token");
      } finally {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "process adapter reports a timed out child after termination",
    async () => {
      const result = await runProcess({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 5000)"],
        timeoutMs: 40,
      });
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).not.toBe(0);
    },
  );

  test.skipIf(process.platform === "win32")(
    "process adapter closes inherited pipes on timeout",
    async () => {
      const startedAt = Date.now();
      const childScript =
        'Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 5000)"], { stdout: "inherit", stderr: "inherit" }); process.exit(0)';
      const result = await runProcess({
        command: process.execPath,
        args: ["-e", childScript],
        timeoutMs: 40,
      });
      expect(result.timedOut).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(1500);
    },
  );

  test.skipIf(process.platform === "win32")(
    "process adapter kills descendants that ignore timeout termination",
    async () => {
      const childScript =
        'const child = Bun.spawn([process.execPath, "-e", "process.on(\\\"SIGTERM\\\", () => {}); setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); process.stdout.write(String(child.pid)); setInterval(() => {}, 1000)';
      const result = await runProcess({
        command: process.execPath,
        args: ["-e", childScript],
        timeoutMs: 80,
      });
      const childPid = Number(result.stdout);
      expect(result.timedOut).toBe(true);
      expect(Number.isInteger(childPid)).toBe(true);
      const state = await runProcess({
        command: "ps",
        args: ["-o", "stat=", "-p", String(childPid)],
      });
      expect(
        state.stdout.trim() === "" || state.stdout.trim().startsWith("Z"),
      ).toBe(true);
    },
  );

  test.skipIf(process.platform === "win32")(
    "process adapter cleans detached descendants when the parent is interrupted",
    async () => {
      const temporary = await mkdtemp(join(tmpdir(), "plan-process-signal-"));
      const marker = join(temporary, "child.pid");
      const helper = join(temporary, "helper.ts");
      const processModule = resolve(
        import.meta.dir,
        "../../modules/core/process.ts",
      );
      const childScript = `Bun.write(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
      await writeFile(
        helper,
        `import { runProcess } from ${JSON.stringify(processModule)};\nawait runProcess({ command: process.execPath, args: ["-e", ${JSON.stringify(childScript)}], timeoutMs: 10000 });\n`,
        "utf8",
      );
      const parent = Bun.spawn([process.execPath, "run", helper], {
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        let childPid = 0;
        for (let attempt = 0; attempt < 100 && childPid === 0; attempt += 1) {
          try {
            childPid = Number(await readFile(marker, "utf8"));
          } catch {}
          if (childPid === 0)
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
        process.kill(parent.pid, "SIGTERM");
        const exitCode = await Promise.race([
          parent.exited,
          new Promise<number>((_, reject) =>
            setTimeout(
              () => reject(new Error("signal cleanup timed out")),
              3000,
            ),
          ),
        ]);
        expect(exitCode).not.toBe(0);
        let state = await runProcess({
          command: "ps",
          args: ["-o", "stat=", "-p", String(childPid)],
        });
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (state.stdout.trim() === "" || state.stdout.trim().startsWith("Z"))
            break;
          await Bun.sleep(10);
          state = await runProcess({
            command: "ps",
            args: ["-o", "stat=", "-p", String(childPid)],
          });
        }
        expect(
          state.stdout.trim() === "" || state.stdout.trim().startsWith("Z"),
        ).toBe(true);
      } finally {
        parent.kill("SIGKILL");
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "process adapter cleans descendants after a successful leader exit",
    async () => {
      const childScript =
        'const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); process.stdout.write(String(child.pid)); setTimeout(() => process.exit(0), 40);';
      const result = await runProcess({
        command: process.execPath,
        args: ["-e", childScript],
        timeoutMs: 1000,
      });
      const childPid = Number(result.stdout);
      expect(result.exitCode).toBe(0);
      expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
      let state = await runProcess({
        command: "ps",
        args: ["-o", "stat=", "-p", String(childPid)],
      });
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (state.stdout.trim() === "" || state.stdout.trim().startsWith("Z"))
          break;
        await Bun.sleep(10);
        state = await runProcess({
          command: "ps",
          args: ["-o", "stat=", "-p", String(childPid)],
        });
      }
      expect(
        state.stdout.trim() === "" || state.stdout.trim().startsWith("Z"),
      ).toBe(true);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "process adapter cleans descendants that detach before leader exit",
    async () => {
      const childScript =
        'const child = Bun.spawn(["/usr/bin/setsid", process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); process.stdout.write(String(child.pid)); setTimeout(() => process.exit(0), 80);';
      const result = await runProcess({
        command: process.execPath,
        args: ["-e", childScript],
        timeoutMs: 1000,
      });
      const childPid = Number(result.stdout);
      expect(result.exitCode).toBe(0);
      expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
      let state = await runProcess({
        command: "ps",
        args: ["-o", "stat=", "-p", String(childPid)],
      });
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (state.stdout.trim() === "" || state.stdout.trim().startsWith("Z"))
          break;
        await Bun.sleep(10);
        state = await runProcess({
          command: "ps",
          args: ["-o", "stat=", "-p", String(childPid)],
        });
      }
      expect(
        state.stdout.trim() === "" || state.stdout.trim().startsWith("Z"),
      ).toBe(true);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "process adapter cleans a detached descendant after immediate leader exit",
    async () => {
      const childScript =
        'const child = Bun.spawn(["/usr/bin/setsid", process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); process.stdout.write(String(child.pid)); process.exit(0);';
      const result = await runProcess({
        command: process.execPath,
        args: ["-e", childScript],
        timeoutMs: 1000,
      });
      const childPid = Number(result.stdout);
      expect(result.exitCode).toBe(0);
      expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
      let state = await runProcess({
        command: "ps",
        args: ["-o", "stat=", "-p", String(childPid)],
      });
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (state.stdout.trim() === "" || state.stdout.trim().startsWith("Z"))
          break;
        await Bun.sleep(10);
        state = await runProcess({
          command: "ps",
          args: ["-o", "stat=", "-p", String(childPid)],
        });
      }
      expect(
        state.stdout.trim() === "" || state.stdout.trim().startsWith("Z"),
      ).toBe(true);
    },
  );

  test.skipIf(process.platform === "win32")(
    "process adapter escalates after returning from signal cancellation",
    async () => {
      const temporary = await mkdtemp(join(tmpdir(), "plan-process-return-"));
      const childMarker = join(temporary, "child.pid");
      const leaderReady = join(temporary, "leader-ready");
      const returnedMarker = join(temporary, "returned");
      const helper = join(temporary, "helper.ts");
      const processModule = resolve(
        import.meta.dir,
        "../../modules/core/process.ts",
      );
      let childPid = 0;
      let parent: Bun.Subprocess | undefined;
      try {
        const childScript =
          'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
        const leaderScript = `const fs = require("node:fs"); process.on("SIGTERM", () => { const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(childScript)}], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); fs.writeFileSync(${JSON.stringify(childMarker)}, String(child.pid)); process.exit(0); }); fs.writeFileSync(${JSON.stringify(leaderReady)}, "ready"); setInterval(() => {}, 1000);`;
        await writeFile(
          helper,
          `import { writeFileSync } from "node:fs";
import { runProcess } from ${JSON.stringify(processModule)};
const controller = new AbortController();
const pending = runProcess({ command: process.execPath, args: ["-e", ${JSON.stringify(leaderScript)}], signal: controller.signal, terminationGraceMs: 300, returnOnSignal: true, propagateParentSignal: false });
let ready = false;
for (let attempt = 0; attempt < 100; attempt += 1) {
  if (await Bun.file(${JSON.stringify(leaderReady)}).exists()) {
    ready = true;
    break;
  }
  await Bun.sleep(10);
}
if (!ready) throw new Error("leader did not become signal-ready");
controller.abort();
await pending;
writeFileSync(${JSON.stringify(returnedMarker)}, "returned");
process.exitCode = 0;
`,
          "utf8",
        );
        parent = Bun.spawn([process.execPath, "run", helper], {
          stdout: "pipe",
          stderr: "pipe",
        });
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (await Bun.file(returnedMarker).exists()) break;
          await Bun.sleep(10);
        }
        childPid = Number(await readFile(childMarker, "utf8"));
        expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
        const beforeEscalation = await runProcess({
          command: "ps",
          args: ["-o", "stat=", "-p", String(childPid)],
        });
        expect(
          beforeEscalation.stdout.trim() !== "" &&
            !beforeEscalation.stdout.trim().startsWith("Z"),
        ).toBe(true);
        const exitedEarly = await Promise.race([
          parent.exited.then(() => true),
          Bun.sleep(100).then(() => false),
        ]);
        expect(exitedEarly).toBe(false);
        const exitCode = await Promise.race([
          parent.exited,
          new Promise<number>((_, reject) =>
            setTimeout(
              () => reject(new Error("return-on-signal cleanup timed out")),
              3000,
            ),
          ),
        ]);
        expect(exitCode).toBe(0);
        const state = await runProcess({
          command: "ps",
          args: ["-o", "stat=", "-p", String(childPid)],
        });
        expect(
          state.stdout.trim() === "" || state.stdout.trim().startsWith("Z"),
        ).toBe(true);
      } finally {
        if (childPid > 0) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {}
        }
        parent?.kill("SIGKILL");
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform !== "linux")(
    "process adapter closes pipes held by detached descendants",
    async () => {
      const childScript =
        'const child = Bun.spawn(["/usr/bin/setsid", process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "inherit", stderr: "inherit" }); process.stdout.write(String(child.pid)); setTimeout(() => process.exit(0), 80);';
      const result = await runProcess({
        command: process.execPath,
        args: ["-e", childScript],
        timeoutMs: 1000,
      });
      expect(result.exitCode).toBe(0);
      expect(Number(result.stdout)).toBeGreaterThan(0);
    },
  );

  test.skipIf(process.platform !== "win32")(
    "process adapter rejects unsupported Windows tree timeouts",
    async () => {
      await expect(
        runProcess({ command: process.execPath, timeoutMs: 40 }),
      ).rejects.toThrow("process_tree_timeout_unavailable");
    },
  );

  test("JSON output terminates with one newline", () => {
    let output = "";
    writeJson({ ok: true }, {
      write: (chunk) => {
        output += chunk;
        return true;
      },
    } as NodeJS.WritableStream);
    expect(output).toBe('{"ok":true}\n');
  });
});
