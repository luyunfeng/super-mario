import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { startServer } from '../apps/server/src/index.ts';
import { startAgentNode } from '../apps/agent-node/src/index.ts';
import { createGithubNode } from '../plugins/github-node.ts';

test('渠道页可启用 GitHub 连接、选择电脑并立即检查，未读通知进入收件箱', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'mario-github-browser-'));
  const server = await startServer({ host: '127.0.0.1', port: 0, dataDir: join(dir, 'data'), demo: true, token: 'test-github' });
  const node = startAgentNode({ url: server.url, token: 'test-github', machineId: 'dev-machine', name: '开发机', dataDir: join(dir, 'node'),
    handlers: createGithubNode({ dataDir: join(dir, 'node'), run: async args => {
      const path = args.at(-1)!;
      if (path === 'user') return JSON.stringify({ login: 'octocat', name: '' });
      if (path.endsWith('/comments') && path === 'repos/octo/widgets/issues/42/comments') return JSON.stringify({ id: 77 });
      if (path.startsWith('notifications?')) return JSON.stringify([{ id: '501', reason: 'review_requested', updated_at: '2026-11-20T08:00:00Z',
        subject: { title: '加快首页', type: 'PullRequest', number: 42 }, repository: { full_name: 'octo/widgets' } }]);
      if (path === 'repos/octo/widgets/issues/42') return JSON.stringify({ title: '加快首页', body: '首页加载太慢，需要拆分。', state: 'open', user: { login: 'alice' }, comments: 2, html_url: 'https://evil.example/' });
      if (path.startsWith('repos/octo/widgets/issues/42/comments?')) return JSON.stringify([
        { id: 11, body: '我先看了首屏的请求。', created_at: '2026-11-19T00:00:00Z', user: { login: 'bob' } },
      ]);
      throw new Error('unexpected ' + path);
    } }) as never });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  t.after(async () => {
    try { await browser?.close(); }
    finally { try { await node.close(); } finally { try { await server.close(); } finally { await rm(dir, { recursive: true, force: true }); } } }
  });
  for (let i = 0; i < 200 && !server.machines.list().some(machine => machine.capabilities.includes('github.account')); i++)
    await new Promise(resolve => setTimeout(resolve, 25));
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('sm.splash.seen', 'true'));
  await page.goto(server.url + '/#channels?token=test-github');
  const card = page.locator('#channel-github');
  await expect(card.getByText('尚未启用。')).toBeVisible();

  await card.getByLabel('读取 GitHub 的电脑').selectOption('dev-machine');
  await card.getByLabel('读取 GitHub 未读通知').check();
  await card.getByRole('button', { name: '保存' }).click();
  await expect(card.getByText('当前账号', { exact: false })).toBeVisible();
  // The connector reads on activation and after saving, so the account is already named.
  await expect(card.getByRole('button', { name: '立即检查' })).toBeEnabled();
  await card.getByRole('button', { name: '立即检查' }).click();
  await expect.poll(() => server.app.inbox.list().some(item => item.source === 'github:octocat')).toBe(true);
  const item = server.app.inbox.list().find(entry => entry.source === 'github:octocat')!;
  expect(item.title).toBe('octo/widgets #42 加快首页');
  expect(item.origin?.github).toEqual({ repository: 'octo/widgets', number: 42, kind: 'pull' });

  // Opening the item shows the pull request's body and its comments, read through the machine.
  await page.goto(server.url + '/#inbox?token=test-github');
  const itemCard = page.locator('#channel-github, .mailbox-card').filter({ hasText: 'octo/widgets #42 加快首页' }).first();
  await expect(itemCard).toBeVisible();
  // The card already links to the pull request, built from the validated repository and number.
  await expect(itemCard.getByRole('link', { name: '在 GitHub 打开' })).toHaveAttribute('href', 'https://github.com/octo/widgets/pull/42');
  await itemCard.getByRole('button', { name: '查看原文与详情' }).click();
  const drawer = page.getByRole('dialog').filter({ hasText: '消息详情' });
  await expect(drawer.getByRole('link', { name: '在 GitHub 打开' })).toHaveAttribute('href', 'https://github.com/octo/widgets/pull/42');
  await expect(drawer.getByText('首页加载太慢，需要拆分。')).toBeVisible();
  await expect(drawer.getByText('我先看了首屏的请求。')).toBeVisible();
  await expect(drawer.getByText('由 alice 发起', { exact: false })).toBeVisible();
  // The API-provided address is not used anywhere in the page.
  expect(await drawer.innerHTML()).not.toContain('evil.example');

  // Replying only proposes the comment. It is posted after the owner approves it.
  const comment = drawer.getByRole('textbox', { name: '评论内容' });
  await comment.fill('已看过，可以这样改。');
  await drawer.getByRole('button', { name: '提交评论待确认' }).click();
  await expect(drawer.getByText('这条评论等待你确认。')).toBeVisible();
  await expect(drawer.getByRole('link', { name: '前往审批' })).toHaveAttribute('href', '#chat/approvals');
  const approval = server.app.approvals.list().find(item => item.kind === 'plugin:github-connector.comment')!;
  expect(approval.details).toBe('已看过，可以这样改。');
  expect(approval.status).toBe('pending');
  expect(server.app.store.list<{ kind: string }>('approvals').length).toBe(1);

  // The owner chooses which notifications reach the inbox, and the choice is saved as given.
  await page.goto(server.url + '/#channels?token=test-github');
  const githubCard = page.locator('#channel-github');
  await githubCard.getByText('哪些通知进收件箱').click();
  await githubCard.getByLabel('CI 失败收哪些').selectOption('default-branch');
  await githubCard.getByLabel('静音的仓库').fill('octo/loud\nocto/other');
  await githubCard.getByLabel('忽略的分支').fill('train/*\nbot/*');
  await githubCard.getByRole('button', { name: '保存' }).click();
  await expect.poll(() => server.app.githubView().ciMode).toBe('default-branch');
  expect(server.app.githubView().mutedRepositories).toEqual(['octo/loud', 'octo/other']);
  expect(server.app.githubView().ignoredBranches).toEqual(['train/*', 'bot/*']);
  await page.reload();
  await expect(page.locator('#channel-github').getByLabel('静音的仓库')).toHaveValue('octo/loud\nocto/other');
  expect(pageErrors).toEqual([]);
});
