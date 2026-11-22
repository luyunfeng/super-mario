import { openShortcutSettings } from './shortcuts.js';
import { preferenceEditor } from './plugin-preferences.js';
import { openSavedPrompts } from './saved-prompts.js';
import { openTokenStatistics } from './token-statistics.js';
import { h, replace, keyedList, readLocal, writeLocal } from '../lib/dom.js';
import { PAGES, PAGE_NAMES } from '../lib/router.js';
import { Button, Pill } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';
import { systemText } from '../copy/terms.js';

const descriptions = {
  'run-comparison':'并排查看同一项目的两次执行。',
  'shortcut-settings':'调整本浏览器的全局快捷键。',
  'start-page':'选择直接打开工作台时显示的页面，设置在同一服务的浏览器之间共享。',
  'todo-calendar':'按日、周或月查看项目待办的截止时间。',
  'assistant-skills':'管理主助手技能包，供 Web 主对话和全局飞书机器人按需读取。',
  'office-documents':'从内容生成可下载的 Word、PowerPoint 和 Excel 文件。',
  'assistant-profile':'设置主助手显示名称，查看模型、执行机和飞书连接状态。',
  'project-instructions':'为项目工作对话和新的项目派发保存工作方法、术语和验收要求。',
  'saved-prompts':'管理可在对话输入框中用斜杠插入的常用提示词。',
  'message-favorites':'收藏工作台消息，查看快照或从备份恢复。',
  'conversation-export':'下载或复制主对话和项目工作对话的 Markdown 记录。',
  'reply-translation':'翻译助手回复和飞书收件，可按会话选择自动翻译。',
  'conversation-edit':'把自己发过的文字放回输入框，修改后可作为新消息发送。',
  'voice-input':'使用浏览器语音识别，将听写结果加入主对话草稿。',
  'conversation-quotes':'在主对话和项目工作对话中引用一条消息，可附上自己的问题。',
  'conversation-drafts':'在当前浏览器保留未发送的对话文字，按会话和访问凭据恢复。',
  'conversation-search':'在顶栏搜索主对话和执行记录，保存常用检索条件。',
  'token-statistics':'从 Codex 和 Claude Code 的本地会话日志统计 Token，按日期、模型和 Agent 查看分布。',
  'workspace-splash':'进入工作台时播放开屏动画。',
  'builtin-tools':'让工作台 Agent 查询可用执行器、项目和知识。',
  'knowledge-local':'把个人、全局和项目记忆保存在本地 Markdown 文件中。',
  'executor-codex':'通过执行机将任务交给 Codex CLI。',
  'executor-pi':'通过执行机将任务交给 Pi CLI。',
  'executor-claude-code':'通过执行机将任务交给 Claude Code。',
  'terminal-host':'连接执行机上的终端会话，提供终端状态。',
  'feishu-web':'通过飞书网页版网关接收消息。',
  feishu:'连接飞书机器人，管理消息收发和机器人绑定。',
  'inbox-triage':'整理进入收件箱的消息。',
  'daily-brief':'汇总待办和执行进展，生成每日简报。',
};
const key = 'sm.pluginSidebar.v1';
const status = { active: ['已启用', 'ok'], waiting: ['等待配置', 'warn'], disabled: ['已停用', ''], failed: ['不可用', 'danger'] };

function features(plugin) {
  if (!Array.isArray(plugin.navigation)) return [];
  return plugin.navigation.filter(item => item && typeof item.id === 'string' && item.id && typeof item.label === 'string' && item.label &&
    typeof item.route === 'string' && /^#[a-z]+(?:\/[\w-]+)*(?:\?[\w=&-]+)?$/.test(item.route) &&
    !new URLSearchParams(item.route.split('?')[1]).has('token') && PAGES.includes(item.route.slice(1).split(/[/?]/)[0]))
    .map(item => ({ ...item, key: JSON.stringify([plugin.id, item.id]) }));
}

export function startPages(plugins) {
  return [...PAGES.map(page => ({ key: page, label: PAGE_NAMES[page], route: '#' + page })),
    ...plugins.filter(p => p.status === 'active').flatMap(p => features(p).map(item => ({ ...item, label: item.label + ' · ' + p.name })))];
}

function startPageEditor({ api, store }, preference, choices) {
  if (!preference) return null;
  const listed = choices.some(item => item.key === preference.key);
  const select = h('select', { class: 'select', 'aria-label': '默认打开的页面' },
    choices.map(item => h('option', { value: item.key }, item.label)),
    !listed && h('option', { value: preference.key, disabled: true }, '已选插件页面暂不可用'));
  select.value = preference.key;
  const status = h('span', { role: 'status' });
  return h('div', { class: 'stack' }, h('label', { class: 'field' }, '默认打开的页面', select),
    !listed && h('p', { class: 'small muted' }, '目前打开首页。插件恢复后会再次使用已选页面。'),
    Button({ label: '保存启动页', onClick: async () => {
      try {
        await api.post('/start-page', { key: select.value, revision: preference.revision });
        status.textContent = '已保存启动页';
      } finally { await store.refresh(); }
    } }), status);
}

export function createPluginSettings({ api, store, router }) {
  const saved = readLocal(key, []);
  const pins = new Set(Array.isArray(saved) ? saved.filter(value => typeof value === 'string') : []);
  const nav = h('nav', { class: 'plugin-links', 'aria-label': '已固定的插件功能' });
  const list = h('div', { class: 'stack' });
  const shortcuts = h('div', { class: 'row plugin-mobile-pins' });
  let rightPinned = readLocal('sm.tokenStats.right', false) === true;
  const launch = () => openTokenStatistics({ api, store });
  const right = h('button', { class: 'plugin-right', hidden: true, onclick: launch }, 'Token 统计');
  let drawer, selected = 'token-statistics';
  const menu = h('div',{class:'settings-menu'});
  const search = h('input',{type:'search',placeholder:'搜索插件', 'aria-label':'搜索插件',oninput:()=>paint()});
  const layout = h('div',{class:'settings-layout'},h('aside',{},search,menu),list);
  function openFeature(item) {
    drawer?.close();
    if (item.route === '#agent?tokenStats=1') launch();
    else router.go(item.route);
  }
  function paint() {
    const { snapshot, unauthorized, loadError } = store.view;
    const plugins = unauthorized ? [] : snapshot?.plugins ?? [];
    right.hidden = !rightPinned || !plugins.some(p => p.id === 'token-statistics' && p.status === 'active');
    const available = new Map();
    for (const plugin of plugins.filter(plugin => plugin.status === 'active')) {
      for (const item of features(plugin)) available.set(item.key, item);
    }
    const visible = [...pins].map(id => available.get(id)).filter(Boolean);
    keyedList(nav, visible, item => item.key, item => h('a', {
      class: 'nav__item', href: item.route, onclick: e => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault(); openFeature(item);
      },
    }, item.label));
    nav.hidden = visible.length === 0;
    if (!drawer) return;
    keyedList(shortcuts, visible, item => item.key, item => Button({ label: item.label, size: 'sm', onClick: () => openFeature(item) }));
    shortcuts.hidden = !visible.length;
    if (!plugins.length) {
      replace(list, h('p', { role: 'status' }, loadError || (snapshot ? '暂无已安装插件' : '正在读取插件…')));
      list._keyed = undefined;
      return;
    }
    const query=search.value.trim().toLowerCase();
    const matches=plugins.filter(p=>[p.name,p.id,descriptions[p.id]].join(' ').toLowerCase().includes(query));
    if (!matches.some(p=>p.id===selected)) selected=matches[0]?.id;
    keyedList(menu,matches,p=>p.id,p=>h('button',{type:'button','aria-pressed':String(selected===p.id),onclick:()=>{selected=p.id;paint();}},
      h('strong',{},systemText(p.name)),h('small',{},status[p.status]?.[0] ?? p.status)),p=>JSON.stringify([selected===p.id,p.name,p.status]));
    if (!matches.length) { replace(list,h('p',{},'没有匹配的插件')); return; }
    keyedList(list, matches.filter(p=>p.id===selected), p => p.id, plugin => {
      const entries = features(plugin);
      return h('section', { class: 'plugin-section', 'aria-label': systemText(plugin.name) },
        h('div', { class: 'row' }, h('strong', null, systemText(plugin.name)), Pill(...(status[plugin.status] ?? ['未知', ''])),
          Button({ size: 'sm', label: plugin.enabled ? '停用' : '启用', onClick: async () => {
            await api.post('/plugins/' + encodeURIComponent(plugin.id), { enabled: !plugin.enabled });
            await store.refresh();
            if (store.view.loadError) throw new Error(store.view.loadError);
          } })),
        h('p',{},descriptions[plugin.id] ?? (entries.length ? '提供以下工作台功能：'+entries.map(e=>e.label).join('、') : '此插件由执行环境提供，已声明的能力见下方。')),
        h('code',{class:'small muted'},plugin.id),
        preferenceEditor(plugin.id),
        plugin.id === 'shortcut-settings' && Button({ label: '快捷键设置', disabled: plugin.status !== 'active', onClick: () => openShortcutSettings(store) }),
        plugin.id === 'start-page' && startPageEditor({ api, store }, snapshot.startPage, startPages(plugins)),
        plugin.id === 'saved-prompts' && Button({ label: '管理常用提示词', size: 'sm', disabled: plugin.status !== 'active',
          onClick: () => openSavedPrompts({ api, store }) }),
        plugin.capabilities?.length > 0 && h('details', null, h('summary', { class: 'small' }, '查看插件声明的能力'), h('ul', null, plugin.capabilities.map(name => h('li', null, name)))),
        plugin.error && h('p', { class: 'small' }, plugin.error),
        entries.map(item => h('div', { class: 'row' },
          Button({ label: item.label, size: 'sm', disabled: !available.has(item.key), onClick: () => openFeature(item) }),
          plugin.id === 'token-statistics' ? h('label', null, h('input', { type: 'checkbox', checked: rightPinned, onchange: e => {
            rightPinned = e.target.checked; writeLocal('sm.tokenStats.right',rightPinned); paint();
          } }), ' 固定到右侧') : h('label', null, h('input', { type: 'checkbox', checked: pins.has(item.key), onchange: e => {
            if (e.target.checked) pins.add(item.key); else pins.delete(item.key);
            writeLocal(key, [...pins]); paint();
          } }), ' 固定到侧边栏'))));
    }, plugin => JSON.stringify([plugin, features(plugin).map(item => pins.has(item.key)), plugin.id === 'start-page' && [snapshot.startPage, startPages(plugins)]]));
  }
  function open(pluginId) {
    if (typeof pluginId === 'string') { selected = pluginId; search.value = ''; }
    if (drawer?.el.open) return;
    drawer = openDrawer({ title: '插件配置', wide:true, subtitle: '选择插件，查看用途并调整设置。启停影响整个工作台。', body: [shortcuts, layout], onClose: () => { drawer = undefined; } });
    drawer.el.classList.add('settings-dialog');
    paint();
  }
  const footer = h('footer', { class: 'plugin-footer' }, Button({ label: '插件配置', size: 'sm', onClick: open }));
  store.subscribe(paint);
  paint();
  return { nav, footer, open, right };
}
