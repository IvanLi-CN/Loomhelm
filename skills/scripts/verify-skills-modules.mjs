#!/usr/bin/env bun
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(dir + '/' + entry.name) : [dir + '/' + entry.name]);
const failures = [];
const files = walk('skills/bin/modules').filter(path => path.endsWith('.ts'));
if (!files.length) throw new Error('SKILLS_MODULE_COVERAGE_EMPTY');
for (const file of files) try { await import(pathToFileURL(resolve(file)).href); } catch (error) { failures.push({ file, error: String(error) }); }
console.log(JSON.stringify({ runtime: 'bun', modules: files.length, failures }));
if (failures.length) process.exit(1);
