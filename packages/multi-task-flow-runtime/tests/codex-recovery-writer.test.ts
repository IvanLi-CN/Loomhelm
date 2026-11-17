import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const fixture = `#!/usr/bin/env bun
import {writeFileSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('codex-cli 0.169.0');process.exit(0);}
const endpoint=process.argv.at(-1);if(!endpoint.startsWith('unix://'))throw new Error('private socket required');
writeFileSync(process.env.PROBE_SOCKET,endpoint.slice(7));
Bun.serve({unix:endpoint.slice(7),fetch(req,server){if(server.upgrade(req))return;return new Response('no',{status:400});},websocket:{message(ws,text){const row=JSON.parse(String(text));if(!row.id)return;const send=result=>ws.send(JSON.stringify({id:row.id,result}));if(row.method==='initialize')return send({userAgent:'Codex Desktop/0.169.0 (fixture)'});if(row.method==='thread/resume'){if(row.params.threadId!=='test-thread'||row.params.sandbox!=='read-only')throw new Error('bad resume');return send({thread:{id:'test-thread'}});}if(row.method==='probe'){if(process.env.PROBE_MODE==='hang')return;if(process.env.PROBE_MODE==='work')ws.send(JSON.stringify({method:'item/started',params:{item:{type:'commandExecution'}}}));if(process.env.PROBE_MODE==='approval')ws.send(JSON.stringify({id:1234,method:'item/commandExecution/requestApproval',params:{}}));return send({ok:true});}}}});
`;
for (const mode of ["success", "work", "approval", "hang"])
  test(`private writer ${mode} joins and removes only its owned socket`, () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "writer-test-")));
    try {
      const command = join(directory, "codex");
      writeFileSync(command, fixture);
      chmodSync(command, 0o700);
      const marker = join(directory, "socket.txt");
      const module = resolve(import.meta.dir, "../lib/codex-recovery-writer.ts");
      const script = `import {withRecoveryWriter} from ${JSON.stringify(module)};try{const result=await withRecoveryWriter({attempt_id:'test-attempt',thread_id:'test-thread',workspace_path:${JSON.stringify(directory)},execution_profile:{model:'test',thinking:'medium'}},async rpc=>{const r=await rpc('probe',{});await new Promise(r=>setTimeout(r,20));return r;});console.log(JSON.stringify(result));}catch(e){console.error(String(e));process.exitCode=1;}`;
      const result = spawnSync(process.execPath, ["-e", script], {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          PROBE_MODE: mode,
          PROBE_SOCKET: marker,
          MULTI_TASK_FLOW_CODEX_CREATE_TIMEOUT_MS: "1000",
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(mode === "success" ? 0 : 1);
      if (mode === "work") expect(result.stderr).toContain("attempted work");
      if (mode === "approval") expect(result.stderr).toContain("tool or approval");
      if (mode === "hang") expect(result.stderr).toMatch(/deadline|timed out/);
      const socket = readFileSync(marker, "utf8");
      expect(() => readFileSync(socket)).toThrow();
      expect(existsSync(dirname(socket))).toBe(false);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
