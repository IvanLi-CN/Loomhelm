export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'interrupted' | 'cancelled' | 'skipped';
export interface TaskInput { id: string; goal: string; scope: string; acceptance: string; dependencies: string[]; repository?: string }
export interface Task extends TaskInput { status: TaskStatus; runIds: string[] }
export interface Run { id: string; taskId: string; attempt: number; status: TaskStatus; startedAt: string; endedAt?: string; detail?: string }
export interface TaskState { tasks: Record<string, Task>; runs: Record<string, Run> }
export type Operation =
  | { type: 'task.create'; task: TaskInput }
  | { type: 'run.start'; taskId: string; runId: string; command?: string[] }
  | { type: 'run.finish'; runId: string; status: 'succeeded' | 'failed' | 'blocked' | 'interrupted'; detail: string }
  | { type: 'task.stop'; taskId: string; status: 'cancelled' | 'skipped'; detail: string };
export const emptyState = (): TaskState => ({ tasks: Object.create(null), runs: Object.create(null) });
export function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error('Invalid identity');
}
function content(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Nonempty text required');
}
export function applyOperation(state: TaskState, operation: Operation, at: string): void {
  if (!operation || typeof operation !== 'object') throw new Error('Invalid operation');
  switch (operation.type) {
    case 'task.create': {
      const task = operation.task;
      identifier(task.id); content(task.goal); content(task.scope); content(task.acceptance);
      if (task.repository !== undefined) content(task.repository);
      if (state.tasks[task.id]) throw new Error('Task already exists');
      if (!Array.isArray(task.dependencies) || new Set(task.dependencies).size !== task.dependencies.length) throw new Error('Invalid dependencies');
      for (const id of task.dependencies) { identifier(id); if (id === task.id || !state.tasks[id]) throw new Error('Dependency must already exist'); }
      state.tasks[task.id] = { ...task, status: 'pending', runIds: [] };
      return;
    }
    case 'run.start': {
      identifier(operation.taskId); identifier(operation.runId);
      if (operation.command !== undefined && (!Array.isArray(operation.command) || operation.command.length === 0 || operation.command.some(arg => typeof arg !== 'string') || !operation.command[0])) throw new Error('Invalid command');
      const task = state.tasks[operation.taskId];
      if (!task || !['pending', 'failed', 'blocked', 'interrupted'].includes(task.status)) throw new Error('Task cannot start');
      if (state.runs[operation.runId]) throw new Error('Run already exists');
      if (task.dependencies.some(id => state.tasks[id]?.status !== 'succeeded')) throw new Error('Dependencies not satisfied');
      const run: Run = { id: operation.runId, taskId: task.id, attempt: task.runIds.length + 1, status: 'running', startedAt: at };
      state.runs[run.id] = run; task.runIds.push(run.id); task.status = 'running'; return;
    }
    case 'run.finish': {
      identifier(operation.runId); content(operation.detail);
      if (!['succeeded', 'failed', 'blocked', 'interrupted'].includes(operation.status)) throw new Error('Invalid run outcome');
      const run = state.runs[operation.runId];
      if (!run || run.status !== 'running') throw new Error('Run is not active');
      run.status = operation.status; run.endedAt = at; run.detail = operation.detail;
      state.tasks[run.taskId]!.status = operation.status; return;
    }
    case 'task.stop': {
      identifier(operation.taskId); content(operation.detail);
      if (!['cancelled', 'skipped'].includes(operation.status)) throw new Error('Invalid stop status');
      const task = state.tasks[operation.taskId];
      if (!task || ['running', 'succeeded', 'cancelled', 'skipped'].includes(task.status)) throw new Error('Task cannot stop');
      task.status = operation.status; return;
    }
    default: throw new Error('Unknown operation');
  }
}
