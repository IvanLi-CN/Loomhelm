import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { statSync } from 'node:fs';
import { constants } from 'node:os';

type Options = { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean; stdin?: 'ignore' | 'pipe' | 'inherit' | Blob; stdout?: 'pipe' | 'inherit' | 'ignore'; stderr?: 'pipe' | 'inherit' | 'ignore'; stdio?: unknown[]; timeout?: number };
function spawn(argv: string[], options: Options = {}) {
  const input = options.stdio?.[0] ?? options.stdin ?? 'ignore';
  const stdio = options.stdio
    ? options.stdio.map((value,index) => index===0 && value instanceof Blob ? 'pipe' : value)
    : [input instanceof Blob ? 'pipe' : input, options.stdout ?? 'pipe', options.stderr ?? 'pipe'];
  const child = nodeSpawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env, detached: options.detached, stdio: stdio as never });
  const exited = new Promise<number>((resolve,reject) => {
    child.once('error',reject);
    child.once('exit',(code,signal)=>resolve(code ?? 128+(signal ? constants.signals[signal] : 0)));
  });
  if (input instanceof Blob) {
    child.stdin?.on('error',()=>{});
    void input.arrayBuffer().then(bytes=>child.stdin?.end(Buffer.from(bytes)));
  }
  return { pid: child.pid!, stdout: child.stdout ? Readable.toWeb(child.stdout) : null, stderr: child.stderr ? Readable.toWeb(child.stderr) : null, exited, kill: (signal: NodeJS.Signals = 'SIGTERM')=>child.kill(signal) };
}
function spawnSync(argv: string[], options: Options = {}) {
  const result = nodeSpawnSync(argv[0]!,argv.slice(1), { cwd:options.cwd,env:options.env,timeout:options.timeout,stdio:[options.stdin==='inherit'?'inherit':'ignore',options.stdout ?? 'pipe',options.stderr ?? 'pipe'],maxBuffer:64*1024*1024 });
  if(result.error) throw result.error;
  return { stdout:result.stdout ?? Buffer.alloc(0),stderr:result.stderr ?? Buffer.alloc(0),exitCode:result.status ?? 128,success:result.status===0 };
}
type Viewer = { port: number; timeout(request: Request, seconds: number): void; stop(force?: boolean): Promise<void> };
async function serve(options: { hostname: string; port: number; fetch(request: Request,server: Viewer): Response | Promise<Response> }): Promise<Viewer> {
  const responses = new WeakMap<Request, import('node:http').ServerResponse>();
  const server = createServer(async (incoming,outgoing)=>{
    const abort = new AbortController();
    outgoing.once('close',()=>abort.abort());
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const headers = new Headers();
      for(let i=0;i<incoming.rawHeaders.length;i+=2) headers.append(incoming.rawHeaders[i]!,incoming.rawHeaders[i+1]!);
      const request = new Request(`http://${options.hostname}:${viewer.port}${incoming.url}`, { method:incoming.method,headers,signal:abort.signal,...(['GET','HEAD'].includes(incoming.method ?? 'GET') ? {} : { body:Readable.toWeb(incoming),duplex:'half' }) } as RequestInit);
      responses.set(request,outgoing);
      const response=await options.fetch(request,viewer);
      outgoing.statusCode=response.status;
      for(const [key,value] of response.headers) if(key!=='set-cookie') outgoing.setHeader(key,value);
      const cookies=response.headers.getSetCookie();
      if(cookies.length) outgoing.setHeader('set-cookie',cookies);
      if(!response.body || incoming.method==='HEAD') { outgoing.end(); return; }
      reader=response.body.getReader();
      const cancel=()=>{void reader?.cancel().catch(()=>{});};
      abort.signal.addEventListener('abort',cancel,{once:true});
      try {
        while(!abort.signal.aborted) {
          const {done,value}=await reader.read(); if(done) break;
          if(!outgoing.write(value)) await new Promise<void>(resolve=>{
            const finish=()=>{outgoing.off('drain',finish);outgoing.off('close',finish);resolve();};
            outgoing.once('drain',finish);outgoing.once('close',finish);
          });
        }
        outgoing.end();
      } finally { abort.signal.removeEventListener('abort',cancel); }
    } catch(error) {
      if(!outgoing.headersSent) {outgoing.statusCode=500;outgoing.end('Internal server error');}
      else outgoing.destroy(error instanceof Error?error:undefined);
    } finally { reader?.releaseLock(); }
  });
  const viewer: Viewer = {
    port:options.port,
    timeout(request,seconds) { responses.get(request)?.setTimeout(seconds*1000); },
    async stop(force=false) {
      if(force) server.closeAllConnections();
      await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    },
  };
  await new Promise<void>((resolve,reject)=>{
    server.once('error',reject);
    server.listen(options.port,options.hostname,()=>{server.off('error',reject);resolve();});
  });
  const address=server.address();
  if(!address || typeof address==='string') throw new Error('HTTP listener address unavailable');
  viewer.port=address.port;
  return viewer;
}
export const Runtime = {
  spawn,spawnSync,serve,
  stdin: { stream:()=>Readable.toWeb(process.stdin), text:async()=>new Response(Readable.toWeb(process.stdin) as ReadableStream).text() },
  sleep:(milliseconds:number)=>new Promise<void>(resolve=>setTimeout(resolve,milliseconds)),
  file:(path:string)=>({ get size(){ try{return statSync(path).size;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 0;throw error;} } }),
};
