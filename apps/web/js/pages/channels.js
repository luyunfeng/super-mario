// 渠道：在飞书里找 Agent。机器人是三步向导：扫码创建 → 在飞书里配对 → 选择负责的项目。
// 个人消息采集需要单独授权，默认关闭，只读。手动接入、信箱和事件收进“高级”。
import { h, replace } from '../lib/dom.js';
import { Button, Banner, Card, Check, Dot, Empty, Field, Fold, Input, Pill, Select } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';
import { Hint, hintCopy } from '../ui/hint.js';
import { createPersonalMessagesUI } from '../features/personal-messages.js';
import { createBotMailboxesUI } from '../legacy/bot-mailboxes.js';
import { systemText } from '../copy/terms.js';

const JOB_LABELS = { queued: '准备中', waiting_for_scan: '等待扫码', creating_app: '创建中', configuring: '配置中', publishing: '发布中', verifying: '核验中', completed: '机器人已创建', needs_configuration: '需要完成配置', failed: '创建失败', unknown: '结果未知', cancelled: '已取消', expired: '二维码已过期' };
const JOB_DONE = new Set(['completed', 'needs_configuration', 'failed', 'unknown', 'cancelled', 'canceled', 'expired']);
const GLOBAL = '__global';

export function createChannelsPage({ api, store, router, shell }) {
  let bots = [];
  const mainSetup = () => router.current.parts[0] === 'main-bot';
  let job = null;
  let selected = '';
  let registrations = [];
  let restoreScope = false;
  let creating = false;
  let nameDraft;
  let error = '';
  let seq = 0;
  let timer;
  let projectSig = '';

  const node = (tag, text, className) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value; };
  const projects = () => (store.view.snapshot?.projects ?? []).filter(item => !item.archivedAt);
  const scopeText = (scope) => scope?.kind === 'project' ? `项目：${projects().find(item => item.id === scope.projectId)?.name ?? '项目已不可用'}`
    : scope?.kind === 'global' ? '全局' : '还没有选择负责的项目';

  // —— 机器人向导 ——
  const wizard = h('div', { class: 'stack stack--lg' });
  const botCard = Card({ title: '飞书机器人', hint: 'channel.bot', id: 'channel-bot', body: wizard });

  function step(number, title, done, content) {
    return h('li', { class: `wstep ${done ? 'is-done' : ''}`, dataset: { step: number, done: String(done) } },
      h('span', { class: 'wstep__mark', 'aria-hidden': 'true' }, done ? '✓' : String(number)),
      h('div', { class: 'wstep__main' }, h('strong', null, title), content));
  }

  function renderJob(record = job) {
    if (!record) return null;
    const qr = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(record.qrDataUrl || '') && h('img', { class: 'qr', src: record.qrDataUrl, alt: '使用飞书扫描，创建机器人', width: 240, height: 240 });
    const steps = (record.missingSteps || []).map((item) => {
      const text = typeof item === 'string' ? item : item.message || item.title || item.description || '请核查飞书配置';
      let link;
      try { const url = new URL(item.url); if (url.protocol === 'https:' && ['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname)) link = h('a', { href: url.href, target: '_blank', rel: 'noopener noreferrer' }, '前往飞书配置'); } catch { /* 没有链接。 */ }
      return h('p', { class: 'small' }, systemText(text), ' ', link);
    });
    return h('div', { class: 'stack', dataset: { job: record.status } },
      h('div', { class: 'row' }, Pill(JOB_LABELS[record.status] ?? '等待处理', record.status === 'failed' || record.status === 'unknown' ? 'danger' : record.status === 'completed' ? 'ok' : 'info'),
        record.progress && h('span', { class: 'muted small' }, systemText(record.progress))),
      record.id && ['failed', 'unknown', 'expired', 'needs_configuration'].includes(record.status) &&
        h('div', { class: 'small muted' }, '日志 ID：', h('code', null, record.id),
          record.diagnostic && h('span', null, ' · ', record.diagnostic.step,
            record.diagnostic.httpStatus && ' · HTTP ' + record.diagnostic.httpStatus,
            record.diagnostic.platformCode !== undefined && ' · 飞书业务码 ' + record.diagnostic.platformCode,
            record.diagnostic.reason && ' · ' + record.diagnostic.reason,
            record.diagnostic.redirectHost && ' · 跳转主机 ' + record.diagnostic.redirectHost,
            record.diagnostic.platformLogId && ' · 飞书日志 ID：' + record.diagnostic.platformLogId)),
      qr, record.status === 'unknown' && Banner({ tone: 'danger', children: '结果未知。请先到飞书后台核对，系统不会自动重复创建。' }),
      record.expiresAt && h('p', { class: 'muted small' }, `二维码有效期至 ${new Date(record.expiresAt).toLocaleString('zh-CN')}`), steps,
      !JOB_DONE.has(record.status) && Button({ label: '取消本次创建', size: 'sm', onClick: async () => { job = await api.post(`/feishu/registrations/${encodeURIComponent(record.id)}/cancel`, {}); paint(); } }));
  }

  function renderCreate() {
    const projectSetup = router.current.parts[0] === 'project-bot';
    const project = projectSetup && projects().find(item => item.id === router.current.parts[1]);
    const label = mainSetup() ? '主 Agent' : project ? project.name : '工作助手';
    const suggested = ('Super Mario · ' + label).slice(0, 80).replace(/[\uD800-\uDBFF]$/, '');
    const name = Input({ value: nameDraft ?? suggested, maxLength: 80, required: true, 'aria-label': '机器人名称' });
    name.addEventListener('input', () => { nameDraft = name.value; });
    const scope = mainSetup() ? { kind: 'global' } : project ? { kind: 'project', projectId: project.id } : { kind: 'unmarked' };
    const active = job && (!JOB_DONE.has(job.status) || job.status === 'unknown');
    return h('div', { class: 'stack' },
      projectSetup && h('p', { class: 'small' }, project ? '负责项目：' + project.name : '项目不可用，请返回项目页重新选择。'),
      mainSetup() && h('p', { class: 'small' }, '为主 Agent 创建全局飞书机器人，可跟进所有项目。'),
      !bots.length && !active && h('ol', { class: 'howto small' },
        h('li', null, '扫码创建机器人（用飞书扫一扫）'), h('li', null, '在飞书里私聊它，回复配对码'), h('li', null, mainSetup() ? '确认全局机器人已连接' : '选择它负责的项目')),
      !active && h('form', { class: 'row', onsubmit: async (event) => {
        event.preventDefault();
        if (!name.value.trim() || (projectSetup && !project)) return;
        event.currentTarget.querySelector('button').disabled = true;
        try { job = await api.post('/feishu/registrations', { name: name.value.trim(), scope, requireConfirmation: true }); creating = false; error = ''; }
        catch (cause) { error = cause.status && cause.status < 500 ? `没有开始创建：${systemText(cause.message)}` : '创建结果未知，请先到飞书后台核对，系统不会自动重试。'; if (!cause.status || cause.status >= 500) job = { id: '', status: 'unknown' }; }
        paint(); schedule();
      } }, h('div', { class: 'grow' }, name), h('button', { class: 'btn btn--primary', type: 'submit', disabled: projectSetup && !project }, '生成二维码')),
      renderJob());
  }

  function renderBot(bot) {
    const bind = Select({ options: [[GLOBAL, '全局（所有项目）'], ...projects().map(item => [item.id, item.name])], value: bot.scope?.kind === 'project' ? bot.scope.projectId : bot.scope?.kind === 'global' ? GLOBAL : projects()[0]?.id ?? GLOBAL, 'aria-label': '负责的项目', disabled: !bot.paired });
    const paired = Boolean(bot.paired);
    const bound = bot.scope?.kind === 'project' || bot.scope?.kind === 'global';
    return h('ol', { class: 'wsteps' },
      step(1, '扫码创建机器人', true, [h('p', { class: 'muted small' }, `「${bot.name}」${bot.connected ? '已连接' : '未连接'}${bot.reason ? `：${systemText(bot.reason)}` : ''}`),
      !bot.enabled && renderJob(registrations.findLast(item => item.botId === bot.id && ['needs_configuration', 'unknown'].includes(item.status)) ?? null)]),
      step(2, '在飞书里完成配对', paired, paired ? h('p', { class: 'muted small' }, '已配对，由服务端确认。')
        : !bot.enabled ? h('div', { class: 'stack' },
          h('p', { class: 'small' }, '工作台连接已停用。确认飞书版本已发布后，可启用现有机器人。'),
          Button({ label: '已发布，启用连接', size: 'sm', onClick: async () => {
            try { await api.patch(`/feishu/bots/${encodeURIComponent(bot.id)}`, { enabled: true }); await load(); schedule(); }
            catch (cause) { error = systemText(cause.message); paint(); }
          } }))
        : !bot.connected ? h('p', { class: 'small' }, bot.reason || '等待飞书长连接建立。')
        : h('p', { class: 'small' }, bot.pairingCode ? `请在飞书里私聊「${bot.name}」，发送配对码：` : (bot.reason || '等待配对信息。'), bot.pairingCode && h('code', { class: 'pairing' }, bot.pairingCode))),
      step(3, '选择它负责的项目', bound, h('div', { class: 'row row--wrap' }, h('div', { style: { minWidth: '200px' } }, bind),
        Button({ label: '绑定', size: 'sm', disabled: !paired, onClick: async () => {
          await api.patch(`/feishu/bots/${encodeURIComponent(bot.id)}`, { scope: bind.value === GLOBAL ? { kind: 'global' } : { kind: 'project', projectId: bind.value } });
          await load(); store.refresh();
        } }), h('span', { class: 'muted small' }, scopeText(bot.scope)))));
  }

  function paint() {
    const current = bots.find(bot => bot.id === selected) ?? (creating ? null : bots[0]);
    selected = current?.id ?? '';
    const showCreate = creating || !bots.length || (job && !job.botId);
    replace(wizard,
      error && Banner({ tone: 'danger', children: error }),
      bots.length > 0 && h('div', { class: 'list' }, bots.map(bot => h('div', { class: `item item--click ${bot.id === selected ? 'is-selected' : ''}`, tabindex: 0, role: 'button', dataset: { bot: bot.id },
        onclick: () => { if (job && JOB_DONE.has(job.status)) job = null; selected = bot.id; creating = false; paint(); }, onkeydown: (event) => { if (event.key === 'Enter') event.currentTarget.click(); } },
      Dot(bot.connected ? 'ok' : 'warn'), h('div', { class: 'item__main' }, h('span', { class: 'item__title' }, bot.name), h('span', { class: 'item__meta' }, `${scopeText(bot.scope)} · ${bot.paired ? '已配对' : '未配对'}`)),
      !bot.enabled && Pill('已停用')))),
      current && !showCreate && renderBot(current),
      showCreate ? renderCreate() : Button({ label: '添加另一个机器人', icon: 'plus', size: 'sm', onClick: () => { creating = true; nameDraft = undefined; job = null; paint(); } }),
      !bots.length && !showCreate && Empty({ title: '还没有机器人' }));
  }

  // 个人账号授权和采集独立于机器人连接，不要求用户理解 CLI 配置。
  const personal = createPersonalMessagesUI({ api, store, router, onConnectApplication() {
    creating = true; paint(); botCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    botCard.querySelector('input')?.focus();
  } });
  const collectCard = personal.el;

  const webStatus = h('div', { class: 'stack', 'aria-live': 'polite' });
  let webRequest = 0;
  let webPluginState;
  async function refreshWebGateway() {
    const request = ++webRequest;
    try {
      const state = await api.get('/feishu/web');
      if (request !== webRequest) return;
      if (typeof state?.enabled !== 'boolean' || typeof state.connected !== 'boolean') throw Error('响应格式无效');
      const received = Date.parse(state.lastReceivedAt);
      replace(webStatus,
        h('div', { class: 'row' }, Pill(state.enabled ? '已启用' : '已停用', state.enabled ? 'info' : ''),
          state.enabled && Pill(state.connected ? '已连接' : '未连接', state.connected ? 'ok' : 'warn')),
        h('p', { class: 'small muted' }, '最近收到消息：', Number.isFinite(received)
          ? h('time', { datetime: state.lastReceivedAt }, new Date(received).toLocaleString('zh-CN')) : '暂无记录'),
        state.error && Banner({ tone: 'danger', children: state.error }));
    } catch (cause) {
      if (request === webRequest) replace(webStatus, Banner({ tone: 'danger', children: '无法读取网页版网关状态：' + systemText(cause.message) }));
    }
  }
  async function configureWebGateway() {
    const path = '/feishu/web/settings';
    const drawer = openDrawer({ title: '配置网关', body: '正在读取网关配置…' });
    try {
      const settings = await api.get(path);
      if (!drawer.el.open) return;
      if (typeof settings?.baseUrl !== 'string' || typeof settings.hasToken !== 'boolean') throw Error('响应格式无效');
      const address = Input({ type: 'url', value: settings.baseUrl, required: true });
      const token = Input({ type: 'password', autocomplete: 'new-password' });
      const tokenHint = h('span', { class: 'field__hint', 'aria-live': 'polite' });
      const failure = h('div', { role: 'alert' });
      function updateTokenHint() {
        failure.textContent = '';
        const changed = address.value.trim() !== settings.baseUrl;
        token.required = changed || !settings.hasToken;
        tokenHint.textContent = changed ? '更换地址时须填写新网关的令牌。'
          : settings.hasToken ? '已配置令牌。留空保留原令牌。' : '首次配置，请填写网关令牌。';
      }
      address.addEventListener('input', updateTokenHint);
      token.addEventListener('invalid', () => { failure.textContent = tokenHint.textContent; });
      token.addEventListener('input', () => { failure.textContent = ''; });
      updateTokenHint();
      const save = Button({ label: '保存配置', kind: 'primary', type: 'submit' });
      replace(drawer.body, h('form', { class: 'stack', onsubmit: async event => {
        event.preventDefault();
        if (save.disabled) return;
        const baseUrl = address.value.trim(), secret = token.value.trim();
        if (token.required && !secret) { failure.textContent = tokenHint.textContent; token.focus(); return; }
        save.disabled = true;
        failure.textContent = '';
        try {
          await api.put(path, { baseUrl, ...(secret ? { token: secret } : {}) });
          token.value = '';
          drawer.close();
          await refreshWebGateway();
        } catch { failure.textContent = '保存失败，请核对网关地址和令牌后重试。'; }
        finally { save.disabled = false; }
      } },
      h('p', { class: 'small muted' }, '默认地址指向运行工作台服务端的本机。请先运行兼容网关，在网关中登录飞书并开启监听。'),
      Field({ label: '网关地址', control: address }), Field({ label: '网关令牌', control: token, hint: tokenHint }),
      failure, save));
    } catch { replace(drawer.body, Banner({ tone: 'danger', children: '无法读取网关配置，请关闭后重试。' })); }
  }
  const webCard = Card({ title: '飞书网页版网关（可选）', id: 'channel-feishu-web',
    body: h('div', { class: 'stack' },
      h('p', { class: 'small' }, '运行兼容网关，登录飞书并开启监听。网关与工作台服务端同机时，点击「配置网关」，保留默认地址并填写网关令牌。'),
      h('p', { class: 'small muted' }, '启用后每 15 秒同步一次私聊。网关暂时无法核实群聊的折叠状态，因此小群也暂不采集。需要处理群聊时可使用飞书 CLI。'),
      webStatus, h('div', { class: 'row row--wrap' },
      Button({ label: '配置网关', size: 'sm', onClick: configureWebGateway }),
      Button({ label: '刷新网关状态', size: 'sm', onClick: refreshWebGateway }),
      Button({ label: '管理网页版插件', size: 'sm', onClick: () => shell.openPluginSettings('feishu-web') }))) });

  // —— 高级 ——
  const advancedHost = h('div', { class: 'legacy' });
  let mailboxes;
  const advanced = Fold({ title: '高级：手动接入、信箱与事件', body: advancedHost, onOpen: () => {
    mailboxes = createBotMailboxesUI({ api, element: advancedHost, showRegistration: false, getState: () => store.view.snapshot, onChanged: async () => { await load(); store.refresh(); } });
    mailboxes.open();
  } });

  const problemBox = h('div', { id: 'channel-problems' });
  const el = h('section', { class: 'page', id: 'channels' },
    h('div', { class: 'page__inner' },
      h('header', { class: 'page__head' },
        h('div', { class: 'page__title' }, h('h1', null, '渠道'), h('p', { class: 'page__sub' }, hintCopy('nav.channels').tag)),
        h('div', { class: 'page__actions' }, Hint('nav.channels'))),
      problemBox, h('div', { class: 'stack stack--lg' }, botCard, h('p', { class: 'small muted' }, '两种接入方式可独立启停，也可同时使用。同一飞书账号建议只开启一种。'),
        h('div', { class: 'channel-gateways' }, collectCard, webCard), advanced)));

  async function load() {
    const stamp = ++seq;
    const results = await Promise.allSettled([api.get('/feishu/bots'), personal.refresh(), api.get('/feishu/registrations')]);
    if (stamp !== seq) return;
    if (results[0].status === 'fulfilled') bots = results[0].value;
    if (results[2].status === 'fulfilled') {
      const jobs = results[2].value;
      registrations = jobs;
      job = job?.id ? jobs.find(item => item.id === job.id) ?? job : jobs.find(item => !JOB_DONE.has(item.status) || (item.status === 'unknown' && !item.botId)) ?? null;
    }
    if (restoreScope && results[0].status === 'fulfilled') {
      restoreScope = false;
      const match = bots.find(bot => mainSetup() ? bot.scope?.kind === 'global'
        : bot.scope?.kind === 'project' && bot.scope.projectId === router.current.parts[1]);
      if (match) { selected = match.id; creating = false; }
    }
    if (job?.botId && bots.some(bot => bot.id === job.botId) && JOB_DONE.has(job.status)) {
      selected = job.botId; creating = false; job = null;
    }
    error = results.some(item => item.status === 'rejected') ? '部分渠道信息读取失败，请检查连接和访问权限。' : '';
    paint();
  }

  function schedule() {
    clearTimeout(timer);
    const waiting = (job && !JOB_DONE.has(job.status)) || bots.some(bot => bot.enabled && !bot.paired);
    if (!waiting || router.current.page !== 'channels') return;
    timer = setTimeout(async () => {
      const id = job?.id;
      if (id && !JOB_DONE.has(job.status)) {
        try {
          const next = await api.get('/feishu/registrations/' + encodeURIComponent(id));
          if (router.current.page !== 'channels' || job?.id !== id) return;
          job = next; error = ''; paint();
          if (JOB_DONE.has(job.status)) await load();
        } catch { error = '读取扫码进度失败，正在重新连接。'; paint(); }
      } else await load();
      schedule();
    }, job?.status === 'queued' ? 350 : 1500);
  }

  return {
    el,
    onShow(route) {
      nameDraft = undefined;
      restoreScope = ['main-bot', 'project-bot'].includes(route.parts[0]);
      if (['main-bot', 'project-bot'].includes(route.parts[0])) { selected = ''; creating = true; }
      else if (route.parts[0] === 'bot') { selected = route.parts[1] || ''; creating = false; }
      else creating = false;
      refreshWebGateway();
      load().then(schedule); if (route.parts[0] === 'advanced') advanced.open = true; },
    onState({ snapshot }) {
      const webPlugin = snapshot.plugins?.find(plugin => plugin.id === 'feishu-web');
      const next = JSON.stringify([webPlugin?.enabled, webPlugin?.status]);
      if (webPluginState !== undefined && webPluginState !== next && router.current.page === 'channels') refreshWebGateway();
      webPluginState = next;
      const problems = (snapshot.problems ?? []).filter(item => item.area === 'channel');
      const configured = snapshot.setup?.channel === 'done';
      replace(problemBox, configured && problems.map(item => Banner({ tone: 'danger', children: `${item.message}。${item.fix}` })));
      // 向导里可能有正在输入的内容：只有项目列表变了才重绘。
      const signature = JSON.stringify(projects().map(item => [item.id, item.name]));
      if (signature !== projectSig) { projectSig = signature; if (router.current.page === 'channels') paint(); }
      mailboxes?.update(snapshot);
    },
  };
}
