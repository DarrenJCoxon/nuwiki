#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = process.cwd();
const errors = [];
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const forbiddenPackedPrefixes = [
  'bin/',
  '.claude/',
  '.agents/',
  'node_modules/',
  'src/',
  'docs/',
  'scripts/',
  'tests/',
];

// NuWiki is by design an integration package — its storage adapters must talk
// to SharePoint, Google Drive, and Supabase via HTTP. `fetch(` and `WebSocket`
// are therefore not forbidden here (unlike NuFlow's runtime). The remaining
// terms would indicate either heritage leakage or genuinely unsafe patterns.
const forbiddenRuntimeTerms = [
  'child_process',
  'exec(',
  'execSync',
  'spawn(',
  '@modelcontextprotocol',
  'odd-flow',
  'claude',
  'anthropic',
  'ruvector',
];

if (pkg.name !== '@nusoft/nuwiki') {
  errors.push('package name must be @nusoft/nuwiki');
}

if (!/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/.test(pkg.version)) {
  errors.push(`version "${pkg.version}" is not valid semver`);
}

if (pkg.publishConfig?.access !== 'restricted' && pkg.publishConfig?.access !== 'public') {
  errors.push('publishConfig.access must be either "restricted" or "public"');
}

if (pkg.publishConfig?.registry !== 'https://registry.npmjs.org/') {
  errors.push('publishConfig.registry must be https://registry.npmjs.org/');
}

if (pkg.bin) {
  errors.push('runtime package must not expose CLI bins');
}

if (pkg.dependencies) {
  for (const [dep] of Object.entries(pkg.dependencies)) {
    if (!dep.startsWith('@nusoft/')) {
      errors.push(`runtime dependency "${dep}" is not first-party (only @nusoft/* allowed)`);
    }
  }
}

let pack;
try {
  pack = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  )[0];
} catch (error) {
  errors.push(`npm pack --dry-run failed: ${error.stderr || error.message}`);
}

if (pack) {
  for (const file of pack.files || []) {
    const packedPath = file.path.replace(/^package\//, '');
    for (const prefix of forbiddenPackedPrefixes) {
      if (packedPath.startsWith(prefix)) {
        errors.push(`pack includes forbidden path ${packedPath}`);
      }
    }

    if (!packedPath.startsWith('dist/') || !/\.(js|d\.ts)$/.test(packedPath)) continue;

    const localPath = path.join(root, packedPath);
    if (!fs.existsSync(localPath)) continue;

    const body = fs.readFileSync(localPath, 'utf8');
    for (const term of forbiddenRuntimeTerms) {
      if (body.toLowerCase().includes(term.toLowerCase())) {
        errors.push(`${packedPath} contains forbidden runtime term "${term}"`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error('NuWiki package verification failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`NuWiki package verification passed for ${pack.files.length} packed files.`);
