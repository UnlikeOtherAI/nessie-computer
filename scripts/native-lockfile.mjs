// Pure pnpm v9 dependency closure, shared by the public executor and Nessie's
// native input gates. It runs before installation and reads no private data.
import { posix } from 'node:path';

// Audited test/lint/artwork tools do not enter an installed executor payload.
export const EXECUTOR_DEVELOPMENT_ONLY_DEPENDENCIES = ['eslint', '@typescript-eslint/parser',
  '@typescript-eslint/eslint-plugin', 'sharp', 'playwright-core'];

const scalar = (value) => value.startsWith("'") ? value.slice(1, -1).replaceAll("''", "'")
  : value.startsWith('"') ? JSON.parse(value) : value;
const normalized = (text) => text.split(/\r?\n/).filter((line) => line.trim()
  && !line.trimStart().startsWith('#')).join('\n');

function lockSections(source) {
  if (!source || !/^lockfileVersion: ['"]?9\.0['"]?\s*$/m.test(source)) return null;
  const result = { importers: new Map(), packages: new Map(), snapshots: new Map(), header: new Map() };
  let section = '';
  let entry = '';
  for (const line of source.split(/\r?\n/)) {
    const top = /^(\S[^:]*):/.exec(line);
    if (top) { section = top[1]; entry = ''; }
    const records = result[section];
    if (records instanceof Map && section !== 'header') {
      const nested = /^  (\S.*):(?:\s.*)?$/.exec(line);
      if (nested) entry = scalar(nested[1]);
      if (entry) records.set(entry, `${records.get(entry) ?? ''}${line}\n`);
    } else result.header.set(section, `${result.header.get(section) ?? ''}${line}\n`);
  }
  return result;
}

function dependencies(block, importer) {
  const result = [];
  let category = '';
  let name = '';
  for (const line of (block ?? '').split('\n')) {
    const group = /^    (dependencies|devDependencies|optionalDependencies):/.exec(line);
    if (group) { category = group[1]; continue; }
    if (/^    \S/.test(line)) category = '';
    if (!category) continue;
    const member = /^      (\S.*?):(?: (.+))?$/.exec(line);
    if (member) {
      name = scalar(member[1]);
      if (!importer && member[2]) result.push([category, name, scalar(member[2])]);
    }
    const version = /^        version: (.+)$/.exec(line);
    if (importer && version) result.push([category, name, scalar(version[1])]);
  }
  return result;
}

export function lockDependencySnapshot(source, roots, ignoredImporterDev = {}) {
  const lock = lockSections(source);
  if (!lock) return null;
  const selected = new Map();
  const visited = new Set();
  const visitPackage = (name, version) => {
    const reference = /^(@[^/]+\/[^@]+|[^@]+)@/.test(version.split('(')[0]) ? version : `${name}@${version}`;
    const key = `snapshots/${reference}`;
    if (visited.has(key)) return;
    visited.add(key);
    const snapshot = lock.snapshots.get(reference);
    const packageKey = reference.split('(')[0];
    selected.set(`packages/${packageKey}`, normalized(lock.packages.get(packageKey) ?? '<missing>'));
    selected.set(key, normalized(snapshot ?? '<missing>'));
    // Snapshot records have the same indentation as importer records, but
    // dependency values are inline instead of nested specifier/version pairs.
    for (const [, child, resolved] of dependencies(snapshot, false)) visitPackage(child, resolved);
  };
  const visitImporter = (directory, names) => {
    const key = `importers/${directory}${names ? `/${names.join(',')}` : ''}`;
    if (visited.has(key)) return;
    visited.add(key);
    const entries = dependencies(lock.importers.get(directory), true)
      .filter(([category, name]) => (!names || names.includes(name))
        && !(category === 'devDependencies' && (ignoredImporterDev[directory] ?? []).includes(name)));
    selected.set(key, JSON.stringify(entries.sort((a, b) => a.join('/').localeCompare(b.join('/')))));
    for (const [, name, version] of entries) {
      if (version.startsWith('link:')) visitImporter(posix.normalize(posix.join(directory, version.slice(5))));
      else visitPackage(name, version);
    }
  };
  for (const root of roots) visitImporter(root.directory, root.names);
  for (const name of ['lockfileVersion', 'settings']) {
    selected.set(name, normalized(lock.header.get(name) ?? ''));
  }
  return JSON.stringify([...selected].sort(([a], [b]) => a.localeCompare(b)));
}
