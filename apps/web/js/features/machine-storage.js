// 电脑详情里的存储：每个挂载点用了多少。只在主人点开时读一次，读的是执行机那边的磁盘。
import { h, replace } from '../lib/dom.js';
import { Button, Pill } from '../ui/kit.js';

/** Bytes in the units a person reads. Nothing is shown past what is known. */
export function sizeText(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return (unit === 0 ? String(value) : value.toFixed(value >= 100 ? 0 : 1)) + ' ' + units[unit];
}

/** How full a mount is, as a whole percent. A mount that reports no size is not given one. */
export function usedPercent(mount) {
  if (!Number.isSafeInteger(mount?.totalBytes) || mount.totalBytes <= 0) return null;
  const used = Number.isSafeInteger(mount?.usedBytes) && mount.usedBytes >= 0 ? Math.min(mount.usedBytes, mount.totalBytes) : 0;
  return Math.round(used / mount.totalBytes * 100);
}

/** The tone of a mount by how full it is. Nearly full is worth a look before it is full. */
export function toneOf(percent) {
  if (percent === null) return '';
  if (percent >= 90) return 'danger';
  if (percent >= 75) return 'warn';
  return 'ok';
}

/** One mount as it is checked: it must say where it is and how big it is, in whole bytes. */
function checked(value) {
  if (!value || typeof value !== 'object' || typeof value.mount !== 'string' || !value.mount || value.mount.length > 512) return null;
  if (!Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0) return null;
  const used = Number.isSafeInteger(value.usedBytes) && value.usedBytes >= 0 ? Math.min(value.usedBytes, value.totalBytes) : null;
  const avail = Number.isSafeInteger(value.availBytes) && value.availBytes >= 0 ? value.availBytes : null;
  return {
    mount: value.mount,
    device: typeof value.device === 'string' && value.device.length <= 256 ? value.device : '',
    fsType: typeof value.fsType === 'string' && /^[a-z0-9]{1,16}$/.test(value.fsType) ? value.fsType : '',
    readOnly: value.readOnly === true,
    totalBytes: value.totalBytes, usedBytes: used, availBytes: avail,
    percent: usedPercent(value),
    inodesPercent: Number.isSafeInteger(value.inodesPercent) && value.inodesPercent >= 0 && value.inodesPercent <= 100 ? value.inodesPercent : null,
  };
}

/** A mount as one row: where, how full, and a bar that shows it. */
function row(mount) {
  const percent = mount.percent;
  const label = mount.device && mount.device !== mount.mount ? mount.mount + ' · ' + mount.device : mount.mount;
  const parts = [percent === null ? '用量未知' : '已用 ' + percent + '%',
    mount.usedBytes !== null && mount.availBytes !== null ? sizeText(mount.usedBytes) + ' / ' + sizeText(mount.totalBytes) + '，可用 ' + sizeText(mount.availBytes) : '大小 ' + sizeText(mount.totalBytes)];
  return h('li', { class: 'item' },
    h('div', { class: 'item__main' },
      h('div', { class: 'row row--between row--wrap' },
        h('span', { class: 'item__title' }, label, mount.fsType ? h('span', { class: 'muted small' }, ' · ' + mount.fsType) : null, mount.readOnly ? Pill('只读') : null),
        percent === null ? null : Pill(percent + '%', toneOf(percent))),
      percent === null ? null : h('div', { class: 'storage-bar', role: 'presentation' },
        h('span', { class: 'storage-bar__fill storage-bar__fill--' + toneOf(percent), style: { width: percent + '%' } })),
      h('span', { class: 'item__meta' }, parts.join('，'), mount.inodesPercent !== null && mount.inodesPercent >= 75 ? '，文件数已用 ' + mount.inodesPercent + '%' : '')));
}

/** The storage of one computer, read when the owner asks for it. The computer may go offline
 *  while its details are open, so update() is called as its state changes. */
export function machineStorage({ api, machine, active, online }) {
  const result = h('div', { class: 'stack small', role: 'status' });
  const supported = machine.capabilities?.includes('machine.storage');
  // Readable while the computer is online and its agent offers the reading.
  const canRead = () => supported === true && online() === true;
  const button = Button({ label: '查看存储', size: 'sm', disabled: !canRead(), onClick: async () => {
    if (!active()) return;
    button.disabled = true;
    replace(result, h('p', { class: 'muted small' }, '正在读取这台电脑的磁盘…'));
    try {
      const data = await api.get('/machines/storage?machineId=' + encodeURIComponent(machine.id));
      if (!active()) return;
      // The answer must be about the computer that was asked for.
      if (data?.machineId !== machine.id || data?.supported !== true || !Array.isArray(data.mounts)) { replace(result, h('p', { class: 'text-danger small' }, '读到的结果和这台电脑对不上，存储状态未知。')); return; }
      const mounts = data.mounts.map(checked).filter(Boolean);
      const at = typeof data.at === 'string' && !Number.isNaN(Date.parse(data.at)) ? new Date(data.at).toLocaleString('zh-CN', { hour12: false }) : '';
      replace(result,
        mounts.length ? h('ol', { class: 'list', 'aria-label': '磁盘用量' }, ...mounts.map(row)) : h('p', { class: 'muted small' }, '这台电脑没有报告能读取的磁盘。'),
        h('p', { class: 'muted small' }, at ? '读取于 ' + at + '。' : '', '按挂载点统计，不含临时文件系统和镜像文件。'));
    } catch (error) {
      // Each way it can go wrong is named, so that the owner knows what to do about it.
      const why = { 503: '这台电脑的代理离线，存储状态未知。', 409: '代理缺少存储读取，请升级执行机代理。', 404: '服务端或代理版本太旧，请升级。' }[error?.status]
        || '读取失败或超时，存储状态未知。';
      if (active()) replace(result, h('p', { class: 'text-danger small' }, why));
    } finally { if (active()) button.disabled = !canRead(); }
  } });
  replace(result, h('p', { class: 'muted small' }, supported ? '尚未读取。' : '旧代理缺少存储读取，请升级执行机代理。'));
  const el = h('section', { class: 'stack', id: 'machine-storage' }, h('h3', null, '存储'), button, result);
  return { el, update() { if (active()) button.disabled = !canRead(); } };
}
