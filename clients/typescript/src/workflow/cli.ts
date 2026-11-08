import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { LocalValidation, type ContractDecision, type ValidationEntry } from './local.ts';
import { loadSkills, requireSkill, type SkillScope } from './skills.ts';

async function main(): Promise<void> {
  const [command, path, user, ...extra] = process.argv.slice(2);
  if (!path || extra.length || (command === 'local-verify' && user)) throw new Error('Usage: workflow/cli.ts skills <project-skills-dir> [user-skills-dir] | local-verify <manifest.json>');
  if (command === 'skills') {
    const catalog = await loadSkills({ project: resolve(path), ...(user ? { user: resolve(user) } : {}) });
    console.log(JSON.stringify(catalog));
    if (catalog.diagnostics.length) process.exitCode = 1;
    return;
  }
  if (command !== 'local-verify') throw new Error('Unknown workflow command');
  const manifestPath = resolve(path);
  const raw: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid workflow manifest');
  const manifest = raw as Record<string, unknown>;
  if (manifest.schemaVersion !== 1 || Object.keys(manifest).some(key => !['schemaVersion', 'repository', 'base', 'flowType', 'skills', 'contracts', 'implementation', 'validations'].includes(key))) throw new Error('Unsupported workflow manifest');
  if (typeof manifest.repository !== 'string' || typeof manifest.base !== 'string' || typeof manifest.implementation !== 'string' || !Array.isArray(manifest.contracts) || !Array.isArray(manifest.validations)) throw new Error('Invalid workflow manifest');
  const flowType = manifest.flowType ?? 'normal';
  if (flowType !== 'normal' && flowType !== 'fast-track' && flowType !== 'local-merge') throw new Error('Invalid flow type');
  const repository = resolve(dirname(manifestPath), manifest.repository);
  let selectedSkills: ReturnType<typeof requireSkill>[] = [];
  if (manifest.skills !== undefined) {
    const value = manifest.skills as { project: string; user?: string; requirements: { name: string; range?: string; scopes?: SkillScope[] }[] };
    if (!value || typeof value.project !== 'string' || (value.user !== undefined && typeof value.user !== 'string') || !Array.isArray(value.requirements)) throw new Error('Invalid skill requirements');
    const catalog = await loadSkills({ project: resolve(repository, value.project), ...(value.user ? { user: resolve(repository, value.user) } : {}) });
    if (catalog.diagnostics.length) {
      console.error(JSON.stringify({ error: 'Skill catalog contains diagnostics', diagnostics: catalog.diagnostics }));
      process.exitCode = 1;
      return;
    }
    selectedSkills = value.requirements.map(requirement => {
      if (!requirement || typeof requirement.name !== 'string') throw new Error('Invalid skill requirement');
      return requireSkill(catalog, requirement.name, requirement);
    });
  }
  const workflow = await LocalValidation.open(repository, manifest.base, flowType);
  await workflow.settleContracts(manifest.contracts as ContractDecision[]);
  await workflow.recordImplementation(manifest.implementation);
  const snapshot = await workflow.validate(manifest.validations as ValidationEntry[]);
  const readiness = await workflow.readiness();
  console.log(JSON.stringify({ ...snapshot, selectedSkills, readiness }));
  if (!readiness.ready) process.exitCode = 1;
}
main().catch(error => { console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Workflow failed' })); process.exitCode = 1; });
