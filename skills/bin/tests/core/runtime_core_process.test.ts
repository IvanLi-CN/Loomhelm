import { describe, expect, test } from "bun:test";
import { runProcess } from "../../../../packages/runtime-core/src/modules/core/process";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const child = (script: string) => ({
  command: process.execPath,
  args: ["-e", script],
});

describe("published runtime process supervision", () => {
  test("streams 80 MiB without retaining output and awaits each sink", async () => {
    const bytes = 80 * 1024 * 1024;
    let received = 0;
    let active = 0;
    let peak = 0;
    const result = await runProcess({
      ...child(
        `const chunk=new Uint8Array(65536).fill(120); for(let n=0;n<${bytes};n+=chunk.length) await Bun.write(Bun.stdout,chunk);`,
      ),
      timeoutMs: 20_000,
      maxCapturedOutputBytes: 0,
      outputSink: async (stream, chunk) => {
        expect(stream).toBe("stdout");
        peak = Math.max(peak, ++active);
        await Bun.sleep(1);
        received += chunk.byteLength;
        active--;
      },
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    });
    expect(received).toBe(bytes);
    expect(peak).toBe(1);
  }, 30_000);

  test("preserves synchronous sink return values and capture limits", async () => {
    const streams: string[] = [];
    const result = await runProcess({
      ...child('console.log("hello"); console.error("error");'),
      maxCapturedOutputBytes: 3,
      outputSink: (stream) => streams.push(stream),
    });
    expect(result.stdout).toBe("hel");
    expect(result.stderr).toBe("err");
    expect(streams.sort()).toEqual(["stderr", "stdout"]);
  });

  test("uses IPC for cooperative stop without mixing control into output", async () => {
    const controller = new AbortController();
    let send: (message: unknown) => void = () => {
      throw new Error("not spawned");
    };
    let acknowledged!: () => void;
    const stopped = new Promise<void>((resolve) => {
      acknowledged = resolve;
    });
    let calls = 0;
    const result = await runProcess({
      ...child(
        'process.on("message",m=>{if(m==="stop"){console.log("saved");process.send("stopped");process.disconnect();}});process.send("ready");',
      ),
      signal: controller.signal,
      maxCapturedOutputBytes: 1024,
      onSpawn: (control) => {
        send = control.send;
      },
      onControlMessage: (message) => {
        if (message === "ready") controller.abort();
        if (message === "stopped") acknowledged();
      },
      cooperativeStop: async () => {
        calls++;
        send("stop");
        await stopped;
      },
      cooperativeStopTimeoutMs: 2000,
    });
    expect(calls).toBe(1);
    expect(result.stdout).toBe("saved\n");
    expect(result.stderr).toBe("");
  });

  test("bounds unresponsive cooperative stop and joins the child", async () => {
    let pid = 0;
    let calls = 0;
    const start = performance.now();
    const result = await runProcess({
      ...child('process.on("SIGTERM",()=>{});setInterval(()=>{},1000);'),
      timeoutMs: 100,
      terminationGraceMs: 30,
      onSpawn: (control) => {
        pid = control.pid;
      },
      cooperativeStop: () => {
        calls++;
        return new Promise(() => {});
      },
      cooperativeStopTimeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
    expect(calls).toBe(1);
    expect(alive(pid)).toBe(false);
    expect(performance.now() - start).toBeLessThan(5000);
  });

  for (const failure of ["spawn", "control", "sink"] as const) {
    test(`${failure} callback failure rejects after reaping the child`, async () => {
      let pid = 0;
      const fail = () => {
        throw new Error(`failed-${failure}`);
      };
      await expect(
        runProcess({
          ...child(
            'console.log("output");if(process.send)process.send("ready");setInterval(()=>{},1000);',
          ),
          terminationGraceMs: 20,
          onSpawn: (control) => {
            pid = control.pid;
            if (failure === "spawn") fail();
          },
          ...(failure === "control" ? { onControlMessage: fail } : {}),
          ...(failure === "sink"
            ? {
                outputSink: async () => {
                  await Bun.sleep(1);
                  fail();
                },
              }
            : {}),
        }),
      ).rejects.toThrow(`failed-${failure}`);
      expect(alive(pid)).toBe(false);
    });
  }

  test("rejects invalid cooperative deadlines before spawning", async () => {
    for (const deadline of [0, -1, NaN, Infinity, 200_001, 1.5]) {
      await expect(
        runProcess({ ...child(""), cooperativeStopTimeoutMs: deadline }),
      ).rejects.toThrow("invalid_cooperative_stop_timeout");
    }
  });

  test("reaps owned descendants after the leader exits", async () => {
    const descendant = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);';
    const result = await runProcess({
      ...child(
        `const p=Bun.spawn([process.execPath,"-e",${JSON.stringify(descendant)}],{stdout:"inherit",stderr:"inherit"});console.log(p.pid);await Bun.sleep(200);process.exit(0);`,
      ),
      timeoutMs: 5000,
      terminationGraceMs: 30,
    });
    const pid = Number(result.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    const state = await runProcess({
      command: "/bin/ps",
      args: ["-o", "stat=", "-p", String(pid)],
    });
    expect(
      state.stdout.trim() === "" || state.stdout.trim().startsWith("Z"),
    ).toBe(true);
    expect(result.timedOut).toBe(false);
  });
});
