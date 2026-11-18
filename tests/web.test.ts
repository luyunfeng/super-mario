import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/server/src/index.ts';

const webRoot = new URL('../apps/web/', import.meta.url);
const html = await readFile(new URL('index.html', webRoot), 'utf8');

async function walk(dir: URL, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...await walk(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`));
    else out.push(`${prefix}${entry.name}`);
  }
  return out;
}
const scriptFiles = (await walk(new URL('js/', webRoot))).map(file => `js/${file}`);
const scripts = new Map(await Promise.all(scriptFiles.map(async file => [file, await readFile(new URL(file, webRoot), 'utf8')] as const)));

test('外壳只有一个挂载点，保留跳到主内容和终端资源', () => {
  assert.match(html, /class="skip-link" href="#view"/);
  assert.match(html, /id="root"/);
  assert.match(html, /src="\/vendor\/xterm.js"/);
  assert.match(html, /href="\/vendor\/xterm.css"/);
  assert.match(html, /type="module" src="\/js\/main.js"/);
});

test('页面脚本不把文本当 HTML 执行，访问令牌只存会话', () => {
  for (const [file, source] of scripts) {
    assert.doesNotMatch(source, /\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(|\beval\s*\(/, file);
  }
  const api = scripts.get('js/lib/api.js')!;
  assert.match(api, /sessionStorage\.setItem\(TOKEN_KEY/);
  for (const [file, source] of scripts) assert.doesNotMatch(source, /localStorage\.setItem\([^)]*(?:token|secret)/i, file);
});

test('终端观察保持只读边界，关闭不取消远端工作', () => {
  const terminal = scripts.get('js/legacy/terminal.js')!;
  assert.match(terminal, /disableStdin: true/);
  assert.match(terminal, /scrollback: 0/);
  assert.doesNotMatch(terminal, /localStorage|sessionStorage/);
  const close = terminal.slice(terminal.indexOf('function close()'), terminal.indexOf('function watch('));
  assert.doesNotMatch(close, /executor\.(?:input|interrupt)|\/cancel/);
});

test('静态资源按目录提供，并拒绝越界、隐藏文件和未知类型', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-static-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true });
  try {
    const get = (path: string) => fetch(server.url + path);
    for (const [path, type] of [['/', /html/], ['/js/main.js', /javascript/], ['/css/pages.css', /css/], ['/vendor/xterm.js', /javascript/]] as const) {
      const response = await get(path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type') ?? '', type, path);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
    for (const path of ['/js/nope.js', '/package.json', '/js/../../package.json', '/.env', '/js/.hidden.js', '/css/pages.css.map', '/js/%2e%2e/%2e%2e/package.json']) {
      assert.equal((await fetch(server.url + path)).status, 404, path);
    }
    assert.equal((await fetch(server.url + '/', { method: 'POST' })).status, 404);
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
});
