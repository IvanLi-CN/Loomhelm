import type { Ledger } from '../tasks/ledger.js';

export type FlowTaskKind = 'contribution' | 'acceptance' | 'verification' | 'coordination';
export type FlowTaskState = 'pending' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'interrupted' | 'superseded';
export type FlowTerminal = 'merged' | 'passed' | 'completed' | 'failed' | 'blocked' | 'interrupted';

export interface FlowTaskInput {
  id: string;
  kind: FlowTaskKind;
  goal: string;
  dependencies?: string[];
  superseded?: boolean;
}

export interface FlowTask extends FlowTaskInput {
  dependencies: string[];
  state: FlowTaskState;
  attempts: number;
  detail?: string;
  terminal?: FlowTerminal;
}

export interface FlowResult {
  complete: boolean;
  succeeded: boolean;
  active: string[];
  ready: string[];
  running: string[];
  failed: string[];
  blocked: string[];
  superseded: string[];
  terminals: Record<string, FlowTerminal | undefined>;
}

export interface OrchestratorOptions {
  maxRunning?: number;
  /** Optional core Ledger used for durable run.start/run.finish facts. */
  ledger?: Ledger;
}

function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function taskTerminal(kind: FlowTaskKind, terminal: FlowTerminal): boolean {
  if (kind === 'contribution') return terminal === 'merged' || terminal === 'failed' || terminal === 'blocked' || terminal === 'interrupted';
  if (kind === 'acceptance' || kind === 'verification') return terminal === 'passed' || terminal === 'failed' || terminal === 'blocked' || terminal === 'interrupted';
  return terminal === 'completed' || terminal === 'failed' || terminal === 'blocked' || terminal === 'interrupted';
}

export class TaskGraph {
  readonly tasks: Map<string, FlowTask>;
  constructor(inputs: readonly FlowTaskInput[]) {
    if (!Array.isArray(inputs) || inputs.length === 0) throw new Error('At least one flow task is required');
    this.tasks = new Map();
    for (const input of inputs) {
      if (!text(input.id) || !text(input.goal) || !['contribution', 'acceptance', 'verification', 'coordination'].includes(input.kind)) throw new Error('Invalid flow task');
      if (this.tasks.has(input.id)) throw new Error(`Duplicate flow task: ${input.id}`);
      const dependencies = [...(input.dependencies ?? [])];
      if (new Set(dependencies).size !== dependencies.length || dependencies.includes(input.id)) throw new Error(`Invalid dependencies for ${input.id}`);
      this.tasks.set(input.id, { ...input, dependencies, state: input.superseded ? 'superseded' : 'pending', attempts: 0 });
    }
    for (const task of this.tasks.values()) for (const dependency of task.dependencies) if (!this.tasks.has(dependency)) throw new Error(`Unknown dependency: ${dependency}`);
    this.assertAcyclic();
  }

  private assertAcyclic(): void {
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error('Flow task dependencies contain a cycle');
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of this.tasks.get(id)!.dependencies) visit(dependency);
      visiting.delete(id); visited.add(id);
    };
    for (const id of this.tasks.keys()) visit(id);
  }

  snapshot(): FlowTask[] { return structuredClone([...this.tasks.values()]); }
}

/** Capacity bounded, dependency aware scheduler with isolated failure propagation. */
export class TaskOrchestrator {
  readonly graph: TaskGraph;
  readonly maxRunning: number;
  private readonly ledger: Ledger | undefined;

  constructor(tasks: readonly FlowTaskInput[] | TaskGraph, options: OrchestratorOptions = {}) {
    this.graph = tasks instanceof TaskGraph ? tasks : new TaskGraph(tasks);
    this.maxRunning = options.maxRunning ?? 3;
    if (!Number.isSafeInteger(this.maxRunning) || this.maxRunning < 1) throw new Error('maxRunning must be a positive integer');
    this.ledger = options.ledger;
  }

  snapshot(): FlowTask[] { return this.graph.snapshot(); }

  private dependenciesSucceeded(task: FlowTask): boolean {
    return task.dependencies.every(id => ['succeeded', 'superseded'].includes(this.graph.tasks.get(id)!.state));
  }

  private dependencyFailed(task: FlowTask): boolean {
    return task.dependencies.some(id => ['failed', 'blocked', 'interrupted'].includes(this.graph.tasks.get(id)!.state));
  }

  ready(): string[] {
    return [...this.graph.tasks.values()]
      .filter(task => task.state === 'pending' && !task.superseded && this.dependenciesSucceeded(task))
      .map(task => task.id);
  }

  schedule(): string[] {
    for (const task of this.graph.tasks.values()) if (task.state === 'pending' && !task.superseded && this.dependencyFailed(task)) {
      task.state = 'blocked'; task.terminal = 'blocked'; task.detail = 'Dependency failed or was interrupted';
    }
    const slots = Math.max(0, this.maxRunning - this.running().length);
    return this.ready().slice(0, slots);
  }

  running(): string[] { return [...this.graph.tasks.values()].filter(task => task.state === 'running').map(task => task.id); }

  async start(id: string): Promise<FlowTask> {
    const task = this.graph.tasks.get(id);
    if (!task) throw new Error('Flow task not found');
    if (task.state !== 'pending' || task.superseded || !this.dependenciesSucceeded(task)) throw new Error(`Flow task ${id} is not ready`);
    if (this.running().length >= this.maxRunning) throw new Error('Execution capacity exhausted');
    task.state = 'running'; task.attempts += 1; delete task.detail;
    try {
      if (this.ledger) {
        const core = this.ledger.snapshot().tasks[id];
        if (core) await this.ledger.execute(`orchestration.${id}.attempt.${task.attempts}.start`, { type: 'run.start', taskId: id, runId: `orchestration.${id}.${task.attempts}` });
      }
    } catch (error) {
      task.state = 'pending'; task.attempts -= 1;
      throw error;
    }
    return structuredClone(task);
  }

  async finish(id: string, terminal: FlowTerminal, detail = ''): Promise<FlowTask> {
    const task = this.graph.tasks.get(id);
    if (!task) throw new Error('Flow task not found');
    if (task.state !== 'running') throw new Error(`Flow task ${id} is not running`);
    if (!taskTerminal(task.kind, terminal)) throw new Error(`Terminal ${terminal} does not satisfy ${task.kind}`);
    const previous = { state: task.state, terminal: task.terminal, detail: task.detail };
    task.state = terminal === 'merged' || terminal === 'passed' || terminal === 'completed' ? 'succeeded' : terminal;
    task.terminal = terminal; if (detail) task.detail = detail; else delete task.detail;
    try {
      if (this.ledger) {
        const core = this.ledger.snapshot().tasks[id];
        if (core) await this.ledger.execute(`orchestration.${id}.attempt.${task.attempts}.finish`, { type: 'run.finish', runId: `orchestration.${id}.${task.attempts}`, status: task.state === 'succeeded' ? 'succeeded' : task.state === 'interrupted' ? 'interrupted' : task.state === 'blocked' ? 'blocked' : 'failed', detail: detail || terminal });
      }
    } catch (error) {
      task.state = previous.state;
      if (previous.terminal) task.terminal = previous.terminal; else delete task.terminal;
      if (previous.detail) task.detail = previous.detail; else delete task.detail;
      throw error;
    }
    return structuredClone(task);
  }

  /** Recover interrupted in-memory work after a process restart; callers choose when to retry. */
  recover(): string[] {
    const recovered: string[] = [];
    for (const task of this.graph.tasks.values()) if (task.state === 'running' || task.state === 'interrupted') {
      task.state = 'pending'; task.detail = 'Recovered after interrupted scheduler'; recovered.push(task.id);
    }
    return recovered;
  }

  result(): FlowResult {
    const tasks = [...this.graph.tasks.values()];
    const active = tasks.filter(task => !task.superseded);
    const ready = this.ready();
    const running = this.running();
    const failed = active.filter(task => task.state === 'failed').map(task => task.id);
    const blocked = active.filter(task => task.state === 'blocked' || task.state === 'interrupted').map(task => task.id);
    const superseded = tasks.filter(task => task.superseded || task.state === 'superseded').map(task => task.id);
    const complete = active.every(task => ['succeeded', 'failed', 'blocked', 'interrupted'].includes(task.state));
    return { complete, succeeded: complete && failed.length === 0 && blocked.length === 0, active: active.map(task => task.id), ready, running, failed, blocked, superseded, terminals: Object.fromEntries(tasks.map(task => [task.id, task.terminal])) };
  }
}
