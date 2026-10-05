import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = mkdtempSync(join(tmpdir(), 'ffp-pack-'));
const packages = readdirSync(join(root, 'packages'))
  .map((dir) => ({
    dir: join(root, 'packages', dir),
    json: JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8')),
  }))
  .filter((p) => !p.json.private);
const tarballs = {};
let failures = 0;

for (const pkg of packages) {
  const before = new Set(readdirSync(out));
  execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: pkg.dir, stdio: 'pipe' });
  const tarball = readdirSync(out).find((f) => !before.has(f));
  const file = join(out, tarball);
  tarballs[pkg.json.name] = file;
  const listing = execFileSync('tar', ['-tzf', file]).toString().split('\n').filter(Boolean);
  const manifest = JSON.parse(execFileSync('tar', ['-xzOf', file, 'package/package.json']).toString());
  const problems = [];
  for (const required of [
    'package/dist/index.js',
    'package/dist/index.cjs',
    'package/dist/index.d.ts',
    'package/dist/index.d.cts',
    'package/README.md',
    'package/LICENSE',
  ]) {
    if (!listing.includes(required)) problems.push(`missing ${required}`);
  }
  const deps = JSON.stringify({ ...manifest.dependencies, ...manifest.peerDependencies });
  if (deps.includes('workspace:')) problems.push('workspace: protocol leaked into the manifest');
  if (listing.some((f) => f.includes('/src/') || f.includes('/test/')))
    problems.push('source or test files are packed');
  const size = execFileSync('du', ['-k', file]).toString().split('\t')[0];
  console.log(
    `${problems.length ? 'FAIL' : 'ok  '} ${manifest.name}@${manifest.version} ${tarball} (${listing.length} files, ${size} KB)${problems.length ? ` → ${problems.join('; ')}` : ''}`,
  );
  failures += problems.length;
}

const project = mkdtempSync(join(tmpdir(), 'ffp-consumer-'));
writeFileSync(
  join(project, 'package.json'),
  JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
);
execFileSync(
  'npm',
  [
    'install',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    ...Object.values(tarballs),
    'react@19',
    'react-dom@19',
    '@openfeature/server-sdk@1',
    '@openfeature/web-sdk@1',
    '@openfeature/core@1',
  ],
  { cwd: project, stdio: 'pipe' },
);
const ruleset = {
  version: 1,
  flags: {
    'new-checkout': {
      key: 'new-checkout',
      kind: 'boolean',
      salt: 'x',
      variations: [
        { id: 'on', value: true },
        { id: 'off', value: false },
      ],
      config: {
        on: true,
        offVariation: 'off',
        targets: [],
        rules: [
          {
            id: 'pro',
            clauses: [{ attribute: 'plan', op: 'eq', values: ['pro'] }],
            serve: { variation: 'on' },
          },
        ],
        fallthrough: { variation: 'off' },
        version: 1,
      },
    },
  },
  segments: {},
};
writeFileSync(
  join(project, 'esm.mjs'),
  `import { init } from '@ashamrai/flags-node';
import { murmurhash3 } from '@ashamrai/flags-evaluator';
import { createClient } from '@ashamrai/flags-web';
import { FlagsProvider } from '@ashamrai/flags-react';
import { FlagsProvider as OfNode } from '@ashamrai/flags-openfeature-node';
import { WebFlagsProvider } from '@ashamrai/flags-openfeature-web';
import { RedisPersistentStore } from '@ashamrai/flags-node-redis';
import { generateTypes } from '@ashamrai/flags-cli';
import { flagSchema } from '@ashamrai/flags-contracts';
const flags = init({ sdkKey: 'srv', offline: true, bootstrap: ${JSON.stringify(ruleset)} });
await flags.waitForInitialization({ timeoutMs: 100 });
const on = flags.boolVariation('new-checkout', { kind: 'user', key: 'u1', plan: 'pro' }, false);
if (on !== true || murmurhash3('hello') !== 0x248bfa47) process.exit(1);
for (const x of [createClient, FlagsProvider, OfNode, WebFlagsProvider, RedisPersistentStore, generateTypes, flagSchema]) if (typeof x === 'undefined') process.exit(2);
await flags.close();
console.log('esm ok');
`,
);
writeFileSync(
  join(project, 'cjs.cjs'),
  `const { init } = require('@ashamrai/flags-node');
const { evaluateFlag, createStore } = require('@ashamrai/flags-evaluator');
const store = createStore(${JSON.stringify(ruleset)});
if (evaluateFlag(store, 'new-checkout', { kind: 'user', key: 'u', plan: 'pro' }).value !== true) process.exit(1);
const flags = init({ sdkKey: 'srv', offline: true, bootstrap: ${JSON.stringify(ruleset)} });
if (flags.boolVariation('new-checkout', { kind: 'user', key: 'u2' }, true) !== false) process.exit(1);
flags.close().then(() => console.log('cjs ok'));
`,
);
for (const script of ['esm.mjs', 'cjs.cjs']) {
  try {
    console.log(execFileSync('node', [script], { cwd: project }).toString().trim());
  } catch (error) {
    console.log(`FAIL ${script}: ${error}`);
    failures++;
  }
}
const cliHelp = execFileSync(join(project, 'node_modules', '.bin', 'flags'), [], { cwd: project }).toString();
if (!cliHelp.includes('codegen')) failures++;
console.log(cliHelp.includes('codegen') ? 'cli bin ok' : 'FAIL cli bin');
rmSync(out, { recursive: true, force: true });
rmSync(project, { recursive: true, force: true });
if (failures > 0) {
  console.error(`${failures} problem(s)`);
  process.exit(1);
}
console.log('pack check passed');
