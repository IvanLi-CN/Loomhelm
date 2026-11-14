#!/usr/bin/env -S bun --no-install
import { readFileSync, writeFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync('skills/resource-manifest.json', 'utf8'));
const files = manifest.files;
const dependencyConditions = {
  'git-sync': 'topic branch synchronization or detached-HEAD alignment',
  'grill-with-docs': 'unresolved design decisions; must return to design rather than execute',
  'agent-vm': 'isolated Linux / Docker / heavyweight integration verification',
  'ego-browser': 'browser operations and controlled visual evidence',
  'firmware-display-preview': 'firmware display visual scenarios only',
};
// Conservative inventory of conditional source requirements. Presence is not
// authorization, login, or proof that a scenario has executed successfully.
const delivery = ['project-engineering-workflow', 'normal-flow', 'fast-flow', 'local-merge-flow', 'flow-continue'];
const cliRequirements = name => {
  const result = [];
  const add = (command, condition) => result.push({ command, strength: 'required-when-applicable', condition });
  if ([...delivery, 'git-branch', 'git-worktree', 'git-cleanup', 'find-next-plan', 'docs-migrate', 'spec-sync', 'topic-spec', 'solution-sync', 'project-doc-promote', 'dot-codex-development', 'rust-crate-release', 'srv-101-ops'].includes(name)) add('git', 'repository inspection or Git operations');
  if ([...delivery, 'git-cleanup', 'find-next-plan', 'rust-crate-release'].includes(name)) {
    add('gh', 'GitHub backend PR, check or release operations only');
    if (name !== 'rust-crate-release') add('tea', 'Gitea backend operations only');
  }
  if (name === 'rust-crate-release') { add('cargo', 'crate validation or publication'); add('rustup', 'toolchain inspection or explicitly authorized changes'); }
  if (name === 'srv-101-ops') add('ssh', 'authorized remote machine inspection');
  if (['storybook-stories', 'storybook-screenshots'].includes(name)) add('bun', 'original Storybook project build scripts when the selected project uses Bun');
  if (['storybook-screenshots', 'ui-visual-evidence', 'gui-escalation-gate', 'cn-ecommerce-data-collection', 'kaisoumail-deployment-inventory'].includes(name)) add('ego-browser', 'browser operations after reading the external ego-browser Skill');
  if (name === 'multi-task-flow') add('launchctl', 'macOS installed viewer only; not required by the POSIX ledger or foreground HTTP');
  return result;
};
const hostRequirements = name => {
  const map = {
    'fresh-thread-dispatch': [{ capability: 'mcp__codex_app__create_thread', condition: 'ordinary fresh user-owned task dispatch; active Multi-task Flow uses its separate conversation-create contract' }],
    'multi-task-flow': [{ capability: 'codex.app_server_control', condition: 'real thread creation, observation and notification through the selected Codex control socket' }],
    'git-worktree': [{ capability: 'mcp__codex_app__create_worktree', condition: 'Codex-managed task worktrees only' }],
    'git-cleanup': [{ capability: 'mcp__codex_app__archive_worktree', condition: 'cleanup of a Codex-managed worktree only' }],
    'hardware-doc-ingest': [{ capability: 'mcp__mineru__parse_documents', condition: 'PDF conversion through the original MinerU tool' }],
    'gui-escalation-gate': [{ capability: 'computer_use', condition: 'explicitly authorized escalation only, never an automatic fallback' }],
  };
  return (map[name] ?? []).map(item => ({ ...item, strength: 'required-when-applicable' }));
};
const entries = manifest.skills.map(name => {
  const resources = files.filter(file => file.path.startsWith(`skills/${name}/`));
  const text = resources.filter(file => file.path.endsWith('.md')).map(file => readFileSync(file.sourcePath ?? file.path, 'utf8')).join('\n');
  const referenced = [...new Set([...text.matchAll(/\$([a-z][a-z0-9]*(?:-[a-z0-9]+)+)/g)].map(match => match[1]))];
  return { name, entry: `skills/${name}/SKILL.md`, files: resources.length,
    internalSkills: referenced.filter(ref => manifest.skills.includes(ref) && ref !== name).sort(),
    externalSkills: referenced.filter(ref => dependencyConditions[ref]).sort().map(skill => ({ skill, strength: 'required-when-applicable', condition: dependencyConditions[skill] })),
    externalCommands: cliRequirements(name),
    hostCapabilities: hostRequirements(name),
    platform: name === 'multi-task-flow' ? 'macOS launchd for installed viewer; POSIX ledger/HTTP on macOS/Linux' : 'POSIX; specialty tools and host capabilities as declared by the original Skill',
    scripts: resources.filter(file => /\/scripts\/.+/.test(file.path)).map(file => file.path),
  };
});
writeFileSync('skills/catalog.json', JSON.stringify({ schemaVersion: 1, entries }, null, 2) + '\n');
