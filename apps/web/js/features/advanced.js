// 高级：插件、插件文件、后台事件、界面、诊断。通常不用动，默认全部折叠。
import {openAssistantCardExamples} from './assistant-card-examples.js';
import { h, replace, svg } from '../lib/dom.js';
import { Button, Fold, Pill, Check } from '../ui/kit.js';
import { hintsEnabled, setHintsEnabled } from '../ui/hint.js';
import { createAgentArtifactsUI } from '../legacy/agent-artifacts.js';
import { createBackgroundPage } from '../legacy/background-page.js';
const node = (tag, text, className) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value; };

function barChart(card) {
  const points = card.points;
  if (card.kind !== 'bar' || !Array.isArray(points) || !points.length ||
      !points.every(point => typeof point?.label === 'string' && Number.isFinite(point.value))) return;
  const scale = points.reduce((max, point) => Math.max(max, Math.abs(point.value)), 0) || 1;
  const low = points.reduce((min, point) => Math.min(min, point.value / scale), 0);
  const high = points.reduce((max, point) => Math.max(max, point.value / scale), 0);
  const y = value => 96 - 92 * (value / scale - low) / (high - low || 1);
  const width = 300 / points.length;
  const marks = points.map((point, index) => ['rect', {x:(index + 0.15) * width, width:width * 0.7,
    y:Math.min(y(0), y(point.value)), height:Math.abs(y(0) - y(point.value)), fill:'currentColor'}]);
  const graph = svg([['line',{x1:0,x2:300,y1:y(0),y2:y(0),stroke:'currentColor'}], ...marks]);
  graph.setAttribute('viewBox','0 0 300 100');
  graph.setAttribute('height','120');
  return h('div',{class:'stack'}, graph, h('table',{class:'table','aria-label':card.title},
    h('thead',{},h('tr',{},h('th',{scope:'col'},'项目'),h('th',{scope:'col'},'数值'))),
    h('tbody',{},points.map(point => h('tr',{},h('th',{scope:'row'},point.label),h('td',{},point.value))))));
}

export function createAdvanced({ api, store, router, openPluginSettings }) {
  const plugins = openPluginSettings && Button({ label: '打开插件配置', size: 'sm', onClick: openPluginSettings });

  const artifactsHost = h('div', { class: 'legacy' });
  let artifacts;
  const files = Fold({ title: '插件文件', body: artifactsHost, onOpen: () => { artifacts = createAgentArtifactsUI({ api, element: artifactsHost, onChanged: () => store.refresh() }); artifacts.open(); } });

  const backgroundHost = h('div', { class: 'legacy' });
  let background;
  const events = Fold({ title: '后台事件与发件箱', body: backgroundHost, onOpen: () => { background = createBackgroundPage({ api, element: node, root: backgroundHost }); background.load?.(); } });

  const hintsToggle = Check({ label: '显示每个功能右上角的作用说明', checked: hintsEnabled(), onChange: setHintsEnabled });
  const setupList = h('div', { class: 'stack' });
  const extensionCards = h('div', {class:'stack'});
  let examplesDrawer;
  const examplesButton=Button({label:'助理卡片示例',size:'sm',onClick:()=>{examplesDrawer=openAssistantCardExamples();}});
  examplesButton.hidden=true;
  const ui = Fold({ title: '界面', body: [hintsToggle,
    examplesButton, extensionCards,
    Button({ label: '预览开屏', size: 'sm', onClick: () => window.dispatchEvent(new CustomEvent('workspace:preview-splash')) }),
    Button({ label: '设置记忆整理 Agent', size: 'sm', onClick: () => router.go(`${router.href('memory')}?curator=1`) }),
    h('div', { class: 'stack' }, h('h3', null, '入门进度'), setupList)] });

  const diag = h('dl', { class: 'kv' });
  const diagnostics = Fold({ title: '诊断', body: diag });

  const el = h('details', { class: 'fold', id: 'agent-advanced' },
    h('summary', null, '高级：插件与排查'),
    h('div', { class: 'fold__body' }, plugins, h('a',{class:'btn btn--sm',href:'/admin.html'},'管理员登录'), files, events, ui, diagnostics));

  function paint(snapshot) {
    examplesButton.hidden=!snapshot.webExtensions?.some(entry=>entry.value?.slot==='advanced-interface' && entry.value.renderer==='assistant-card-examples');
    if(examplesButton.hidden){examplesDrawer?.close();examplesDrawer=undefined;}
    const cards = [];
    for (const {value} of snapshot.webExtensions ?? []) {
      if (value?.slot !== 'advanced-interface' || value.renderer === 'assistant-card-examples') continue;
      const patch = value.renderer === 'diff' && typeof value.patch === 'string' && value.patch;
      const fallback = typeof value.fallback === 'string' && value.fallback;
      if (typeof value.title !== 'string') continue;
      const content = patch ? h('pre', {}, h('code', {}, patch)) : value.renderer === 'chart' && barChart(value);
      if (!content && !fallback) continue;
      cards.push(h('section', {class:'card card__body stack', 'aria-label':value.title},
        h('h3', {}, value.title), content || h('p', {}, fallback)));
    }
    replace(extensionCards, cards);
    extensionCards.hidden = !cards.length;
    const setup = snapshot.setup ?? {};
    replace(setupList, [['配置 Agent', setup.agent], ['新建项目', setup.project], ['添加记忆', setup.memory], ['连接飞书', setup.channel]].map(([name, value]) =>
      h('div', { class: 'row row--between' }, h('span', null, name), value === true || value === 'done' ? Pill('已完成', 'ok') : value === 'skipped' ? Pill('已跳过') : Pill('未完成', 'warn'))));
    replace(diag,
      h('dt', null, '版本'), h('dd', null, snapshot.version),
      h('dt', null, '运行模式'), h('dd', null, snapshot.mode === 'demo' ? '演示' : '正式'),
      (snapshot.problems ?? []).map(item => [h('dt', null, item.area === 'agent' ? 'Agent' : '渠道'), h('dd', null, `${item.message}。${item.fix}`)]));
  }

  return { el, update: paint };
}
