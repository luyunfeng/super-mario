// 高级：插件、插件文件、后台事件、界面、诊断。通常不用动，默认全部折叠。
import {openAssistantCardExamples} from './assistant-card-examples.js';
import { h, replace, svg } from '../lib/dom.js';
import { renderDiffLines } from './code-sidebar.js';
import { Button, Fold, Pill, Check, copyText } from '../ui/kit.js';
import { hintsEnabled, setHintsEnabled } from '../ui/hint.js';
import { createAgentArtifactsUI } from '../legacy/agent-artifacts.js';
import { createBackgroundPage } from '../legacy/background-page.js';
const node = (tag, text, className) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (className) value.className = className; return value; };

function extensionPatch(text) {
  const status = h('span',{role:'status'});
  const copy = Button({label:'复制补丁',size:'sm',onClick:async () => {
    try { await copyText(text); status.textContent = '已复制补丁'; }
    catch (error) { status.textContent = '复制失败：' + error.message; }
  }});
  return h('div',{class:'stack'},h('pre',{class:'code-sidebar__text',tabIndex:0},h('code',{},renderDiffLines(text))),
    h('div',{class:'row'},copy,status));
}

function shareChart(card) {
  const max = card.points.reduce((largest, point) => Math.max(largest, point.value), 0);
  const weights = card.points.map(point => max ? Math.max(point.value, 0) / max : 0);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const stops = [];
  let end = 0;
  const rows = card.points.map((point, index) => {
    const share = total ? weights[index] / total : 0;
    const color = 'hsl(' + (index * 137.5 % 360) + ' 50% 46%)';
    if (share > 0) {
      const start = end;
      end += share * 100;
      stops.push(color + ' ' + start + '%', color + ' ' + end + '%');
    }
    const percent = share > 0 && share < 0.01 ? '<1%' : Math.round(share * 1000) / 10 + '%';
    return h('tr',{},h('th',{scope:'row'},h('span',{'aria-hidden':'true',style:{color}},'● '),point.label),
      h('td',{},point.value),h('td',{},percent));
  });
  const graph = h('div',{'aria-hidden':'true',style:{width:'120px',height:'120px',borderRadius:'50%',
    background:stops.length ? 'conic-gradient(' + stops.join(',') + ')' : 'var(--line)',
    maskImage:card.kind === 'donut' ? 'radial-gradient(circle, transparent 38%, black 39%)' : 'none'}});
  return h('div',{class:'stack'},graph,h('table',{class:'table','aria-label':card.title},
    h('thead',{},h('tr',{},['项目','数值','占比'].map(label=>h('th',{scope:'col'},label)))),h('tbody',{},rows)));
}

function candleChart(card) {
  if (!Array.isArray(card.points) || !card.points.length) return;
  const candles = [];
  let low = Infinity, high = -Infinity, maxVolume = 0;
  for (const p of card.points) {
    if (!p || typeof p.label !== 'string') return;
    const close = p.close === undefined ? p.value : p.close;
    if (![p.low,p.open,close,p.high].every(Number.isFinite) || p.low > Math.min(p.open,close) ||
        p.high < Math.max(p.open,close) || (p.volume !== undefined && (!Number.isFinite(p.volume) || p.volume < 0))) return;
    candles.push({...p,close});
    low = Math.min(low,p.low);
    high = Math.max(high,p.high);
    maxVolume = Math.max(maxVolume,p.volume ?? 0);
  }
  const scale = Math.max(Math.abs(low),Math.abs(high)) || 1;
  const y = price => high === low ? 42 : 80 - 76 * ((price / scale - low / scale) / (high / scale - low / scale));
  const marks = [], rows = [];
  const step = 300 / candles.length;
  candles.forEach((p,i) => {
    const x = (i + 0.5) * step, width = step * 0.6;
    const color = p.close >= p.open ? 'var(--ok, currentColor)' : 'var(--danger)';
    marks.push(['line',{x1:x,x2:x,y1:y(p.high),y2:y(p.low),stroke:color}],
      ['rect',{x:x-width/2,y:Math.min(y(p.open),y(p.close)),width,height:Math.max(1,Math.abs(y(p.open)-y(p.close))),fill:color}]);
    if (maxVolume && p.volume > 0) {
      const height = 16 * (p.volume / maxVolume);
      marks.push(['rect',{x:x-width/2,y:100-height,width,height,fill:color,opacity:0.5}]);
    }
    rows.push(h('tr',{},h('th',{scope:'row'},p.label),[p.open,p.high,p.low,p.close,p.volume ?? '—'].map(v=>h('td',{},v))));
  });
  const graph = svg(marks);
  graph.setAttribute('viewBox','0 0 300 100');
  graph.setAttribute('height','120');
  return h('div',{class:'stack'},graph,h('table',{class:'table','aria-label':card.title},
    h('thead',{},h('tr',{},['项目','开盘','最高','最低','收盘','成交量'].map(v=>h('th',{scope:'col'},v)))),h('tbody',{},rows)));
}

function extensionChart(card) {
  if (card.kind === 'candlestick') return candleChart(card);
  const points = card.points;
  if (!['bar','line','area','pie','donut'].includes(card.kind) || !Array.isArray(points) || !points.length ||
      !points.every(point => typeof point?.label === 'string' && Number.isFinite(point.value))) return;
  if (card.kind === 'pie' || card.kind === 'donut') return shareChart(card);
  const scale = points.reduce((max, point) => Math.max(max, Math.abs(point.value)), 0) || 1;
  const low = points.reduce((min, point) => Math.min(min, point.value / scale), 0);
  const high = points.reduce((max, point) => Math.max(max, point.value / scale), 0);
  const y = value => 96 - 92 * (value / scale - low) / (high - low || 1);
  const width = 300 / points.length;
  const baseline = y(0);
  const marks = [['line',{x1:0,x2:300,y1:baseline,y2:baseline,stroke:'currentColor'}]];
  if (card.kind === 'bar') {
    points.forEach((point, index) => marks.push(['rect', {x:(index + 0.15) * width, width:width * 0.7,
      y:Math.min(baseline, y(point.value)), height:Math.abs(baseline - y(point.value)), fill:'currentColor'}]));
  } else {
    const x = index => (index + 0.5) * width;
    const path = points.map((point, index) => x(index) + ',' + y(point.value)).join(' ');
    if (card.kind === 'area') marks.push(['polygon', {points:x(0)+','+baseline+' '+path+' '+x(points.length-1)+','+baseline,
      fill:'currentColor', opacity:0.2}]);
    marks.push(['polyline', {points:path, fill:'none', stroke:'currentColor', 'stroke-width':2}]);
    if (points.length === 1) marks.push(['circle', {cx:x(0), cy:y(points[0].value), r:3, fill:'currentColor'}]);
  }
  const graph = svg(marks);
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

  let cardSignature;
  function paint(snapshot) {
    examplesButton.hidden=!snapshot.webExtensions?.some(entry=>entry.value?.slot==='advanced-interface' && entry.value.renderer==='assistant-card-examples');
    if(examplesButton.hidden){examplesDrawer?.close();examplesDrawer=undefined;}
    paintCards(snapshot.webExtensions ?? []);
    const setup = snapshot.setup ?? {};
    replace(setupList, [['配置 Agent', setup.agent], ['新建项目', setup.project], ['添加记忆', setup.memory], ['连接飞书', setup.channel]].map(([name, value]) =>
      h('div', { class: 'row row--between' }, h('span', null, name), value === true || value === 'done' ? Pill('已完成', 'ok') : value === 'skipped' ? Pill('已跳过') : Pill('未完成', 'warn'))));
    replace(diag,
      h('dt', null, '版本'), h('dd', null, snapshot.version),
      h('dt', null, '运行模式'), h('dd', null, snapshot.mode === 'demo' ? '演示' : '正式'),
      (snapshot.problems ?? []).map(item => [h('dt', null, item.area === 'agent' ? 'Agent' : '渠道'), h('dd', null, `${item.message}。${item.fix}`)]));
  }

  function paintCards(extensions) {
    const entries = extensions.filter(({value}) => value?.slot === 'advanced-interface' && value.renderer !== 'assistant-card-examples');
    const signature = JSON.stringify(entries);
    if (signature === cardSignature) return;
    cardSignature = signature;
    const cards = [];
    for (const {value} of entries) {
      const patch = value.renderer === 'diff' && typeof value.patch === 'string' && value.patch;
      const fallback = typeof value.fallback === 'string' && value.fallback;
      if (typeof value.title !== 'string') continue;
      const content = patch ? extensionPatch(patch) : value.renderer === 'chart' && extensionChart(value);
      if (!content && !fallback) continue;
      cards.push(h('section', {class:'card card__body stack', 'aria-label':value.title},
        h('h3', {}, value.title), content || h('p', {}, fallback)));
    }
    replace(extensionCards, cards);
    extensionCards.hidden = !cards.length;
  }

  return { el, update: paint };
}
