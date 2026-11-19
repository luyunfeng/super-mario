import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type Page, type Route } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';

// 新电脑接口在浏览器边界模拟；其余页面、旧项目和会话使用临时数据库的真实 API。
async function withFolders(run: (ctx: { page: Page; base: string; first: any; second: any; old: any; writes: any[]; scans: string[]; go: (id: string, tab?: string) => Promise<void>; json: (route: Route, data: any, status?: number) => Promise<void> }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-folders-web-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const json = (route: Route, data: any, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  try {
    const create = async (name: string) => {
      const res = await fetch(`${server.url}/api/v1/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      assert.equal(res.status, 201); return res.json();
    };
    const first = { ...await create('文件夹甲'), workspace: { machineId: 'a', cwd: '/work/alpha' } };
    const second = { ...await create('文件夹乙'), workspace: { machineId: 'b', cwd: '/work/beta' } };
    const old = await create('历史项目');
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const writes: any[] = [], scans: string[] = [], imported: any[] = [];
    const machines = [
      { id: 'a', name: '电脑甲', online: true, capabilities: ['workspace.projects', 'workspace.directory'] },
      { id: 'b', name: '电脑乙', online: true, capabilities: ['workspace.projects', 'workspace.directory'] },
      { id: 'off', name: '离线电脑', online: false, capabilities: ['workspace.projects'] },
      { id: 'legacy', name: '旧电脑', online: true, capabilities: [] },
    ];
    await page.route('**/api/v1/state', async route => {
      const res = await route.fetch(); const state = await res.json();
      state.projects = state.projects.map((p: any) => p.id === first.id ? first : p.id === second.id ? second : p);
      state.projects.push(...imported);
      state.machines = machines;
      state.executors = [
        { id: 'exec-a', name: '甲执行者', machineId: 'a', available: true, mode: 'real' },
        { id: 'exec-b', name: '乙执行者', machineId: 'b', available: true, mode: 'real' },
      ];
      await json(route, state);
    });
    await page.route('**/api/v1/machines/*/projects*', async route => {
      scans.push(route.request().url());
      const id = new URL(route.request().url()).pathname.split('/').at(-2);
      await json(route, { projects: id === 'a' ? [
        { name: '甲', cwd: '/work/alpha', sources: ['codex'], exists: true },
        { name: '新增', cwd: '/work/new', sources: ['codex', 'git'], exists: true },
        { name: '已移除', cwd: '/work/gone', sources: ['工作历史'], exists: false },
      ] : [{ name: '乙', cwd: '/work/beta', sources: ['codex'], exists: true }], homeDir: '/work', roots: ['/work'], warnings: ['部分历史记录无法读取'], truncated: true });
    });
    await page.route('**/api/v1/projects', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      const body = route.request().postDataJSON(); writes.push(body);
      // 模拟 HTTP 的校验后结果，浏览器不能自行承诺远端目录真实存在。
      const added = { ...first, ...body, id: `folder-added-${imported.length}` };
      imported.push(added);
      await json(route, added, 201);
    });
    const go = async (id: string, tab = '') => {
      await page.goto(`${server.url}/#projects/${id}${tab ? `/${tab}` : ''}`);
      await expect(page.locator('.proj__title')).toBeVisible();
    };
    await run({ page, base: server.url, first, second, old, writes, scans, go, json });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
}

test('文件夹发现：自动扫描但不导入；显示真实来源、已添加、缺失；点击才添加', { timeout: 40000 }, async () => {
  await withFolders(async ({ page, first, writes, scans, go }) => {
    await go(first.id);
    await expect(page.getByRole('tab', { name: '工作区', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.project-binding')).toContainText('电脑甲 · 在线');
    await expect(page.locator('.project-binding')).toContainText('/work/alpha');
    await expect(page.locator('.project-discovered')).toContainText('新增');
    await expect(page.locator('.project-discovered')).toContainText('结果已截断。找不到目标文件夹时，可在“更多文件夹 / 手动绑定”中输入绝对路径。');
    assert.equal(writes.length,0);assert.ok(scans.some(url=>url.includes('/machines/a/projects')));assert.ok(scans.some(url=>url.includes('/machines/b/projects')));
    await page.getByRole('button', { name: '从电脑添加 / 发现项目' }).click();
    await expect(page.locator('dialog.drawer')).toContainText('按目录筛选已有会话中的项目文件夹，不遍历目录。');
    await expect(page.locator('.folder-results')).toContainText('结果已截断。找不到目标文件夹时，可在下方输入绝对路径，手动绑定。');
    await expect(page.locator('.folder-results')).toContainText('筛选目录：/work');
    await expect(page.locator('[data-cwd="/work/alpha"]')).toContainText('已添加');
    await expect(page.locator('[data-cwd="/work/gone"]')).toContainText('目录不存在');
    await expect(page.locator('[data-cwd="/work/new"]')).toContainText('来源：本机会话历史、代码仓库');
    await expect(page.locator('.folder-results')).not.toContainText('codex');
    assert.equal(writes.length, 0); assert.ok(scans.length >= 2);
    await page.locator('[data-cwd="/work/new"]').getByRole('button', { name: '添加', exact: true }).click();
    await expect(page.locator('dialog.drawer')).toHaveCount(0);
    assert.deepEqual(writes, [{ name: '新增', workspace: { machineId: 'a', cwd: '/work/new' } }]);
    await expect(page.locator('.proj__title')).toHaveText('新增');
    await expect(page.getByRole('tab', { name: '工作区', exact: true })).toHaveAttribute('aria-selected', 'true');
  });
});

test('筛选目录可累加；切电脑不提交草稿；离线与旧电脑不发扫描请求', { timeout: 40000 }, async () => {
  await withFolders(async ({ page, first, scans, writes, go }) => {
    await go(first.id);
    await page.getByRole('button', { name: '从电脑添加 / 发现项目' }).click();
    await expect(page.locator('.folder-results')).toContainText('/work/new');
    await page.getByRole('textbox', { name: '文件夹', exact: true }).fill('/manual/draft');
    await page.getByRole('textbox', { name: '筛选目录', exact: true }).fill('/extra');
    await page.getByRole('button', { name: '加入目录筛选' }).click();
    await expect.poll(() => scans.some(url=>new URL(url).searchParams.getAll('root').includes('/extra'))).toBe(true);
    assert.deepEqual(new URL(scans.find(url=>new URL(url).searchParams.getAll('root').includes('/extra'))!).searchParams.getAll('root'), ['/work', '/extra']);
    await page.getByRole('textbox', { name: '筛选目录', exact: true }).fill('/other');
    await page.getByRole('button', { name: '加入目录筛选' }).click();
    await expect.poll(() => scans.some(url=>new URL(url).searchParams.getAll('root').includes('/other'))).toBe(true);
    assert.deepEqual(new URL(scans.find(url=>new URL(url).searchParams.getAll('root').includes('/other'))!).searchParams.getAll('root'), ['/work', '/extra', '/other']);
    await page.getByLabel('电脑', { exact: true }).selectOption('b');
    await expect(page.locator('.folder-results')).toContainText('/work/beta');
    await expect(page.getByRole('textbox', { name: '文件夹', exact: true })).toHaveValue('/manual/draft');
    const beforeOffline=scans.length;
    await page.getByLabel('电脑', { exact: true }).selectOption('off');
    await expect(page.locator('.folder-results')).toContainText('离线');
    await page.getByLabel('电脑', { exact: true }).selectOption('legacy');
    await expect(page.locator('.folder-results')).toContainText('暂不支持');
    assert.equal(scans.length, beforeOffline); assert.equal(writes.length, 0);
  });
});

test('旧项目保留数据并显式绑定；手工文件夹只 PATCH workspace', { timeout: 40000 }, async () => {
  await withFolders(async ({ page, old, go, json }) => {
    const patches: any[] = [];
    await page.route(`**/api/v1/projects/${old.id}`, async route => {
      patches.push(route.request().postDataJSON());
      await json(route, { ...old, workspace: patches.at(-1).workspace });
    });
    await go(old.id);
    await expect(page.locator('#panel-workspace')).toContainText('已有对话、待办和资料会保留');
    await expect(page.getByRole('button', { name: '发送目标' })).toBeDisabled();
    await page.locator('.project-binding').getByRole('button', { name: '绑定文件夹', exact: true }).click();
    await page.getByRole('textbox', { name: '文件夹', exact: true }).fill('/existing/folder');
    await page.getByRole('button', { name: '绑定此文件夹' }).click();
    await expect(page.locator('dialog.drawer')).toHaveCount(0);
    assert.deepEqual(patches, [{ workspace: { machineId: 'a', cwd: '/existing/folder' } }]);
  });
});

test('持续对话：真实临时存储、草稿按项目保留、快照不覆盖草稿、无验收分钟表单', { timeout: 40000 }, async () => {
  await withFolders(async ({ page, base, first, second, go }) => {
    await go(first.id);
    await expect(page.getByRole('button', { name: '发送目标' })).toBeEnabled();
    assert.equal(await page.getByLabel('怎样算完成').count(), 0);
    assert.equal(await page.getByLabel('预计用时（分钟）').count(), 0);
    await page.getByLabel('项目目标').fill('项目甲草稿');
    await page.locator(`.proj__item[data-project="${second.id}"]`).click();
    await expect(page.locator(".proj__title")).toHaveText(second.name);
    await page.getByLabel('项目目标').fill('项目乙草稿');
    await page.locator(`.proj__item[data-project="${first.id}"]`).click();
    await expect(page.locator(".proj__title")).toHaveText(first.name);
    await expect(page.getByLabel('项目目标')).toHaveValue('项目甲草稿');
    // 真实写入触发服务端事件及快照；不涉及模型、执行者或个人目录。
    const response = await fetch(`${base}/api/v1/projects/${first.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '只记录这条项目消息' }) });
    assert.equal(response.status, 202);
    await expect(page.getByRole('log', { name: '项目对话' })).toContainText('只记录这条项目消息');
    await expect(page.getByLabel('项目目标')).toHaveValue('项目甲草稿');
    await page.getByRole('button', { name: '发送目标' }).click();
    await expect(page.getByRole('log', { name: '项目对话' })).toContainText('项目甲草稿');
    await expect(page.getByLabel('项目目标')).toHaveValue('');
    const stored = await (await fetch(`${base}/api/v1/projects/${first.id}/workspace`)).json();
    assert.ok(stored.messages.some((m: any) => m.text === '项目甲草稿' && m.conversationId === `project:${first.id}:work`));
    await page.locator(`.proj__item[data-project="${second.id}"]`).click();
    await expect(page.locator(".proj__title")).toHaveText(second.name);
    await expect(page.getByLabel('项目目标')).toHaveValue('项目乙草稿');
    await expect(page.getByRole('log', { name: '项目对话' })).not.toContainText('项目甲草稿');
  });
});

test('旧扫描与旧项目响应不污染新选择；unknown 写操作只发送一次', { timeout: 40000 }, async () => {
  await withFolders(async ({ page, first, second, go, json }) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/v1/machines/a/projects', async route => {
      await gate; await json(route, { projects: [{ name: '迟到结果', cwd: '/late', sources: [], exists: true }], roots: [], warnings: [], truncated: false });
    });
    await go(first.id);
    await page.getByRole('button', { name: '从电脑添加 / 发现项目' }).click();
    await expect(page.locator('.folder-results')).toContainText('正在读取会话历史');
    await page.getByLabel('电脑', { exact: true }).selectOption('b');
    await expect(page.locator('.folder-results')).toContainText('/work/beta');
    release();
    await expect(page.locator('.folder-results')).not.toContainText('/late');
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    let complete!: () => void;
    const sent = new Promise<void>(resolve => { complete = resolve; });
    let writes = 0;
    await page.route(`**/api/v1/projects/${first.id}/messages`, async route => { writes++; await sent; await json(route, { error: 'unknown' }, 502); });
    await page.getByLabel('项目目标').fill('未知动作');
    await page.getByRole('button', { name: '发送目标' }).click();
    await page.locator(`.proj__item[data-project="${second.id}"]`).click();
    await expect(page.locator(".proj__title")).toHaveText(second.name);
    await page.getByLabel('项目目标').fill('保留乙草稿');
    complete();
    await expect(page.getByLabel('项目目标')).toHaveValue('保留乙草稿');
    await expect(page.locator('#panel-workspace')).not.toContainText('发送结果未知');
    await page.locator(`.proj__item[data-project="${first.id}"]`).click();
    await expect(page.locator(".proj__title")).toHaveText(first.name);
    await expect(page.locator('#panel-workspace')).toContainText('发送结果未知');
    await expect(page.getByRole('button', { name: '发送目标' })).toBeDisabled();
    assert.equal(writes, 1);
  });
});

test('直接执行继承文件夹、限定电脑，真实任务保留验收和时间校验', { timeout: 40000 }, async () => {
  await withFolders(async ({ page, first, go, json }) => {
    await go(first.id, 'runs');
    await page.getByRole('button', { name: '发起执行', exact: true }).click();
    await expect(page.getByLabel('谁来做')).toHaveValue('exec-a');
    await expect(page.getByLabel('谁来做').locator('option')).toHaveCount(1);
    await expect(page.locator('dialog.drawer')).toContainText('继承项目文件夹：/work/alpha');
    await expect(page.getByLabel('怎样算完成')).toHaveAttribute('required', '');
    await expect(page.getByLabel('预计用时（分钟）')).toHaveAttribute('required', '');
    await page.getByText('更多选项', { exact: true }).click();
    await expect(page.getByLabel('目录（继承项目）')).toHaveValue('/work/alpha');
    await expect(page.getByLabel('目录（继承项目）')).toHaveAttribute('readonly', '');
    let body: any;
    await page.route('**/api/v1/runs', async route => { body = route.request().postDataJSON(); await json(route, { error: '缺少验收要求' }, 400); });
    await page.getByLabel('要做什么').fill('真实任务');
    await page.getByRole('button', { name: '开始执行' }).click();
    await expect(page.locator('dialog.drawer')).toContainText('缺少验收要求');
    assert.equal(body.executorId, 'exec-a'); assert.equal(body.cwd, '/work/alpha'); assert.equal(body.projectId, first.id);
  });
});

test('旧项目 workspace GET 迟到不覆盖新项目；绑定电脑离线仍保留其目录', { timeout: 40000 }, async () => {
  await withFolders(async ({ page, first, second, go, json }) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let requested = false;
    await page.route(`**/api/v1/projects/${first.id}/workspace`, async route => {
      requested = true;
      await gate;
      await json(route, { messages: [{ id: 'late', role: 'assistant', text: '甲的迟到消息' }], agents: { work: { available: true } }, progress: { open: 99 } });
    });
    await go(first.id);
    await expect.poll(() => requested).toBe(true);
    await page.locator(`.proj__item[data-project="${second.id}"]`).click();
    await expect(page.locator('.proj__title')).toHaveText(second.name);
    await expect(page.getByRole('button', { name: '发送目标' })).toBeEnabled();
    await page.getByLabel('项目目标').fill('乙草稿保持');
    release();
    await expect(page.getByLabel('项目目标')).toHaveValue('乙草稿保持');
    await expect(page.getByRole('log', { name: '项目对话' })).not.toContainText('甲的迟到消息');
    await page.route('**/api/v1/state', async route => {
      const res = await route.fetch(), state = await res.json();
      state.projects = state.projects.map((p: any) => p.id === second.id ? second : p.id === first.id ? first : p);
      state.machines = [{ id: 'b', name: '电脑乙', online: false, capabilities: ['workspace.projects'] }];
      state.executors = [{ id: 'other', name: '其他电脑执行者', machineId: 'a', available: true, mode: 'real' }];
      await json(route, state);
    });
    await go(second.id, 'runs');
    await page.reload();
    await expect(page.locator('.project-binding')).toContainText('电脑乙 · 离线');
    await expect(page.locator('.project-binding')).toContainText('/work/beta');
    await page.getByRole('button', { name: '发起执行', exact: true }).click();
    await expect(page.getByLabel('谁来做').locator('option')).toHaveCount(0);
    await page.getByRole('button', { name: '开始执行' }).click();
    await expect(page.locator('dialog.drawer')).toContainText('不能改用其他电脑');
  });
});

test('添加请求结果未知不假报失败、不重放；手动名称草稿不被扫描覆盖', { timeout: 40000 }, async () => {
  await withFolders(async ({ page, first, go, json }) => {
    let writes = 0;
    await page.route('**/api/v1/projects', async route => { writes++; await json(route, { error: 'unknown' }, 502); });
    await go(first.id);
    await page.getByRole('button', { name: '从电脑添加 / 发现项目' }).click();
    await page.getByLabel('文件夹', { exact: true }).fill('/existing/manual');
    await page.getByLabel('项目名称', { exact: true }).fill('手动名称草稿');
    await page.getByLabel('筛选目录', { exact: true }).fill('/extra');
    await page.getByRole('button', { name: '加入目录筛选' }).click();
    await expect(page.getByLabel('项目名称', { exact: true })).toHaveValue('手动名称草稿');
    await page.getByRole('button', { name: '添加此文件夹' }).click();
    await expect(page.locator('dialog.drawer')).toContainText('添加或绑定结果未知');
    await expect(page.getByRole('button', { name: '添加此文件夹' })).toBeDisabled();
    assert.equal(writes, 1);
  });
});

test('完整目录清单：超过八个仍全部显示；隐藏可恢复并跨刷新保留，长路径在窄屏换行', { timeout: 40000 }, async () => {
  await withFolders(async ({ page, first, writes, go, json }) => {
    const longPath = '/work/' + '完整显示的目录名称'.repeat(18);
    await page.route('**/api/v1/machines/*/projects*', route => {
      const id = new URL(route.request().url()).pathname.split('/').at(-2);
      return json(route, { projects: id === 'a' ? Array.from({ length: 14 }, (_, n) => ({ name: `目录-${n}`, cwd: n === 13 ? longPath : `/work/discovered-${n}`, sources: ['git'], exists: true })) : [], homeDir: '/work', roots: ['/work'], warnings: [], truncated: false });
    });
    await go(first.id);
    const list = page.locator('.project-discovered');
    await expect(list.locator('.project-discovered__item')).toHaveCount(14);
    await list.getByRole('button', { name: '隐藏 目录-13', exact: true }).click();
    await expect(list.locator('.project-discovered__item')).toHaveCount(13);
    await page.reload();
    await expect(list.locator('.project-discovered__item')).toHaveCount(13);
    await list.getByRole('button', { name: '显示已隐藏（1）', exact: true }).click();
    await expect(list.locator('.project-discovered__item')).toHaveCount(14);
    await list.getByRole('button', { name: '恢复显示 目录-13', exact: true }).click();
    await list.getByRole('button', { name: '收起已隐藏', exact: true }).click();
    await expect(list.locator('.project-discovered__item')).toHaveCount(14);
    await list.getByRole('searchbox').fill('discovered-12');
    await expect(list.locator('.project-discovered__item')).toHaveCount(1);
    await list.getByRole('searchbox').fill('');
    await list.getByRole('button', { name: '隐藏 目录-13', exact: true }).click();
    await page.getByRole('button', { name: '从电脑添加 / 发现项目' }).click();
    const drawer = page.locator('dialog.drawer');
    await expect(drawer.locator('[data-cwd]').filter({ hasText: '目录-13' })).toBeHidden();
    await drawer.getByRole('checkbox', { name: '显示已隐藏', exact: true }).check();
    const hiddenRow = drawer.locator('[data-cwd]').filter({ hasText: '目录-13' });
    await expect(hiddenRow).toBeVisible();
    await hiddenRow.getByRole('button', { name: '恢复显示 目录-13', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(list.locator('.project-discovered__item')).toHaveCount(14);
    await page.setViewportSize({ width: 390, height: 844 });
    const path = list.locator('code').filter({ hasText: longPath });
    await path.scrollIntoViewIfNeeded();
    assert.ok(await path.evaluate(el => el.getBoundingClientRect().height > parseFloat(getComputedStyle(el).lineHeight) * 2));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(writes, []); // 筛选、隐藏和恢复均没有项目写入。
  });
});

test('按电脑展开用户目录，搜索展开匹配路径，刷新保留展开状态', { timeout: 40000 }, async () => {
  await withFolders(async ({ page, first, writes, go, json }) => {
    let scans = 0;
    await page.route('**/api/v1/machines/*/projects*', route => {
      scans++;
      const legacy = route.request().url().includes('/machines/b/');
      return json(route, {
        homeDir: legacy ? undefined : '/home/me',
        projects: ['/home/me/code/group/repo', '/home/mee/external'].map(cwd => ({
          cwd, name: cwd.split('/').at(-1), exists: true, sources: ['git'],
        })),
      });
    });
    await go(first.id);
    const list = page.locator('.project-discovered');
    const a = list.getByRole('region', { name: '电脑甲' }), b = list.getByRole('region', { name: '电脑乙' });
    await expect(a.getByRole('button', { name: '收起 /home/me', exact: true })).toBeVisible();
    await expect(b.getByRole('button', { name: '展开 /home', exact: true })).toBeVisible();
    await expect(a.getByRole('button', { name: '添加 repo' })).toHaveCount(0);
    await a.getByRole('button', { name: '展开 /home/me/code', exact: true }).click();
    await a.getByRole('button', { name: '展开 /home/me/code/group', exact: true }).click();
    await expect(a.getByRole('button', { name: '添加 repo' })).toBeVisible();
    await expect(b.getByRole('button', { name: '添加 repo' })).toHaveCount(0);
    await expect(a.getByRole('button', { name: '添加 code' })).toHaveCount(0);
    const before = scans;
    await list.getByRole('button', { name: '刷新目录' }).click();
    await expect.poll(() => scans).toBeGreaterThan(before);
    await list.getByRole('searchbox').fill('external');
    await expect(a.getByRole('button', { name: '添加 external' })).toBeVisible();
    await expect(b.getByRole('button', { name: '添加 external' })).toBeVisible();
    await list.getByRole('searchbox').fill('');
    await expect(a.getByRole('button', { name: '添加 repo' })).toBeVisible();
    assert.deepEqual(writes, []);
  });
});

for (const entry of ['目录树', '更多文件夹']) {
  test(`${entry}遇到已归档目录时由用户明确恢复原项目`, { timeout: 40000 }, async () => {
    await withFolders(async ({ page, base, old, first, go, json }) => {
      const endpoint = `${base}/api/v1/projects/${old.id}`;
      const archived = await (await fetch(endpoint, { method: 'DELETE' })).json();
      assert.ok(archived.archivedAt);
      let adds = 0, restores = 0;
      await page.route('**/api/v1/projects', async route => {
        if (route.request().method() !== 'POST') return route.fallback();
        adds++;
        await json(route, { ...archived, workspace: route.request().postDataJSON().workspace }, 201);
      });
      page.on('request', request => {
        if (request.method() === 'POST' && request.url() === endpoint + '/restore') restores++;
      });
      await go(first.id);
      const list = page.locator('.project-discovered');
      if (entry === '目录树') await list.getByRole('button', { name: '添加 新增', exact: true }).click();
      else {
        await list.getByRole('button', { name: '更多文件夹 / 手动绑定' }).click();
        await page.locator('[data-cwd="/work/new"]').getByRole('button', { name: '添加', exact: true }).click();
      }
      const surface = entry === '目录树' ? list : page.locator('dialog.drawer');
      const restore = surface.getByRole('button', { name: /^恢复项目/ });
      await expect(restore).toBeVisible();
      assert.equal(restores, 0);
      await restore.click();
      await expect(page.locator('.proj__title')).toHaveText(old.name);
      await expect(page).toHaveURL(new RegExp(old.id + '/workspace$'));
      assert.equal(adds, 1);
      assert.equal(restores, 1);
      const projects = await (await fetch(base + '/api/v1/projects')).json();
      const original = projects.find((project: { id: string }) => project.id === old.id);
      assert.ok(original && !original.archivedAt);
    });
  });
}
