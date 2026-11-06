#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync('skills/source-manifest.json', 'utf8'));
const files = manifest.files;
const dependencyConditions = {
  'git-sync': 'topic branch synchronization or detached-HEAD alignment',
  'grill-with-docs': 'unresolved design decisions; must return to design rather than execute',
  'agent-vm': 'isolated Linux / Docker / heavyweight integration verification',
  'ego-browser': 'browser operations and controlled visual evidence',
  'firmware-display-preview': 'firmware display visual scenarios only',
};
const entries = manifest.skills.map(name => {
  const resources = files.filter(file => file.path.startsWith(`skills/${name}/`));
  const text = resources.filter(file => file.path.endsWith('.md')).map(file => readFileSync(file.path, 'utf8')).join('\n');
  const referenced = [...new Set([...text.matchAll(/\$([a-z][a-z0-9]*(?:-[a-z0-9]+)+)/g)].map(match => match[1]))];
  return { name, entry: `skills/${name}/SKILL.md`, files: resources.length,
    internalSkills: referenced.filter(ref => manifest.skills.includes(ref) && ref !== name).sort(),
    externalSkills: referenced.filter(ref => dependencyConditions[ref]).sort().map(skill => ({ skill, strength: 'required-when-applicable', condition: dependencyConditions[skill] })),
    platform: name === 'multi-task-flow' ? 'macOS launchd for installed viewer; POSIX ledger/HTTP on macOS/Linux' : 'POSIX; specialty tools and host capabilities as declared by the original Skill',
    scripts: resources.filter(file => /\/scripts\/.+/.test(file.path)).map(file => file.path),
  };
});
writeFileSync('skills/catalog.json', JSON.stringify({ schemaVersion: 1, sourceCommit: manifest.commit, entries }, null, 2) + '\n');
