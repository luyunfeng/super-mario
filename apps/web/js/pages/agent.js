import { openTokenStatistics } from '../features/token-statistics.js';
// Agent：配置谁来干活。模型、执行者与电脑、CLI 会话、自动处理、自动跟进；其余收进“高级”。
import { h, replace } from '../lib/dom.js';
import { Button, Card, Dot, Pill, Empty, Banner } from '../ui/kit.js';
import { Hint, hintCopy } from '../ui/hint.js';
import { createAssistantSkills } from '../features/assistant-skills.js';
import { createAssistantProfile } from '../features/assistant-profile.js';
import { openModelDrawer } from '../features/model-drawer.js';
import { openAddComputer, openComputer } from '../features/computers.js';
import { createPolicyCard } from '../features/policy.js';
import { createFollowUpCard } from '../features/follow-up.js';
import { createCommandGroupCard } from '../features/feishu-command-group.js';
import { createCliSessions } from '../features/cli-sessions.js';
import { createAdvanced } from '../features/advanced.js';
import { createScheduledWorkCard } from '../features/scheduled-work.js';

const MODE_NAMES = { api: '模型 API', 'codex-cli': 'Codex 命令行' };

export function createAgentPage({ api, store, router, consoleDrawer, scope, shell }) {
  const skills = createAssistantSkills({ api, store });
  const profile = createAssistantProfile({ api, store });
  let model = null;
  let modelError = '';
  let modelSeq = 0;

  // —— 模型 ——
  const modelStatus = h('div', { class: 'row' });
  const modelDetail = h('p', { class: 'muted small' });
  const modelCard = Card({
    title: '主 Agent 模型', hint: 'agent.model', id: 'agent-model',
    body: [modelStatus, modelDetail, h('div', null, Button({ label: '更改模型', onClick: () => model && openModelDrawer({ api, config: model, onSaved: async () => { await loadModel(); await store.refresh(); } }) }))],
  });

  async function loadModel() {
    const stamp = ++modelSeq;
    try { const value = await api.get('/model'); if (stamp !== modelSeq) return; model = value; modelError = ''; }
    catch (cause) { if (stamp !== modelSeq) return; modelError = cause.message; }
    paintModel();
  }

  function paintModel() {
    const snapshot = store.view.snapshot;
    if (!snapshot) return;
    const available = snapshot.agent.available;
    replace(modelStatus, Dot(available ? 'ok' : 'danger'), h('strong', null, available ? '可用' : '不可用'),
      h('span', { class: 'muted small' }, snapshot.agent.reason ?? ''));
    modelDetail.textContent = modelError ? `读取模型配置失败：${modelError}`
      : model ? `来源：${MODE_NAMES[model.mode] ?? model.mode}${model.provider && model.mode !== 'codex-cli' ? ` · ${model.provider}` : ''}${model.model ? ` · ${model.model}` : ' · 尚未选择模型'}`
      : '正在读取…';
  }

  const botStatus = h('div', { class: 'stack', role: 'status' });
  const botCard = Card({
    title: '主 Agent 的飞书机器人', id: 'agent-bot',
    tools: h('a', { class: 'btn btn--sm', href: router.href('channels', 'main-bot') }, '配置机器人'),
    body: botStatus,
  });
  const commandGroup = createCommandGroupCard({ api, store });
  let botRequest = 0, botCredential, botSnapshot;
  store.subscribe?.(view => {
    if (botCredential !== api.token() || view.unauthorized) {
      botRequest++;
      botCredential = undefined;
      botSnapshot = undefined;
    }
  });
  function loadFeishu() {
    botCredential = api.token();
    commandGroup.load();
    loadBots();
  }
  async function loadBots() {
    const stamp = ++botRequest, credential = api.token();
    botSnapshot = store.view.snapshot;
    try {
      const bots = (await api.get('/feishu/bots')).filter(bot => bot.scope?.kind === 'global');
      if (stamp !== botRequest || credential !== api.token()) return;
      profile.setBots(bots, credential);
      commandGroup.setMainBots(bots);
      replace(botStatus, bots.length ? bots.map(bot => h('div', { class: 'row row--wrap' },
        Dot(bot.enabled && bot.paired && bot.connected ? 'ok' : 'warn'), h('strong', null, bot.name),
        Pill(bot.enabled ? bot.connected ? '已连接' : '未连接' : '已停用'), Pill(bot.paired ? '已配对' : '未配对'),
        h('a', { href: router.href('channels', 'bot', bot.id) }, '管理')))
        : h('p', { class: 'muted small' }, '尚未绑定全局机器人。配置后，主 Agent 可用它在飞书中跟进各项目。'));
    } catch (cause) {
      if (stamp !== botRequest || credential !== api.token()) return;
      profile.setBots(undefined, credential, '读取失败：' + cause.message);
      commandGroup.setMainBots(undefined);
      replace(botStatus, Banner({ tone: 'warn', children: '读取飞书机器人失败：' + cause.message,
        action: Button({ label: '重试', size: 'sm', onClick: loadBots }) }));
    }
  }

  // —— 执行者与电脑 ——
  const computerList = h('div', { class: 'list' });
  const executorList = h('div', { class: 'list' });
  const computersCard = Card({
    title: '执行者与电脑', hint: 'agent.executors', id: 'agent-computers',
    tools: Button({ label: '添加电脑', icon: 'plus', size: 'sm', onClick: () => openAddComputer({ api }) }),
    body: [computerList, h('h3', null, '可用的执行者'), executorList],
  });

  function paintComputers(snapshot) {
    const machines = snapshot.machines ?? [];
    replace(computerList, machines.length ? machines.map(machine => h('div', { class: 'item item--click', onclick: () => openComputer({ api, machine, state: () => store.view.snapshot, consoleDrawer }), tabindex: 0, role: 'button', onkeydown: (event) => { if (event.key === 'Enter') event.currentTarget.click(); } },
      Dot(machine.online ? 'ok' : ''), h('div', { class: 'item__main' }, h('span', { class: 'item__title' }, machine.name),
        h('span', { class: 'item__meta' }, `${machine.online ? '在线' : '离线'} · ${(machine.executors ?? []).map(item => item.name).join('、') || '没有执行者'}`)),
      h('span', { class: 'muted' }, '›')))
      : Empty({ title: '还没有连接电脑', text: '连接一台电脑后，Agent 才能在上面运行 Claude Code 或 Codex。' }));
    replace(executorList, (snapshot.executors ?? []).map(item => h('div', { class: 'item' },
      Dot(item.available ? 'ok' : 'warn'),
      h('div', { class: 'item__main' }, h('span', { class: 'item__title' }, item.name), h('span', { class: 'item__meta' }, item.available ? item.description : item.reason ?? '暂不可用')),
      item.mode === 'demo' && Pill('演示'))));
  }

  const cliSessions = createCliSessions({ api, store, router });
  const policy = createPolicyCard({ api, store });
  const followUp = createFollowUpCard({ api, store });
  const scheduledWork = createScheduledWorkCard({ api, store, scope, onUpcoming: profile.setUpcoming });
  const advanced = createAdvanced({ api, store, router, openPluginSettings: shell?.openPluginSettings });

  const el = h('section', { class: 'page', id: 'agent' },
    h('div', { class: 'page__inner' },
      h('header', { class: 'page__head' },
        h('div', { class: 'page__title' }, h('h1', null, 'Agent'), h('p', { class: 'page__sub' }, hintCopy('nav.agent').tag)),
        h('div', { class: 'page__actions' }, Hint('nav.agent'))),
      h('div', { class: 'stack stack--lg' }, profile.el, skills.el, modelCard, botCard, commandGroup.el, computersCard, cliSessions.el, policy.el, followUp.el, scheduledWork.el, advanced.el)));

  let pendingSection, pendingStatistics;
  function showStatistics() {
    if (!pendingStatistics || !store.view.snapshot || router.current.page !== 'agent') return;
    pendingStatistics = false;
    if (store.view.snapshot.plugins?.some(p => p.id === 'token-statistics' && p.status === 'active')) openTokenStatistics({ api, store });
  }
  function showSection() {
    if (!pendingSection || !store.view.snapshot || router.current.page !== 'agent') return;
    const { target, route } = pendingSection;
    pendingSection = undefined;
    requestAnimationFrame(() => {
      if (router.current.canonical === route) document.getElementById(target)?.scrollIntoView({ block: 'start' });
    });
  }

  return {
    el,
    onShow(route) {
      pendingStatistics = route.query.get('tokenStats') === '1';
      showStatistics();
      scheduledWork.load(); loadModel(); loadFeishu(); policy.load(); followUp.load(); cliSessions.onShow();
      const target = { 'command-group': 'agent-command-group', rules: 'agent-rules', 'follow-up': 'agent-follow-up', advanced: 'agent-advanced' }[route.parts[0]];
      pendingSection = target && { target, route: route.canonical };
      showSection();
      if (route.parts[0] === 'advanced') advanced.el.open = true;
    },
    onState({ snapshot }) {
      showStatistics();
      if (router.current.page === 'agent' && !store.view.unauthorized) {
        if (botCredential !== api.token()) loadFeishu();
        else if (botSnapshot !== snapshot && snapshot.plugins?.some(p => p.id === 'assistant-profile' && p.status === 'active')) loadBots();
      }
      showSection();
      scheduledWork.onState(); cliSessions.onState(); paintModel(); paintComputers(snapshot); policy.setProjects(snapshot.projects ?? []); advanced.update(snapshot);
    },
  };
}
