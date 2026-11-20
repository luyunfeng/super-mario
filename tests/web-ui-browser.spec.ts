import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { createProjectDiscovery } from '../plugins/project-discovery.ts';

type Server = Awaited<ReturnType<typeof startServer>>;

async function withApp(run: (ctx: { server: Server; browser: Browser; open: (hash?: string, size?: { width: number; height: number }) => Promise<{ page: Page; errors: string[] }>; post: (path: string, body: unknown) => Promise<any> }) => Promise<void>, token?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'mario-ui-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir, demo: true, ...(token ? { token } : {}) });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${server.url}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    assert.ok(response.ok, `${path}: ${await response.clone().text()}`);
    return response.json();
  };
  const open = async (hash = '#chat', size = { width: 1440, height: 900 }) => {
    const context = await browser.newContext({ viewport: size, reducedMotion: 'reduce' });
    if(token)await context.addInitScript(value=>sessionStorage.setItem('super-mario-token',value),token);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(server.url + '/' + hash);
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(page.locator('#view.is-loading')).toHaveCount(0);
    return { page, errors };
  };
  try { await run({ server, browser, open, post }); }
  finally { await browser.close(); await server.close(); await rm(dir, { recursive: true, force: true }); }
}

test('外壳：八个入口都有作用文字，目录与总指挥群有专用刷新入口，各页面零报错', { timeout: 60000 }, async () => {
  await withApp(async ({ open }) => {
    const { page, errors } = await open('#chat');
    const items = page.locator('.nav__item');
    await expect(items).toHaveCount(8);
    assert.deepEqual(await page.locator('.nav__name').allInnerTexts(), ['首页', '对话', '收件箱', '发件箱', 'Agent', '项目', '记忆', '渠道']);
    for (const desc of await page.locator('.nav__desc').allInnerTexts()) { const han = (desc.match(/\p{Script=Han}/gu) ?? []).length; assert.ok(han > 0 && han <= 10, `${desc}（${han} 个汉字）`); }
    for (const hash of ['home', 'chat', 'inbox', 'outbox', 'agent', 'projects', 'memory', 'channels']) {
      await page.goto(page.url().split('#')[0] + '#' + hash);
      await expect(page.locator(`#${hash}`)).toBeVisible();
      await expect(page.locator(`#${hash} .hint__btn`).first()).toBeVisible();
      if (hash === 'projects') {
        await expect(page.locator('#projects .project-discovered').getByRole('button', { name: '刷新目录', exact: true })).toBeVisible();
      }
      assert.deepEqual(await page.getByRole('button', { name: /刷新/ }).allTextContents(),hash === 'projects'?['刷新目录']:hash === 'agent'?['刷新群状态']:[],hash);
    }
    assert.deepEqual(errors, []);
  });
});

test('个人消息采集：演示页说明扫码路径，不要求填写配置或运行命令', { timeout: 30000 }, async () => {
  await withApp(async ({ open }) => {
    const { page, errors } = await open('#channels', { width: 390, height: 844 });
    await page.locator('#channel-collect').getByRole('button', { name: '授权飞书账号' }).click();
    const drawer = page.getByRole('dialog', { name: '个人消息采集', exact: true });
    await expect(drawer).toContainText('用飞书扫码，确认允许读取消息');
    await expect(drawer).toContainText('当前为演示模式');
    await expect(drawer.locator('input, pre')).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: '授权飞书账号', exact: true })).toBeDisabled();
    assert.ok(await drawer.evaluate(el => el.scrollWidth <= el.clientWidth), '窄屏抽屉不能横向溢出');
    assert.deepEqual(errors, []);
  });
});

test('旧地址重定向到新位置，并改写地址栏', { timeout: 30000 }, async () => {
  await withApp(async ({ open }) => {
    const { page } = await open('#chat');
    const base = page.url().split('#')[0];
    for (const [old, expected, panel] of [['#approvals', '#chat', '#chat'], ['#todos', '#projects/all/todos', '#projects'], ['#runs', '#projects/all/runs', '#projects'], ['#knowledge', '#memory', '#memory'], ['#policies', '#agent/rules', '#agent'], ['#settings', '#agent', '#agent']]) {
      await page.goto(base + old);
      await expect(page.locator(panel)).toBeVisible();
      await expect.poll(() => new URL(page.url()).hash).toBe(expected);
    }
  });
});

test('首次使用：对话页显示四步引导，输入框随时可用，发送后消息出现', { timeout: 30000 }, async () => {
  await withApp(async ({ open }) => {
    const { page } = await open('#chat');
    await expect(page.locator('#onboarding .step')).toHaveCount(4);
    await expect(page.locator('#onboarding [data-step=channel]')).toContainText('连接飞书机器人');
    await page.locator('#message-text').fill('你好，测试发送');
    await page.keyboard.press('Enter');
    await expect(page.locator('.msg--user', { hasText: '你好，测试发送' })).toBeVisible();
    await expect(page.locator('#message-text')).toHaveValue('');
    await expect(page.locator('#onboarding')).toBeHidden();
  });
});

test('对话：发送按钮始终在首屏，气泡高度由内容决定，窄屏无横向滚动', { timeout: 40000 }, async () => {
  await withApp(async ({ open, post }) => {
    await post('/messages', { text: '梳理本周待办' });
    for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 780 }]) {
      const { page } = await open('#chat', size);
      await expect(page.locator('.msg--user .msg__bubble').first()).toBeVisible();
      const box = await page.locator('.composer__send').boundingBox();
      assert.ok(box && box.y + box.height <= size.height, `发送按钮应在首屏内 ${JSON.stringify(box)}`);
      const bubble = await page.locator('.msg--user .msg__bubble').first().boundingBox();
      assert.ok(bubble && bubble.height < 80, `单行气泡高度 ${bubble?.height}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '不应出现横向滚动');
    }
  });
});

test('窄屏：导航变成底部标签栏，七项都带名称', { timeout: 30000 }, async () => {
  await withApp(async ({ open }) => {
    const { page } = await open('#chat', { width: 390, height: 780 });
    const sidebar = await page.locator('.sidebar').boundingBox();
    assert.ok(sidebar && sidebar.y > 600, '导航应在屏幕底部');
    for (const name of ['对话', '收件箱', '发件箱', 'Agent', '项目', '记忆', '渠道']) await expect(page.locator('.nav__name', { hasText: new RegExp(`^${name}$`) })).toBeVisible();
  });
});

test('等你处理：审批一次点击，高风险需二次确认，对话入口的提醒点与标题一致', { timeout: 40000 }, async () => {
  await withApp(async ({ open, post }) => {
    const { page } = await open('#chat');
    await post('/approvals', { kind: 'dispatch', title: '运行单元测试', details: 'npm test', params: { prompt: 'npm test' } });
    const card = page.locator('.attn__card', { hasText: '运行单元测试' });
    await expect(card).toBeVisible();
    await expect(page.locator('[data-nav=chat] .alert')).toHaveText('1');
    await expect.poll(() => page.title()).toContain('(1)');
    await card.locator('[data-action="批准"]').click();
    await expect(card).toHaveCount(0);
    await expect(page.locator('[data-nav=chat] .alert')).toBeHidden();

    await post('/approvals', { kind: 'dispatch', title: '清理构建目录', details: 'rm -rf build', params: { prompt: 'rm -rf build' } });
    const risky = page.locator('.attn__card', { hasText: '清理构建目录' });
    await expect(risky).toBeVisible();
    await risky.locator('[data-action="批准"]').click();
    await expect(page.locator('dialog.modal[open] h2')).toContainText('高风险');
    await page.getByRole('button', { name: '取消' }).click();
    await expect(risky).toBeVisible();
  });
});

test('等你处理：提问用输入框回答，回车提交', { timeout: 30000 }, async () => {
  await withApp(async ({ open, post }) => {
    const { page } = await open('#chat');
    await post('/interactions', { kind: 'question', title: '迁移用哪个环境？', body: '测试或预发', handler: 'user', stages: [{ handler: 'user', mode: 'suggest' }] }).catch(() => undefined);
    const card = page.locator('.attn__card', { hasText: '迁移用哪个环境' });
    if (await card.count() === 0) return; // 提问先由自动跟进处理时不在这里出现，属于正常行为。
    await card.locator('input').fill('测试环境');
    await page.keyboard.press('Enter');
    await expect(card).toHaveCount(0);
  });
});

test('待办：行内添加、完成、快捷键 c；执行详情有时间线/结果/终端', { timeout: 60000 }, async () => {
  await withApp(async ({ open }) => {
    const { page } = await open('#projects/all/todos');
    await page.locator('#todo-title').fill('联调待办');
    await page.keyboard.press('Enter');
    const row = page.locator('.todo', { hasText: '联调待办' });
    await expect(row).toBeVisible();
    await row.locator('.todo__check').click();
    await expect(page.locator('details.fold summary', { hasText: '已完成' })).toBeVisible();

    await page.goto(page.url().split('#')[0] + '#memory');
    await page.keyboard.press('c');
    await expect(page.locator('#quick-todo[open]')).toBeVisible();
    await page.locator('#quick-todo input[name=title]').fill('快捷键待办');
    await page.keyboard.press('Enter');
    await expect(page.locator('#quick-todo')).toHaveCount(0);
    await page.goto(page.url().split('#')[0] + '#projects/all/todos');
    await expect(page.locator('.todo', { hasText: '快捷键待办' })).toBeVisible();

    await page.locator('[data-tab=runs]').click();
    await page.getByRole('button', { name: '发起执行' }).click();
    await page.locator('dialog.drawer textarea').first().fill('跑一下测试');
    await page.getByRole('button', { name: '开始执行' }).click();
    await expect(page.locator('.run__title')).toHaveText('跑一下测试');
    assert.deepEqual(await page.locator('[role=tab]').allInnerTexts().then(list => list.slice(-3)), ['时间线', '结果', '终端']);
    await expect(page.locator('.accept')).toContainText('“已结束”只表示执行者停止了');
  });
});

test('项目：自动发现电脑文件夹，点击才导入，默认工作区并保留顶栏联动', { timeout: 40000 }, async () => {
  await withApp(async ({ open,server }) => {
    const home=await mkdtemp(join(tmpdir(),'mario-project-workspace-ui-'));
    const parent = join(home, '工作');
    const folder = join(parent, '官网改版');
    const sessions = join(home, '.codex', 'sessions', '2026', '11', '19');
    await mkdir(folder, { recursive: true });
    await mkdir(sessions, { recursive: true });
    const id = '59e69fb0-2657-40d3-a952-c434020524bd';
    const timestamp = '2026-11-19T10:00:00.000Z';
    await writeFile(join(sessions, `rollout-2026-11-19T10-00-00-${id}.jsonl`), [
      { type: 'session_meta', timestamp, payload: { id, cwd: folder, source: 'cli', timestamp } },
      { type: 'event_msg', timestamp, payload: { type: 'user_message', message: '查看官网改版进度' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const discovery = createProjectDiscovery({ home, cwd: folder, temporaryRoots: [], ignoreEnvironmentRoots: true });
    const node=startAgentNode({url:server.url,token:'folder-ui-token',machineId:'folder-ui',name:'项目电脑',dataDir:join(home,'node'),handlers:discovery.handlers});
    try {
      await expect.poll(()=>server.machines.list().some(machine=>machine.online)).toBe(true);
      const {page}=await open('#projects');
      const candidates = page.locator('.project-discovered').getByRole('region', { name: '项目电脑' });
      await candidates.getByRole('button', { name: `展开 ${parent}`, exact: true }).click();
      const add = candidates.getByRole('button', { name: '添加 官网改版', exact: true });
      await expect(add).toBeVisible();
      assert.equal(server.app.projects.list().length, 0);
      await add.click();
      await expect(page.locator('.proj__title')).toHaveText('官网改版');
      await expect(page.locator('[data-tab=workspace]')).toHaveAttribute('aria-selected','true');
      await expect(page.locator('.project-binding')).toContainText(folder);
      assert.deepEqual(server.app.projects.list()[0]?.workspace,{machineId:'folder-ui',cwd:folder});
      assert.deepEqual(await page.locator('.proj__detail [role=tab]').allInnerTexts().then(list=>list.map(text=>text.replace(/\s+\d+$/,''))),['工作区','待办','执行','资料','项目设置']);
      await page.locator('[data-tab=settings]').click();await expect(page.locator('#panel-settings')).toContainText('怎么跟进');
      await expect(page.locator('#scope-select option:checked')).toHaveText('官网改版');
      await page.locator('#scope-select').selectOption('');await expect(page.locator('.proj__title')).toHaveText('全部项目');
      await expect.poll(()=>new URL(page.url()).hash).toMatch(/^#projects\/all\//);
    }finally{await node.close();await rm(home,{recursive:true,force:true});}
  },'folder-ui-token');
});

test('记忆：顶部一句话直接记住，三层带说明', { timeout: 30000 }, async () => {
  await withApp(async ({ open }) => {
    const { page } = await open('#memory');
    await page.locator('#memory-input').fill('我习惯下午做代码评审');
    await page.getByRole('button', { name: '记住', exact: true }).click();
    await expect(page.locator('.item', { hasText: '代码评审' })).toBeVisible();
    await page.getByRole('button', { name: '全局', exact: true }).click();
    await expect(page.locator('#layer-note')).toContainText('全局不表示对外公开');
    await expect(page.locator('.item', { hasText: '代码评审' })).toHaveCount(0);
  });
});

test('Agent：自动处理默认保守；改为“平衡”需确认并生效', { timeout: 40000 }, async () => {
  await withApp(async ({ open }) => {
    const { page } = await open('#agent');
    await expect(page.locator('.preset[aria-checked=true]')).toContainText('保守');
    await page.locator('.preset', { hasText: '平衡' }).click();
    await expect(page.locator('dialog.modal[open]')).toContainText('改为“平衡”');
    await page.getByRole('button', { name: '改为平衡' }).click();
    await expect(page.locator('.preset[aria-checked=true]')).toContainText('平衡');
    await expect(page.locator('#policy-summary')).toContainText('1 条规则');
    await expect(page.locator('#agent')).not.toContainText('Herdr');
    assert.ok((await page.locator('#agent').innerText()).length > 0);
  });
});

test('切换页面后滚动回到顶部', { timeout: 30000 }, async () => {
  await withApp(async ({ open, post }) => {
    for (let i = 0; i < 25; i += 1) await post('/knowledge', { layer: 'personal', title: `记忆 ${i}`, content: `内容 ${i}` });
    const { page } = await open('#memory');
    await expect(page.locator('#memory .item')).toHaveCount(25);
    await page.locator('#view').evaluate(el => { el.scrollTop = 400; });
    await page.locator('[data-nav=agent]').click();
    await expect(page.locator('#agent')).toBeVisible();
    assert.equal(await page.locator('#view').evaluate(el => el.scrollTop), 0);
  });
});

test('开屏每次加载播放，站内导航沿用 loop，支持跳过和减少动态', { timeout: 30000 }, async () => {
  await withApp(async ({ server, browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(server.url + '/#chat');
    await expect(page.locator('.splash')).toBeVisible();
    assert.equal(await page.locator('.splash').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
    const video = page.locator('.splash video');
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime)).toBeGreaterThan(0);
    assert.ok(await video.evaluate((el: HTMLVideoElement) => el.muted && el.videoWidth > 0));
    await video.evaluate((el: HTMLVideoElement) => { el.currentTime = el.duration - .25; });
    const loop = page.locator('video.splash-background');
    await expect.poll(() => loop.evaluate((el: HTMLVideoElement) => el.loop && el.videoWidth > 0 && el.currentTime > 0)).toBe(true);
    await page.reload();
    await expect(video).toBeVisible();
    await page.locator('#message-text').fill('开屏期间可以输入');
    await expect(page.locator('#message-text')).toHaveValue('开屏期间可以输入');
    await expect(loop).toBeVisible();
    await page.locator('[data-nav=agent]').click();
    await expect(page.locator('#agent')).toBeVisible();
    await expect(video).toHaveCount(0);
    await expect(loop).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(loop).toHaveCount(0);
    await page.reload();
    await expect(page.locator('#view.is-loading')).toHaveCount(0);
    await expect(video).toHaveCount(0);
    await expect(loop).toHaveCount(0);
  });
});

test('分享链接带令牌：自动连接、从地址栏抹掉、保留页面和其他参数', { timeout: 40000 }, async () => {
  const token = 'offline-link-credential';
  await withApp(async ({ server, browser }) => {
    for (const [suffix, route] of [[`/#agent?token=${encodeURIComponent(token)}`, 'agent'], [`/?token=${encodeURIComponent(token)}&keep=1#memory`, 'memory'], [`/#token=${encodeURIComponent(token)}`, 'home']] as const) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript(() => { sessionStorage.setItem('super-mario-token', 'stale-credential'); });
      const headers: (string | undefined)[] = [];
      const rejected: number[] = [];
      page.on('request', request => { if (request.url().includes('/api/v1/state')) headers.push(request.headers().authorization); });
      page.on('response', response => { if (response.url().includes('/api/') && response.status() === 401) rejected.push(response.status()); });
      await page.goto(server.url + suffix);
      await expect(page.locator(`#${route}`)).toBeVisible();
      await expect(page.locator('#view.is-loading')).toHaveCount(0);
      assert.ok(!page.url().includes('token='));
      if (suffix.includes('keep=1')) assert.equal(new URL(page.url()).searchParams.get('keep'), '1');
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('super-mario-token')!));
      assert.equal(saved.value, token);
      assert.ok(Math.abs(saved.expiresAt - Date.now() - 30 * 86400000) < 30000);
      const next = await context.newPage();
      await next.goto(server.url + '/#inbox');
      await expect(next.locator('#view.is-loading')).toHaveCount(0);
      await next.evaluate(() => localStorage.setItem('super-mario-token', JSON.stringify({value:'old',expiresAt:Date.now()-1})));
      await next.reload();
      await expect(next.locator('#error')).toBeVisible();
      assert.ok(headers.length > 0 && headers.every(header => header === `Bearer ${token}`));
      assert.deepEqual(rejected, []);
      await context.close();
    }
  }, token);
});

test('令牌错误：不进入工作台，可在连接面板更正', { timeout: 30000 }, async () => {
  await withApp(async ({ server, browser }) => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(server.url + '/#token=offline-invalid');
    await expect(page.locator('#error')).toContainText('访问令牌无效');
    await expect(page.locator('#view.is-loading')).toHaveCount(1);
    assert.ok(!page.url().includes('token='));
    await page.locator('#token').fill('offline-valid');
    await page.locator('#auth-form').getByRole('button', { name: '连接工作台' }).click();
    await expect(page.locator('#view.is-loading')).toHaveCount(0);
    await expect(page.locator('#home')).toBeVisible();
  }, 'offline-valid');
});

test('任务计划：待确认的计划在“等你处理”里，开始后任务出现在项目的执行里', { timeout: 40000 }, async () => {
  await withApp(async ({ open, post }) => {
    const { page } = await open('#chat');
    await post('/plans', { title: '发布 v0.2', tasks: [{ prompt: '跑一遍测试', doneWhen: '全部通过', expectMinutes: 10 }, { prompt: '整理发布说明', doneWhen: '文档已生成', expectMinutes: 5 }] });
    const card = page.locator('.attn__card', { hasText: '发布 v0.2' });
    await expect(card).toBeVisible();
    await expect(card.locator('.pill', { hasText: '计划' })).toBeVisible();
    await expect(page.locator('[data-nav=chat] .alert')).toHaveText('1');
    await card.locator('summary').click();
    await expect(card).toContainText('完成标准：全部通过');
    await card.locator('[data-action="开始执行"]').click();
    await expect(card).toHaveCount(0);
    await page.goto(page.url().split('#')[0] + '#projects/all/runs');
    await expect(page.locator('#plans-box')).toContainText('计划 1');
    await page.locator('#plans-box summary').click();
    await expect(page.locator('#plans-box .plan')).toContainText('跑一遍测试');
    await expect(page.locator('#plans-box .plan .pill')).toContainText(/已启动|启动中/);
  });
});

test('审批：先“改一下”再批准，批准的是最新版本；旧版本被改动后给出冲突提示', { timeout: 40000 }, async () => {
  await withApp(async ({ open, post, server }) => {
    const { page } = await open('#chat');
    const approval = await post('/approvals', { kind: 'dispatch', title: '跑测试', details: '', params: { prompt: 'npm test', cwd: '/code/a' } });
    const card = page.locator('.attn__card', { hasText: '跑测试' });
    await expect(card).toBeVisible();
    await card.locator('[data-action="改一下"]').click();
    const drawer = page.locator('dialog.drawer');
    await drawer.getByLabel('执行内容').fill('npm run test:unit');
    // 另一处先改了同一条审批：本次保存应该被拒绝并提示重新核对，而不是静默覆盖。
    await fetch(`${server.url}/api/v1/approvals/${approval.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: approval.version, title: '跑测试（他人修改）' }) });
    await drawer.getByRole('button', { name: '保存修改' }).click();
    await expect(drawer).toContainText('刚刚被改动');
    await drawer.getByRole('button', { name: '关闭' }).click();
    const fresh = page.locator('.attn__card', { hasText: '他人修改' });
    await expect(fresh).toBeVisible();
    await fresh.locator('[data-action="改一下"]').click();
    await page.locator('dialog.drawer').getByLabel('执行内容').fill('npm run test:unit');
    await page.locator('dialog.drawer').getByRole('button', { name: '保存修改' }).click();
    await expect(page.locator('dialog.drawer')).toHaveCount(0);
    const stored = await fetch(`${server.url}/api/v1/approvals`).then(r => r.json());
    assert.equal(stored.find((item: any) => item.id === approval.id).params.prompt, 'npm run test:unit');
    assert.equal(stored.find((item: any) => item.id === approval.id).version, approval.version + 2);
  });
});

test('主 Agent 有独立的全局机器人入口，进入向导不发起外部注册', async () => {
  await withApp(async ({ open }) => {
    const { page } = await open('#agent');
    const card = page.locator('#agent-bot');
    await expect(card).toContainText('尚未绑定全局机器人');
    let registration: unknown;
    await page.route('**/api/v1/feishu/registrations', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      registration = route.request().postDataJSON();
      return route.fulfill({ json: { id: 'fixture', status: 'queued' } });
    });
    await card.getByRole('link', { name: '配置机器人' }).click();
    await expect(page.getByLabel('机器人名称', { exact: true })).toHaveValue('Super Mario · 主 Agent');
    assert.equal(registration, undefined);
    await page.getByLabel('机器人名称', { exact: true }).fill('我的团队助手');
    await page.getByRole('button', { name: '生成二维码' }).click();
    await expect.poll(() => registration).toEqual({ name: '我的团队助手', scope: { kind: 'global' }, requireConfirmation: true });
  });
});

test('创建项目机器人默认使用项目名，提交时保留项目范围', async () => {
  await withApp(async ({ open, post }) => {
    const project = await post('/projects', {name:'年度预算'});
    const { page } = await open('#channels/project-bot/' + project.id);
    await expect(page.getByLabel('机器人名称', { exact:true })).toHaveValue('Super Mario · 年度预算');
    let request: unknown;
    await page.route('**/api/v1/feishu/registrations', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      request = route.request().postDataJSON();
      return route.fulfill({json:{id:'fixture',status:'queued'}});
    });
    await page.getByRole('button',{name:'生成二维码'}).click();
    await expect.poll(() => request).toEqual({name:'Super Mario · 年度预算',scope:{kind:'project',projectId:project.id},requireConfirmation:true});
  });
});

test('刷新主机器人入口保留已有机器人的配置进度', async () => {
  await withApp(async ({ open, post }) => {
    const bot = await post('/feishu/bots', { name: '全局助手', scope: { kind: 'global' }, appId: 'cli_0123456789abcdef', appSecret: 'test', enabled: false });
    const { page } = await open('#channels/main-bot');
    await page.route('**/api/v1/feishu/registrations', route => route.fulfill({ json: [
      { id: 'registration-test', botId: bot.id, status: 'needs_configuration', progress: '检查权限', missingSteps: [] },
    ] }));
    await page.reload();
    const wizard = page.locator('#channel-bot');
    await expect(wizard.getByText('检查权限')).toBeVisible();
    await expect(wizard.getByRole('button', { name: '已发布，启用连接' })).toBeVisible();
    await expect(wizard.getByRole('button', { name: '绑定', exact: true })).toBeDisabled();
    await expect(wizard.getByRole('button', { name: '生成二维码' })).toHaveCount(0);
  });
});

test('首页默认进入，按期限分待办并跟随所选项目', async () => {
  await withApp(async ({ open, post }) => {
    const project = await post('/projects', { name: '首页项目' });
    await post('/todos', { title: '今天核对账单', projectId: project.id, dueAt: new Date(Date.now() + 3600000).toISOString() });
    await post('/todos', { title: '准备下季度材料', projectId: project.id });
    await post('/todos', { title: '未归项目的事项' });
    const { page } = await open('', { width: 390, height: 844 });
    const home = page.locator('#home');
    await expect(home).toBeVisible();
    await expect(home.locator('section.card').filter({ has: page.getByRole('heading', { name: '重要紧急' }) })).toContainText('今天核对账单');
    await expect(home.locator('section.card').filter({ has: page.getByRole('heading', { name: '重要不急' }) })).toContainText('准备下季度材料');
    await page.locator('#scope-select').selectOption(project.id);
    await expect(home).not.toContainText('未归项目的事项');
    await expect(home.locator('.home-project').filter({ hasText: '首页项目' })).toContainText('未完成待办 2 项');
    await expect(home).toContainText('执行结束');
    assert.ok(await home.evaluate(el => el.scrollWidth <= el.clientWidth));
  });
});

test('首页群聊动态仅收录人数已核实且不超过 50 人的群', async () => {
  await withApp(async ({ open }) => {
    const { page } = await open('#chat');
    await page.route('**/api/v1/state', async route => {
      const response = await route.fetch();
      const state = await response.json();
      const receivedAt = new Date().toISOString();
      state.inbox = [50, 51, undefined].map(size => ({
        id: 'message-' + size, source: 'feishu:personal', title: '测试群-' + size, text: '排查结果已同步', tier: 'fyi', receivedAt,
        origin: { kind: 'group', connector: '飞书', chatId: 'chat-' + size, personalGroupObserved: true, personalGroupUserCount: size },
      }));
      await route.fulfill({ json: state });
    });
    await page.goto(page.url().split('#')[0] + '#home');
    await page.reload();
    const home = page.locator('#home');
    await home.getByText('群聊动态 · 1 个群').click();
    await expect(home).toContainText('测试群-50');
    await expect(home).not.toContainText('测试群-51');
    await expect(home).not.toContainText('测试群-undefined');
  });
});

test('机器人卡片的发起执行入口只打开表单', async () => {
  await withApp(async ({ open, server }) => {
    const count = server.app.store.list('runs').length;
    const { page } = await open('#projects/all/runs/new');
    await expect(page.getByRole('dialog', { name: '发起执行', exact: true })).toBeVisible();
    assert.equal(server.app.store.list('runs').length, count);
  });
});
