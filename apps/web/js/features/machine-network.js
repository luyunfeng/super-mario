// 电脑详情里的网络：它有哪些地址、在监听哪些端口、到域名服务器通不通。只在主人点开时读。
import { h, replace } from '../lib/dom.js';
import { Button, Pill } from '../ui/kit.js';

/** An address or a port as it is checked: it must be what it says, and nothing more is shown. */
function text(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : '';
}

/** The ports as rows, grouped by the process that holds them where that is known. */
function portRows(ports, processesKnown) {
  const sorted = ports.slice().sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol) || a.address.localeCompare(b.address));
  const rows = sorted.map(port => h('li', { class: 'item' },
    h('div', { class: 'item__main' },
      h('div', { class: 'row row--between row--wrap' },
        h('span', { class: 'item__title' }, port.address + ':' + port.port, h('span', { class: 'muted small' }, ' · ' + port.protocol)),
        h('span', { class: 'row' }, port.processName ? Pill(port.processName + (port.pid ? ' · ' + port.pid : '')) : Pill(processesKnown ? '进程未知' : '进程读不到', processesKnown ? '' : 'warn'))))));
  // Most computers listen on a few dozen ports. More than that is shown in full, in a list that scrolls.
  return h('ol', { class: 'list', 'aria-label': '监听端口' }, ...rows);
}

/** The network of one computer, read when the owner asks for it. */
export function machineNetwork({ api, machine, active, online }) {
  const result = h('div', { class: 'stack small', role: 'status' });
  const supported = machine.capabilities?.includes('machine.network');
  const canRead = () => supported === true && online() === true;
  let reading = false;
  const button = Button({ label: '查看网络', size: 'sm', disabled: !canRead(), onClick: async () => {
    if (!active() || reading) return;
    reading = true;
    button.disabled = true;
    if (!result.childElementCount) replace(result, h('p', { class: 'muted small' }, '正在读取这台电脑的网络…'));
    try {
      const data = await api.get('/machines/network?machineId=' + encodeURIComponent(machine.id));
      if (!active()) return;
      if (data?.machineId !== machine.id || data?.supported !== true || !Array.isArray(data.ports)) { replace(result, h('p', { class: 'text-danger small' }, '读到的结果和这台电脑对不上，网络状态未知。')); return; }
      const addresses = (Array.isArray(data.addresses) ? data.addresses : []).map(value => ({
        name: text(value?.name, 64), address: text(value?.address, 64), family: value?.family === 'IPv6' ? 'IPv6' : 'IPv4',
      })).filter(value => value.address);
      const ports = data.ports.map(value => ({
        protocol: ['tcp', 'tcp6', 'udp', 'udp6'].includes(value?.protocol) ? value.protocol : 'tcp',
        address: text(value?.address, 64), port: Number.isSafeInteger(value?.port) && value.port >= 0 && value.port <= 65535 ? value.port : null,
        pid: Number.isSafeInteger(value?.pid) && value.pid > 0 ? value.pid : null,
        processName: text(value?.processName, 128),
      })).filter(value => value.port !== null);
      const probes = (Array.isArray(data.probes) ? data.probes : []).map(value => ({
        host: text(value?.host, 128), ok: value?.ok === true,
        ms: Number.isFinite(value?.ms) && value.ms >= 0 ? Math.round(value.ms) : null,
        error: text(value?.error, 160),
      })).filter(value => value.host);
      const at = new Date(data.at).toLocaleString('zh-CN', { hour12: false });
      replace(result,
        h('p', { class: 'small' }, '地址 ', addresses.length ? addresses.map(value => value.name + ' ' + value.address).join('，') : '未读到'),
        h('div', { class: 'stack' },
          h('strong', { class: 'small' }, '到域名服务器'),
          probes.length ? h('ul', { class: 'list' }, probes.map(probe => h('li', { class: 'item' },
            h('div', { class: 'row row--between row--wrap' }, h('span', null, probe.host),
              probe.ok ? Pill(probe.ms + ' 毫秒', probe.ms > 500 ? 'warn' : 'ok') : Pill('不通', 'danger'))))) : h('p', { class: 'muted small' }, '没有可探测的域名服务器。')),
        h('div', { class: 'stack' }, h('strong', { class: 'small' }, '监听端口 · ' + ports.length),
          ports.length ? portRows(ports, data.processesKnown === true) : h('p', { class: 'muted small' }, '没有在监听的端口。')),
        h('p', { class: 'muted small' }, data.processesKnown === true ? '' : '别的用户的进程读不到，这些端口只显示地址和端口。', '读取于 ' + at + '。只读本机的表，不向外网发探测。'));
    } catch (error) {
      const why = { 503: '这台电脑的代理离线，网络状态未知。', 409: '代理缺少网络读取，请升级执行机代理。', 404: '服务端或代理版本太旧，请升级。' }[error?.status]
        || '读取失败或超时，网络状态未知。';
      if (active()) replace(result, h('p', { class: 'text-danger small' }, why));
    } finally { reading = false; if (active()) button.disabled = !canRead(); }
  } });
  replace(result, h('p', { class: 'muted small' }, supported ? '尚未读取。' : '旧代理缺少网络读取，请升级执行机代理。'));
  const el = h('section', { class: 'stack', id: 'machine-network' }, h('h3', null, '网络'), button, result);
  return { el, update() { if (active()) button.disabled = !canRead() || reading; } };
}
