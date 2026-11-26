// 电脑详情里的资源：处理器和内存现在多忙，以及最近十五分钟的变化。只在主人点开时读，
// 读的是执行机那边的计数器。
import { h, replace } from '../lib/dom.js';
import { Button, Pill } from '../ui/kit.js';
import { sizeText } from './machine-storage.js';

/** Nearly full is worth a look before it is full. */
function toneOf(percent) {
  if (percent >= 90) return 'danger';
  if (percent >= 75) return 'warn';
  return 'ok';
}

/** A number from 0 to 100 that the page can draw, or null when it is not one. */
function share(value) {
  return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null;
}

/** One sample as it is checked: it must say when it was taken and how busy things were. */
function checked(value) {
  if (!value || typeof value !== 'object' || typeof value.at !== 'string' || Number.isNaN(Date.parse(value.at))) return null;
  return { at: value.at, cpu: share(value.cpuPercent), memory: share(value.memoryPercent) };
}

/** The last fifteen minutes as a line for each of processor and memory. It is drawn with the
 *  document's own elements, so that it takes no library and works in the dark theme. */
function trend(samples, key, label) {
  const points = samples.filter(sample => sample[key] !== null);
  if (points.length < 2) return h('p', { class: 'muted small' }, label + '的变化要再读几次才有。');
  const width = 100, height = 28;
  // Each point is placed by when it was taken across the window, and by how busy it was.
  const first = Date.parse(samples[0].at), last = Date.parse(samples.at(-1).at);
  const span = Math.max(last - first, 1);
  const path = points.map((sample, index) => (index ? 'L' : 'M') + ((Date.parse(sample.at) - first) / span * width).toFixed(2) + ',' + (height - sample[key] / 100 * height).toFixed(2)).join(' ');
  const most = Math.max(...points.map(sample => sample[key]));
  const area = path + ' L' + width + ',' + height + ' L0,' + height + ' Z';
  return h('div', { class: 'resource-trend', role: 'img', 'aria-label': label + '最近十五分钟最高 ' + most + '%' },
    h('svg', { viewBox: '0 0 ' + width + ' ' + height, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      h('path', { d: area, class: 'resource-trend__area' }),
      h('path', { d: path, class: 'resource-trend__line' })),
    h('span', { class: 'small muted' }, label + ' · 最高 ' + most + '%'));
}

/** The resources of one computer, read when the owner asks for them. */
export function machineResources({ api, machine, active, online }) {
  const result = h('div', { class: 'stack small', role: 'status' });
  const supported = machine.capabilities?.includes('machine.resources');
  const canRead = () => supported === true && online() === true;
  let reading = false;
  const button = Button({ label: '查看资源', size: 'sm', disabled: !canRead(), onClick: async () => {
    if (!active() || reading) return;
    reading = true;
    button.disabled = true;
    if (!result.childElementCount) replace(result, h('p', { class: 'muted small' }, '正在读取这台电脑的处理器和内存…'));
    try {
      const data = await api.get('/machines/resources?machineId=' + encodeURIComponent(machine.id));
      if (!active()) return;
      if (data?.machineId !== machine.id || data?.supported !== true || !Array.isArray(data.samples)) { replace(result, h('p', { class: 'text-danger small' }, '读到的结果和这台电脑对不上，资源状态未知。')); return; }
      const samples = data.samples.map(checked).filter(Boolean);
      const memory = share(data.memory?.usedPercent);
      const at = new Date(data.at).toLocaleString('zh-CN', { hour12: false });
      const load = Array.isArray(data.load) ? data.load.map(value => Number.isFinite(value) ? value.toFixed(2) : null) : [];
      const uptime = Number.isSafeInteger(data.uptimeSeconds) && data.uptimeSeconds >= 0 ? data.uptimeSeconds : null;
      replace(result,
        h('div', { class: 'row row--between row--wrap' },
          h('span', null, '处理器 ', h('strong', null, typeof data.cpus === 'number' ? data.cpus + ' 核' : '未知'), load.some(value => value !== null) ? h('span', { class: 'muted small' }, ' · 负载 ' + load.filter(value => value !== null).join(' / ')) : null),
          h('span', null, '内存 ', h('strong', null, memory === null ? '未知' : memory + '%'), h('span', { class: 'muted small' }, ' · ' + sizeText(data.memory?.totalBytes - data.memory?.freeBytes) + ' / ' + sizeText(data.memory?.totalBytes))),
        h('p', { class: 'small muted' }, '运行了 ' + (uptime === null ? '未知' : durationText(uptime)) + '。读取于 ' + at + '。'),
        trend(samples, 'cpu', '处理器'), trend(samples, 'memory', '内存')));
    } catch (error) {
      const why = { 503: '这台电脑的代理离线，资源状态未知。', 409: '代理缺少资源读取，请升级执行机代理。', 404: '服务端或代理版本太旧，请升级。' }[error?.status]
        || '读取失败或超时，资源状态未知。';
      if (active()) replace(result, h('p', { class: 'text-danger small' }, why));
    } finally { reading = false; if (active()) button.disabled = !canRead(); }
  } });
  replace(result, h('p', { class: 'muted small' }, supported ? '尚未读取。' : '旧代理缺少资源读取，请升级执行机代理。'));
  const el = h('section', { class: 'stack', id: 'machine-resources' }, h('h3', null, '资源'), button, result);
  return { el, update() { if (active()) button.disabled = !canRead() || reading; } };
}

/** How long a computer has been up, in the units a person reads. */
function durationText(seconds) {
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return days ? days + ' 天 ' + hours + ' 小时' : hours ? hours + ' 小时 ' + minutes + ' 分钟' : minutes + ' 分钟';
}

/** The tone of a share, for the pill next to it. */
export function resourceTone(percent) {
  return percent === null ? '' : toneOf(percent);
}
