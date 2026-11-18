import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
// The checker is also the CLI entry, so tests exercise the exact CI policy.
// @ts-ignore JavaScript checker intentionally has no generated declaration file.
import { checkPluginBoundaries, runCli } from '../scripts/check-plugin-boundaries.mjs';

function fixture(t: import('node:test').TestContext, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'mario-boundaries-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

for (const path of ['plugins/system.ts', 'plugins/vendor/example.js']) {
  test(`same private import policy for ${path}`, t => {
    const prefix = path.includes('/vendor/') ? '../../' : '../';
    const imports = [
      `${prefix}packages/core/src/store.ts`, '@super-mario/core', '@super-mario/core/store',
      `${prefix}apps/server/src/index.ts`, `${prefix}packages/core/src/agent-runtime/index.ts`,
      `${prefix}packages/plugin-sdk/src/private.ts`, '@super-mario/plugin-sdk/src/index.ts',
      'super-mario/plugin-sdk/internal', '@super-mario/protocol/src/index.ts',
    ];
    const root = fixture(t, { [path]: imports.map(value => `import ${JSON.stringify(value)};`).join('\n') });
    const result = checkPluginBoundaries(root);
    assert.equal(result.pluginFiles, 1);
    assert.deepEqual(result.violations.map((issue: { specifier: string }) => issue.specifier), imports);
    assert.equal(result.violations[1].line, 2);
  });
}

test('public entries, plugin-local code, Node and third-party libraries are allowed; comments and strings are inert', t => {
  const root = fixture(t, { 'plugins/examples/public.ts': `
    import type { Extension } from '../../packages/plugin-sdk/src/index.ts';
    export type { Json } from '../../packages/protocol/src/index.ts';
    import 'super-mario/plugin-sdk'; import '@super-mario/plugin-sdk';
    import 'super-mario/protocol'; import '@super-mario/protocol';
    import 'node:fs'; import 'ws'; import '../helper.js';
    const text = "import '@super-mario/core'";
    // import '@super-mario/core';
    /* export * from '@super-mario/core'; import(variable); */
  ` });
  assert.deepEqual(checkPluginBoundaries(root).violations, []);
});

test('re-exports, literal dynamic imports, import types and CommonJS cannot bypass the policy', t => {
  const root = fixture(t, { 'plugins/nested/test.cts': `
    export * from '@super-mario/core';
    export { x } from '../../apps/server/private.js';
    import('@super-mario/core');
    import(\`@super-mario/core\`);
    type X = import('@super-mario/core').X;
    require('@super-mario/core');
    import X = require('@super-mario/core');
    import(variable);
    import(\`./\${name}.js\`);
  ` });
  const result = checkPluginBoundaries(root);
  assert.equal(result.violations.length, 9);
  assert.match(result.violations[7].reason, /non-literal/);
});

test('pi imports are confined to core agent-runtime, with test code exempt', t => {
  const root = fixture(t, {
    'packages/core/src/agent-runtime/adapter.ts': "import '@earendil-works/pi-ai';",
    'tests/adapter.test.ts': "import '@earendil-works/pi-ai';",
    'packages/core/src/other.ts': "export * from '@earendil-works/pi-coding-agent';",
    'apps/server/index.js': "import('@earendil-works/pi-ai');",
    'plugins/example.ts': "import '@earendil-works/pi-ai';",
  });
  assert.equal(checkPluginBoundaries(root).violations.length, 3);
});

test('CLI --root reports source location and returns failure for the CI gate', t => {
  const root = fixture(t, { 'plugins/example.ts': "// heading\nimport '@super-mario/core';" });
  const output: string[] = [];
  const errors: string[] = [];
  assert.equal(runCli(['--root', root], (text: string) => output.push(text), (text: string) => errors.push(text)), 1);
  assert.match(errors.join('\n'), /plugins\/example.ts:2: forbidden import "@super-mario\/core"/);
  writeFileSync(join(root, 'plugins/example.ts'), "import 'node:path';");
  assert.equal(runCli(['--root', root], (text: string) => output.push(text)), 0);
  assert.match(output.join('\n'), /1 plugin files checked/);
  assert.equal(runCli(['--root'], () => {}, () => {}), 1);
});

test('ledger and none event handlers cannot bypass the host with direct network or process I/O',t=>{
 const root=fixture(t,{
  'plugins/unsafe.ts':`import 'node:http'; import 'node:child_process'; const subscription={effects:'ledger',handler(){fetch('https://invalid.example');}};`,
  'plugins/direct.ts':`import 'node:http'; const subscription={effects:'direct',handler(){fetch('https://invalid.example');}};`,
 });
 const result=checkPluginBoundaries(root);
 assert.equal(result.violations.length,3);assert.ok(result.violations.every((v:{path:string})=>v.path==='plugins/unsafe.ts'));
 assert.equal(runCli(['--root',root],()=>{},()=>{}),1);
});

test('reverse boundary: core and shared packages cannot import individual plugins or apps', t => {
  const root = fixture(t, {
    'packages/protocol/src/leak.ts': "import '../../../plugins/feishu.ts';",
    'packages/plugin-sdk/src/leak.ts': "import '../../core/src/store.ts';",
    'packages/core/src/domain.ts': "import '../../../plugins/knowledge-source-reader.ts';\nimport '../../../apps/server/src/index.ts';",
    'packages/core/src/workbench.ts': "import '../../../plugins/index.ts';",
    'plugins/index.ts': "export {};",
  });
  const result = checkPluginBoundaries(root);
  assert.equal(result.violations.length, 4);
  assert.deepEqual(result.violations.map((v: { path: string }) => v.path).sort(), [
    'packages/core/src/domain.ts',
    'packages/core/src/domain.ts',
    'packages/plugin-sdk/src/leak.ts',
    'packages/protocol/src/leak.ts',
  ]);
});
