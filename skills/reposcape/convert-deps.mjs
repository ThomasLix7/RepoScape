#!/usr/bin/env node
// convert-deps.mjs — Toolchain Convergence converter (dependency-cruiser → RepoScape).
//
// Ejects a project's existing dependency-cruiser `forbidden` path-boundary rules into
// .reposcape/architecture_rules.json so the Safety Radar lights up without anyone
// hand-authoring rules. One-shot and auditable (eject, not live). Zero dependencies —
// Node built-ins only.
//
// Usage: node convert-deps.mjs [projectRoot] [--dry-run] [--force]
//   projectRoot   defaults to the current working directory
//   --dry-run     print the result + report, write nothing
//   --force       overwrite an existing architecture_rules.json
//
// Note: dependency-cruiser from/to/pathNot are REGEXES (unanchored .test()), whereas
// hand-written RepoScape rules are globs. Converted rules are tagged `pathKind:"regex"`
// so the engine compiles them with new RegExp(...) instead of globToRegExp(...).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const CONFIG_NAMES = [
  '.dependency-cruiser.json',
  '.dependency-cruiser.cjs',
  '.dependency-cruiser.js',
  '.dependency-cruiserrc.json',
  '.dependency-cruiserrc.cjs',
  '.dependency-cruiserrc.js',
  '.dependency-cruiserrc',
];

function parseArgs(argv) {
  const args = { projectRoot: process.cwd(), dryRun: false, force: false };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (!a.startsWith('--')) args.projectRoot = path.resolve(a);
  }
  return args;
}

function findConfig(projectRoot) {
  for (const name of CONFIG_NAMES) {
    const p = path.join(projectRoot, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Load the config the simple way: JSON.parse for .json, otherwise require() the file so
// Node executes any dynamic CJS logic for us. ESM-only configs fall back to dynamic import.
async function loadConfig(configPath) {
  const ext = path.extname(configPath);
  if (ext === '.json' || configPath.endsWith('.dependency-cruiserrc')) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      // extensionless rc that is actually JS — fall through to require/import
    }
  }
  const require = createRequire(import.meta.url);
  try {
    const mod = require(configPath);
    return mod && mod.default ? mod.default : mod;
  } catch (e1) {
    try {
      const mod = await import(pathToFileURL(configPath).href);
      return mod && mod.default ? mod.default : mod;
    } catch (e2) {
      throw new Error(`require: ${e1.message}; import: ${e2.message}`);
    }
  }
}

// dependency-cruiser path/pathNot may be a string or an array (treated as alternation).
function normalizePattern(p) {
  if (Array.isArray(p)) return p.length === 1 ? p[0] : `(?:${p.join('|')})`;
  return p;
}

function hasBackref(str) {
  return /\$[0-9]+/.test(str);
}

function mapSeverity(sev) {
  return sev === 'error' ? 'error' : 'warn';
}

function convert(config) {
  const boundaries = [];
  const skipped = []; // { name, reason }
  const notes = []; // non-fatal per-rule notes

  const forbidden = Array.isArray(config?.forbidden) ? config.forbidden : [];

  for (const rule of forbidden) {
    const name = rule.name || '(unnamed)';
    const from = rule.from || {};
    const to = rule.to || {};

    // Only pure path→path boundaries map. Rules keyed on dependencyTypes / circular /
    // orphan / reachable / couldNotResolve etc. are a different kind of check.
    if (typeof from.path === 'undefined' || typeof to.path === 'undefined') {
      skipped.push({
        name,
        reason: 'not a path→path boundary (no from.path/to.path — e.g. dependencyTypes/circular/orphan)',
      });
      continue;
    }

    const fromPath = normalizePattern(from.path);
    const toPath = normalizePattern(to.path);
    const toPathNotJoined =
      typeof to.pathNot !== 'undefined' ? normalizePattern(to.pathNot) : undefined;

    // Capture-group back-references ($1) are a relational constraint the engine can't
    // express yet — skip and report rather than emit a broken rule.
    if (hasBackref(toPath) || (toPathNotJoined && hasBackref(toPathNotJoined))) {
      skipped.push({ name, reason: 'uses a capture-group back-reference ($1) — unsupported' });
      continue;
    }

    const boundary = {
      from: fromPath,
      to: toPath,
      pathKind: 'regex',
      severity: mapSeverity(rule.severity),
      reason: rule.comment || rule.name || `Forbidden: ${fromPath} -> ${toPath}`,
    };

    if (typeof to.pathNot !== 'undefined') {
      boundary.except = Array.isArray(to.pathNot) ? to.pathNot : [to.pathNot];
    }

    if (typeof from.pathNot !== 'undefined') {
      notes.push(`${name}: from.pathNot dropped (engine 'except' is to-side only)`);
    }

    boundaries.push(boundary);
  }

  if (Array.isArray(config?.allowed) && config.allowed.length) {
    skipped.push({
      name: 'allowed[]',
      reason: `${config.allowed.length} allowed rule(s) — allow-list semantics, not imported`,
    });
  }
  if (Array.isArray(config?.required) && config.required.length) {
    skipped.push({
      name: 'required[]',
      reason: `${config.required.length} required rule(s) — required-dependency semantics, not imported`,
    });
  }

  return { boundaries, skipped, notes };
}

async function main() {
  const { projectRoot, dryRun, force } = parseArgs(process.argv.slice(2));

  const configPath = findConfig(projectRoot);
  if (!configPath) {
    console.error(`No dependency-cruiser config found in ${projectRoot}`);
    console.error(`Looked for: ${CONFIG_NAMES.join(', ')}`);
    process.exit(2);
  }
  console.log(`Found config: ${path.relative(projectRoot, configPath) || configPath}`);

  let config;
  try {
    config = await loadConfig(configPath);
  } catch (e) {
    console.error(`Failed to load config — ${e.message}`);
    console.error(
      'No rules imported. If the config is ESM-only or has unresolvable imports, convert the declarative subset by hand.'
    );
    process.exit(1);
  }

  const { boundaries, skipped, notes } = convert(config);

  console.log('');
  console.log(`Imported ${boundaries.length} boundary rule(s); skipped ${skipped.length}.`);
  for (const n of notes) console.log(`  note:    ${n}`);
  for (const s of skipped) console.log(`  skipped: ${s.name} — ${s.reason}`);
  console.log('');

  const outPath = path.join(projectRoot, '.reposcape', 'architecture_rules.json');
  const envelope = {
    _source: 'dependency-cruiser',
    _generated: new Date().toISOString(),
    boundaries,
  };

  if (dryRun) {
    console.log(`--dry-run: would write ${path.relative(projectRoot, outPath)}:`);
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }

  if (boundaries.length === 0) {
    console.error('Nothing to write (0 boundary rules mapped). Not creating an empty rules file.');
    process.exit(1);
  }

  if (fs.existsSync(outPath) && !force) {
    console.error(
      `${path.relative(projectRoot, outPath)} already exists. Re-run with --force to overwrite.`
    );
    process.exit(3);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(envelope, null, 2) + '\n', 'utf-8');
  console.log(`Wrote ${boundaries.length} rule(s) to ${path.relative(projectRoot, outPath)}`);
  console.log(
    'The daemon watches this file and will recompile; check GET /api/violations for the current snapshot.'
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
