import { expect, test } from 'bun:test';
import { runFlowProcess } from '../src/runtime/flow-process.ts';
import { runProcess } from '../src/runtime/process.ts';

const producer = `
const chunk = Buffer.alloc(64 * 1024, 97);
for (let i = 0; i < Number(process.argv[1]); i++) {
  await new Promise((resolve, reject) => process.stdout.write(chunk, error => error ? reject(error) : resolve()));
}
`;

test('Flow forwards 80 MiB to a slow consumer without retaining the response', async () => {
  let bytes = 0;
  let parentPeak = process.memoryUsage().rss;
  const start = parentPeak;
  const result = await runFlowProcess(process.execPath, ['-e', producer, '1280'], {
    timeoutMs: 20_000,
    outputSink: async (_stream, chunk) => {
      bytes += chunk.byteLength;
      parentPeak = Math.max(parentPeak, process.memoryUsage().rss);
      await Bun.sleep(1);
    },
  });
  expect(bytes).toBe(80 * 1024 * 1024);
  expect(result.stdout).toBe('');
  expect(result.code).toBe(0);
  // This is a bounded regression guard; the exact packaged-process RSS acceptance is separate.
  expect(parentPeak - start).toBeLessThan(64 * 1024 * 1024);
}, 25_000);

const cooperative = `
process.on('message', message => {
  if (message.type === 'stop' && message.invocation_id === process.env.LOOMHELM_INVOCATION_ID) {
    process.send({ type: 'stopped', invocation_id: message.invocation_id });
    process.disconnect();
    process.exit(0);
  }
});
console.log('x'.repeat(8192));
setInterval(() => {}, 1000);
`;
test('explicit combined budget and failed delivery cooperatively stop exactly once', async () => {
  await expect(runFlowProcess(process.execPath, ['-e', cooperative], {
    timeoutMs: 1000, maxOutputBytes: 1, outputSink: async () => {},
  })).rejects.toThrow('output limit');
  let calls = 0;
  await expect(runFlowProcess(process.execPath, ['-e', cooperative], {
    timeoutMs: 1000, outputSink: async () => { calls++; throw new Error('EPIPE'); },
  })).rejects.toThrow('EPIPE');
  expect(calls).toBe(1);
});

test('generic captured executor keeps the 1 MiB default', async () => {
  await expect(runProcess(process.execPath, ['-e', producer, '32'])).rejects.toThrow('output limit');
});


test('Flow streams large stderr and counts both streams against an explicit budget', async () => {
  const program = `
    process.on('message', message => {
      if (message.type === 'stop' && message.invocation_id === process.env.LOOMHELM_INVOCATION_ID) {
        process.send({type:'stopped',invocation_id:message.invocation_id});
        process.disconnect();process.exit(0);
      }
    });
    const chunk = Buffer.alloc(64 * 1024, 97);
    for (let i=0;i<32;i++) {
      await new Promise((resolve,reject)=>process.stderr.write(chunk,error=>error?reject(error):resolve()));
    }
    await new Promise((resolve,reject)=>process.stdout.write(chunk,error=>error?reject(error):resolve()));
    process.disconnect();
  `;
  let stderrBytes=0, stdoutBytes=0;
  const sink=async (stream: 'stdout' | 'stderr', chunk: Uint8Array) => {
    if(stream==='stderr') stderrBytes+=chunk.length;else stdoutBytes+=chunk.length;
  };
  const result=await runFlowProcess(process.execPath,['-e',program],{timeoutMs:5000,outputSink:sink});
  expect(result.code).toBe(0);
  expect(stderrBytes).toBe(2*1024*1024);
  expect(stdoutBytes).toBe(64*1024);
  await expect(runFlowProcess(process.execPath,['-e',program],{
    timeoutMs:5000,maxOutputBytes:2*1024*1024,outputSink:async()=>{},
  })).rejects.toThrow('output limit');
});

test('Flow timeout uses the same independent cooperative stop channel', async () => {
  await expect(runFlowProcess(process.execPath,['-e',cooperative],{
    timeoutMs:100,outputSink:async()=>{},
  })).rejects.toThrow('timed out');
});
