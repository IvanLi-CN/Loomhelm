import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { atomicWrite } from '../runtime/files.js';
import { StateLock } from '../runtime/lock.js';
import { TaskGraph, TaskOrchestrator, type FlowTaskInput, type FlowTerminal } from '../orchestration/index.js';

const terminals = new Set<FlowTerminal>(['merged', 'passed', 'completed', 'failed', 'blocked', 'interrupted']);

async function initializeTasks(directory: string, encoded: string): Promise<FlowTaskInput[]> {
  const value: unknown = JSON.parse(encoded);
  if (!Array.isArray(value)) throw new Error('Flow task definition must be a JSON array');
  const graph = new TaskGraph(value as FlowTaskInput[]);
  const tasks = graph.snapshot().map(({ id, kind, goal, dependencies, superseded }) => ({ id, kind, goal, dependencies, ...(superseded ? { superseded } : {}) }));
  await new (class {
    async save() {
      const lock = await StateLock.acquire(directory);
      try {
        const path = join(directory, 'tasks.json');
        try {
          const old = JSON.parse(await readFile(path, 'utf8')) as { schemaVersion: number; tasks: FlowTaskInput[] };
          if (old.schemaVersion !== 1 || JSON.stringify(old.tasks) !== JSON.stringify(tasks)) throw new Error('Flow task graph already exists with different contents');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await atomicWrite(path, { schemaVersion: 1, tasks });
        }
      } finally { await lock.release(); }
    }
  })().save();
  return tasks;
}

async function loadTasks(directory: string): Promise<FlowTaskInput[]> {
  const value = JSON.parse(await readFile(join(directory, 'tasks.json'), 'utf8')) as { schemaVersion: number; tasks: FlowTaskInput[] };
  if (value.schemaVersion !== 1 || !Array.isArray(value.tasks)) throw new Error('Invalid persisted flow task graph');
  return value.tasks;
}

export async function runFlowCommand(args: string[], configPath?: string): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === 'help') {
    console.log('flow init TASKS_JSON | status | schedule | start TASK_ID | finish TASK_ID TERMINAL [DETAIL] | recover'); return;
  }
  const config = await loadConfig(configPath);
  const stateDir = join(config.stateDir, 'task-flow');
  if (command === 'init' && rest.length === 1) await initializeTasks(stateDir, rest[0]!);
  else if (command !== 'status' && command !== 'schedule' && command !== 'start' && command !== 'finish' && command !== 'recover') throw new Error('Invalid flow command; see help');
  const inputs = await loadTasks(stateDir);
  const scheduler = await TaskOrchestrator.open(inputs, { stateDir: join(stateDir, 'journal') });
  if (command === 'init' && rest.length === 1) {
    scheduler.schedule();
    console.log(JSON.stringify({ initialized: true, tasks: scheduler.snapshot(), result: scheduler.result() })); return;
  }
  if (command === 'status' && rest.length === 0) {
    const scheduled = scheduler.schedule();
    console.log(JSON.stringify({ scheduled, tasks: scheduler.snapshot(), result: scheduler.result() })); return;
  }
  if (command === 'schedule' && rest.length === 0) {
    const scheduled = scheduler.schedule();
    console.log(JSON.stringify({ scheduled, tasks: scheduler.snapshot(), result: scheduler.result() })); return;
  }
  if (command === 'start' && rest.length === 1) {
    const task = await scheduler.start(rest[0]!);
    const scheduled = scheduler.schedule();
    console.log(JSON.stringify({ task, scheduled, tasks: scheduler.snapshot(), result: scheduler.result() })); return;
  }
  if (command === 'finish' && rest.length >= 2 && rest.length <= 3) {
    if (!terminals.has(rest[1] as FlowTerminal)) throw new Error('Invalid flow terminal state');
    const task = await scheduler.finish(rest[0]!, rest[1] as FlowTerminal, rest[2] ?? '');
    const scheduled = scheduler.schedule();
    console.log(JSON.stringify({ task, scheduled, tasks: scheduler.snapshot(), result: scheduler.result() })); return;
  }
  if (command === 'recover' && rest.length === 0) {
    const recovered = await scheduler.recoverPersisted();
    const scheduled = scheduler.schedule();
    console.log(JSON.stringify({ recovered, scheduled, tasks: scheduler.snapshot(), result: scheduler.result() })); return;
  }
  throw new Error('Invalid flow command; see help');
}
