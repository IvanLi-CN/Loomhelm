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
import {writeFileSync,symlinkSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('codex-cli 0.169.0');process.exit(0);}
const endpoint=process.argv.at(-1);if(!endpoint.startsWith('unix://'))throw new Error('private socket required');
writeFileSync(process.env.PROBE_SOCKET,endpoint.slice(7));
if(process.env.PROBE_MODE==='redirect'){symlinkSync(process.env.PROBE_SOCKET,endpoint.slice(7));await new Promise(r=>setTimeout(r,10000));process.exit(0);}
let policy={sandboxPolicy:process.env.PROBE_MODE==='reentry'?{type:'readOnly',networkAccess:false}:process.env.PROBE_MODE==='conflict'?{type:'workspaceWrite',writableRoots:['/other'],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}:{type:'dangerFullAccess'},approvalPolicy:process.env.PROBE_MODE==='reentry'?'never':'on-request',approvalsReviewer:'user'};
Bun.serve({unix:endpoint.slice(7),fetch(req,server){if(server.upgrade(req))return;return new Response('no',{status:400});},websocket:{message(ws,text){const row=JSON.parse(String(text));if(!row.id)return;const send=result=>ws.send(JSON.stringify({id:row.id,result}));if(row.method==='initialize')return send({userAgent:'Codex Desktop/0.169.0 (fixture)'});if(row.method==='thread/resume'){if(row.params.threadId!=='test-thread'||Object.keys(row.params).some(k=>!['threadId','excludeTurns'].includes(k)))throw new Error('mutating resume');return send({thread:{id:'test-thread'},sandbox:policy.sandboxPolicy,approvalPolicy:policy.approvalPolicy,approvalsReviewer:policy.approvalsReviewer,activePermissionProfile:process.env.PROBE_MODE==='named'?{id:'managed'}:null});}if(row.method==='thread/settings/update'){if(process.env.PROBE_MODE==='restorefail'&&row.params.sandboxPolicy.type==='dangerFullAccess')return ws.send(JSON.stringify({id:row.id,error:{message:'restore rejected'}}));policy={sandboxPolicy:row.params.sandboxPolicy,approvalPolicy:row.params.approvalPolicy,approvalsReviewer:row.params.approvalsReviewer};writeFileSync(process.env.PROBE_SOCKET+'.policy',JSON.stringify(policy));if(process.env.PROBE_MODE!=='no-settings')ws.send(JSON.stringify({method:'thread/settings/updated',params:{threadId:'test-thread',threadSettings:{...policy,activePermissionProfile:process.env.PROBE_MODE==='named'?{id:'managed'}:null}}}));return send({});}if(row.method==='turn/start')return send({turn:{id:'recovered-turn',status:'inProgress'}});if(row.method==='thread/turns/list'){if(process.env.PROBE_MODE==='rpc-error')return ws.send(JSON.stringify({id:row.id,error:{message:'history unavailable'}}));return send({data:[{id:'recovered-turn',status:'completed'}]});}if(row.method==='probe'){if(process.env.PROBE_MODE==='exit'){send({ok:true});setTimeout(()=>process.exit(0),20);return;}if(process.env.PROBE_MODE==='hang')return;if(process.env.PROBE_MODE==='work')ws.send(JSON.stringify({method:'item/started',params:{item:{type:'commandExecution'}}}));if(process.env.PROBE_MODE==='approval')ws.send(JSON.stringify({id:1234,method:'item/commandExecution/requestApproval',params:{}}));return send({ok:true});}}}});
`;
for (const mode of [
  "success",
  "work",
  "approval",
  "hang",
  "signal",
  "exit",
  "capturefail",
  "restorefail",
  "reentry",
  "conflict",
  "named",
  "no-settings",
  "redirect",
])
  test(`private writer ${mode} joins and removes only its owned socket`, () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "writer-test-")));
    try {
      const command = join(directory, "codex");
      writeFileSync(command, fixture);
      chmodSync(command, 0o700);
      const marker = join(directory, "socket.txt");
      const module = resolve(import.meta.dir, "../lib/codex-recovery-writer.ts");
      const script = `import {withRecoveryWriter} from ${JSON.stringify(module)};try{const result=await withRecoveryWriter({attempt_id:'test-attempt',thread_id:'test-thread',workspace_path:${JSON.stringify(directory)},execution_profile:{model:'test',thinking:'medium'},permissions:{version:1,...(['reentry','conflict'].includes(process.env.PROBE_MODE)?{original:{sandboxPolicy:{type:'dangerFullAccess'},approvalPolicy:'on-request',approvalsReviewer:'user'}}:{})}},async (rpc,restore)=>{const r=await rpc('probe',{});if(process.env.PROBE_MODE==='signal')setTimeout(()=>process.kill(process.pid,'SIGTERM'),20);if(['signal','exit'].includes(process.env.PROBE_MODE)){await new Promise(r=>setTimeout(r,3000));await rpc('probe',{});console.log('LATE_COMMIT');}await new Promise(r=>setTimeout(r,20));await restore();return r;},{restrict:process.env.PROBE_MODE!=='reentry',capture:p=>{if(process.env.PROBE_MODE==='capturefail')throw new Error('capture failed');if(p.sandboxPolicy.type!=='dangerFullAccess')throw new Error('lost original');}});console.log(JSON.stringify(result));}catch(e){console.error(String(e));process.exitCode=1;}`;
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
      if (mode === "signal") expect(result.signal).toBe("SIGTERM");
      else expect(result.status).toBe(["success", "reentry"].includes(mode) ? 0 : 1);
      expect(result.stdout).not.toContain("LATE_COMMIT");
      if (["success", "reentry"].includes(mode))
        expect(JSON.parse(readFileSync(marker + ".policy", "utf8"))).toEqual({
          sandboxPolicy: { type: "dangerFullAccess" },
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
        });
      if (mode === "redirect") expect(result.stderr).toContain("shared daemon redirect");
      if (mode === "work") expect(result.stderr).toContain("attempted work");
      if (mode === "approval") expect(result.stderr).toContain("tool or approval");
      if (mode === "hang") expect(result.stderr).toMatch(/deadline|timed out/);
      if (["capturefail", "conflict", "named"].includes(mode))
        expect(existsSync(marker + ".policy")).toBe(false);
      if (mode === "restorefail") {
        expect(result.stderr).toContain("restore rejected");
        expect(result.stdout).not.toContain('"ok":true');
        expect(JSON.parse(readFileSync(marker + ".policy", "utf8")).sandboxPolicy.type).toBe(
          "readOnly",
        );
      }
      const socket = readFileSync(marker, "utf8");
      expect(() => readFileSync(socket)).toThrow();
      expect(existsSync(dirname(socket))).toBe(false);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

for (const mode of ["observe-error", "rpc-error", "wrong-terminal", "terminal"])
  test(`recovery writer ${mode} requires exact provider terminal proof for invocation stop`, () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "writer-proof-")));
    try {
      writeFileSync(join(directory, "codex"), fixture);
      chmodSync(join(directory, "codex"), 0o700);
      const module = resolve(import.meta.dir, "../lib/codex-recovery-writer.ts");
      const journal = resolve(import.meta.dir, "../lib/invocation-journal.ts");
      const fixtures = resolve(import.meta.dir, "./service-fixture.ts");
      const script = `
        import {withRecoveryWriter} from ${JSON.stringify(module)};
        import {executeInvocation,inspectInvocation} from ${JSON.stringify(journal)};
        import {serviceFixture,fixtureRun} from ${JSON.stringify(fixtures)};
        const {state}=serviceFixture();const {store}=fixtureRun(state.paths.data,'writer-proof',3);
        process.env.LOOMHELM_CALLER_IDENTITY=JSON.stringify({package_name:'@loomhelm/multi-task-flow',package_version:'0.4.0',build_id:'b'.repeat(64),source_sha:'b'.repeat(40),compatibility_line:'compat-v1',ledger_contract:5,api_contract:1,frontend_contract:1,viewer_contract:5});
        let error;
        try{await executeInvocation(store,'writer-proof',{},()=>withRecoveryWriter(
          {attempt_id:'test-attempt',thread_id:'test-thread',recovery_turn_id:'recovered-turn',workspace_path:${JSON.stringify(directory)},execution_profile:{model:'test',thinking:'medium'},permissions:{version:1}},
          async(rpc,restore,confirmTerminalTurn)=>{
            const started=await rpc('turn/start',{threadId:'test-thread'});
            if(process.env.PROBE_MODE==='observe-error')throw new Error('observe write failed');
            const history=await rpc('thread/turns/list',{threadId:'test-thread'});
            if(history.data[0].id!==started.turn.id||history.data[0].status!=='completed')throw new Error('missing provider terminal');
            confirmTerminalTurn(process.env.PROBE_MODE==='wrong-terminal'?'foreign-turn':history.data[0].id);
            await restore();
          },{restrict:true,capture:()=>{}}));}catch(e){error=String(e);}
        console.log(JSON.stringify({error,inspection:inspectInvocation(store)}));
      `;
      const result = spawnSync(process.execPath, ["-e", script], {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          PROBE_MODE: mode,
          PROBE_SOCKET: join(directory, "socket.txt"),
          MULTI_TASK_FLOW_CODEX_CREATE_TIMEOUT_MS: "5000",
        },
        encoding: "utf8",
        timeout: 15000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.inspection.quiescent).toBe(mode === "terminal");
      expect(output.inspection.state).toBe(mode === "terminal" ? "stopped" : "running");
      if (mode !== "terminal") expect(output.error).toBeString();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
