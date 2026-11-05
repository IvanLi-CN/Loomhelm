import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export interface ClientConfig { schemaVersion: 1; mode: 'local'; stateDir: string; processTimeoutMs: number }
export async function loadConfig(path?: string): Promise<ClientConfig> {
  const base = path ? dirname(resolve(path)) : process.cwd();
  const raw: unknown = path ? JSON.parse(await readFile(path, 'utf8')) : {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid client config');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(k => !['schemaVersion', 'mode', 'stateDir', 'processTimeoutMs'].includes(k))) throw new Error('Unknown config field');
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) throw new Error('Unsupported config version');
  if (value.mode !== undefined && value.mode !== 'local') throw new Error('Only local mode is implemented');
  if (value.stateDir !== undefined && (typeof value.stateDir !== 'string' || !value.stateDir.trim())) throw new Error('Invalid stateDir');
  const timeout = value.processTimeoutMs ?? 30_000;
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) throw new Error('Invalid processTimeoutMs');
  return { schemaVersion: 1, mode: 'local', stateDir: value.stateDir ? resolve(base, value.stateDir as string) : resolve(homedir(), '.loomhelm'), processTimeoutMs: timeout };
}
