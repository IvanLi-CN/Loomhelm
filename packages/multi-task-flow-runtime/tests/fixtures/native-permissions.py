"""Disposable native configuration acceptance; no host credentials or authenticated model calls."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time


class Native:
    def __init__(self, env):
        self.process = subprocess.Popen(
            ["codex", "app-server", "--disable", "daemon_auto_start"], env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
        )
        self.rows = queue.Queue()
        self.sequence = 0
        self.events = []
        threading.Thread(target=lambda: [self.rows.put(json.loads(line)) for line in self.process.stdout], daemon=True).start()
        self.rpc("initialize", {"clientInfo": {"name": "loomhelm-permission-acceptance", "version": "1"}, "capabilities": {"experimentalApi": True}})
        self.process.stdin.write('{"method":"initialized","params":{}}\n')
        self.process.stdin.flush()

    def rpc(self, method, params):
        self.sequence += 1
        self.process.stdin.write(json.dumps({"id": self.sequence, "method": method, "params": params}) + "\n")
        self.process.stdin.flush()
        while True:
            row = self.rows.get(timeout=10)
            if row.get("method"):
                self.events.append(row)
            if row.get("id") == self.sequence:
                if row.get("error"):
                    raise RuntimeError(row["error"])
                return row["result"]

    def wait_completed(self, turn_id):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            for row in self.events:
                turn = row.get("params", {}).get("turn", {})
                if row.get("method") == "turn/completed" and turn.get("id") == turn_id:
                    assert turn.get("status") == "completed", turn
                    return
            self.events.append(self.rows.get(timeout=10))
        raise TimeoutError("native turn did not complete")

    def close(self):
        self.process.terminate()
        self.process.wait(timeout=5)


class ModelFixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        item = {"type": "message", "id": "msg_fixture", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "READY", "annotations": []}]}
        events = [
            {"type": "response.created", "response": {"id": "resp_fixture", "status": "in_progress", "output": []}},
            {"type": "response.output_item.done", "output_index": 0, "item": item},
            {"type": "response.completed", "response": {"id": "resp_fixture", "status": "completed", "output": [item]}},
        ]
        body = "".join("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n" for event in events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


model_server = ThreadingHTTPServer(("127.0.0.1", 0), ModelFixture)
threading.Thread(target=model_server.serve_forever, daemon=True).start()

with tempfile.TemporaryDirectory(prefix="loomhelm-native-permissions-") as directory:
    root = Path(directory)
    (root / "config.toml").write_text('sandbox_mode = "read-only"\napproval_policy = "never"\nmodel_provider = "acceptance"\n[model_providers.acceptance]\nname = "Local deterministic acceptance fixture"\nwire_api = "responses"\nrequires_openai_auth = false\nbase_url = "http://127.0.0.1:' + str(model_server.server_port) + '/v1"\n')
    env = {**{key: value for key, value in os.environ.items() if key in ["PATH", "HOME", "TMPDIR", "LANG"]}, "CODEX_HOME": directory, "MULTI_TASK_FLOW_CODEX_CREATE_TIMEOUT_MS": "30000"}
    native = Native(env)
    try:
        thread_id = native.rpc("thread/start", {"cwd": directory, "sandbox": "danger-full-access", "approvalPolicy": "never"})["thread"]["id"]
        turn = native.rpc("turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": "READY"}]})
        native.wait_completed(turn["turn"]["id"])
    finally:
        native.close()
    module = str(Path(__file__).resolve().parents[2] / "lib/codex-recovery-writer.ts")
    script = '''import {withRecoveryWriter} from MODULE;import {writeFileSync,existsSync} from "node:fs";
const t=process.argv[1],root=process.env.CODEX_HOME;
await withRecoveryWriter({attempt_id:"native-probe",thread_id:t,workspace_path:root,permissions:{version:1}},async(rpc,restore)=>{
console.log("LOCKED");while(!existsSync(root+"/release"))await new Promise(r=>setTimeout(r,20));
await rpc("turn/start",{threadId:t,input:[{type:"text",text:"READY"}]});
for(let i=0;i<50;i++){const r=await rpc("thread/read",{threadId:t,includeTurns:false});if(r.thread.status.type!=="active")break;await new Promise(r=>setTimeout(r,20));}
await restore();},{restrict:true,capture:p=>writeFileSync(root+"/original.json",JSON.stringify(p))});console.log("RESTORED");'''.replace("MODULE", json.dumps(module))
    writer = subprocess.Popen(["bun", "-e", script, thread_id], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        first = writer.stdout.readline().strip()
        if first != "LOCKED":
            raise RuntimeError(first + writer.stderr.read())
        contender = Native(env)
        try:
            try:
                contender.rpc("thread/resume", {"threadId": thread_id, "excludeTurns": True})
            except RuntimeError as error:
                # Exact native rejection is retained; arbitrary RPC errors must not count as exclusion.
                assert "already has an active writer" in str(error), error
                print("writer exclusion:", str(error))
            else:
                raise AssertionError("second native writer acquired an already-held thread")
        finally:
            contender.close()
        (root / "release").touch()
        stdout, stderr = writer.communicate(timeout=30)
        assert writer.returncode == 0, stdout + stderr
        assert "RESTORED" in stdout, stdout
    finally:
        if writer.poll() is None:
            writer.terminate()
            writer.wait(timeout=5)
    native = Native(env)
    try:
        resumed = native.rpc("thread/resume", {"threadId": thread_id, "excludeTurns": True})
        assert resumed["sandbox"] == {"type": "dangerFullAccess"}, resumed["sandbox"]
        for _ in range(2):
            turn = native.rpc("turn/start", {"threadId": thread_id, "input": [{"type": "text", "text": "formal permission context probe"}]})
            native.wait_completed(turn["turn"]["id"])
        contexts = [row["payload"]["sandbox_policy"]["type"] for path in (root / "sessions").rglob("*.jsonl") for row in map(json.loads, path.read_text().splitlines()) if row.get("type") == "turn_context"]
        assert contexts[-2:] == ["danger-full-access", "danger-full-access"], contexts
        assert "read-only" in contexts, contexts
        print(json.dumps({"result": "native-settings-and-writer-exclusion-passed", "native_version": "0.169.0", "cold_resume": resumed["sandbox"], "turn_context_policies": contexts, "limits": "Local deterministic model fixture; native settings, completed turns, cold resume and writer exclusion verified. No external model, OS sandbox probe or Desktop control exercised"}))
    finally:
        native.close()

model_server.shutdown()
model_server.server_close()
