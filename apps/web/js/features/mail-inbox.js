// 一条邮件收件的正文。经工作台从主人的邮箱读取，只读，不把邮件标记为已读。
import { h, replace } from '../lib/dom.js';

const time = value => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '';
};
const named = address => address?.name ? `${address.name} <${address.email}>` : address?.email ?? '';
const list = addresses => Array.isArray(addresses) && addresses.length ? addresses.map(named).join('、') : '';

/** `row` is the inbox item as stored. It is read once per item, when its detail opens. */
export function mailInboxBody(api, row) {
  const root = h('div', { class: 'stack', 'aria-label': '邮件正文' });
  const target = row?.origin?.mail;
  if (!target) return { el: root };
  let loaded = null, busy = false, seq = 0, error = '';
  const body = h('div', { class: 'stack' });
  root.append(body);
  async function load() {
    const stamp = ++seq;
    busy = true; error = '';
    paint();
    try {
      // The item is all the page needs to name: the mailbox and the message come from it.
      const value = await api.get('/mail/inbox/' + encodeURIComponent(row.id));
      if (stamp !== seq) return;
      loaded = value;
    } catch (cause) {
      if (stamp !== seq) return;
      error = cause.message;
    } finally { busy = false; if (stamp === seq) paint(); }
  }
  function paint() {
    replace(body,
      busy && !loaded ? h('p', { class: 'small muted' }, '正在从邮箱读取…') : null,
      error ? h('p', { class: 'small', role: 'alert' }, '无法读取这封邮件：' + error, ' ',
        h('button', { type: 'button', class: 'btn btn--sm', onClick: () => { void load(); } }, '重试')) : null,
      loaded && [
        h('dl', { class: 'kv' },
          h('dt', null, '发件人'), h('dd', null, named(loaded.from)),
          h('dt', null, '收件人'), h('dd', null, list(loaded.to) || '未显示'),
          ...(loaded.cc?.length ? [h('dt', null, '抄送'), h('dd', null, list(loaded.cc))] : []),
          h('dt', null, '时间'), h('dd', null, h('time', { dateTime: loaded.date }, time(loaded.date) || '未知'))),
        // The text is put in as text. Nothing in an email is rendered as markup.
        loaded.text
          ? h('pre', { class: 'mailbox-content' }, loaded.text)
          : h('p', { class: 'small muted' }, '这封邮件没有可读的文字。'),
        loaded.textTruncated && h('p', { class: 'small muted' }, '正文太长，这里只有开头部分。'),
        Array.isArray(loaded.attachments) && loaded.attachments.length
          ? h('div', { class: 'stack' }, h('strong', { class: 'small' }, '附件'),
            loaded.attachments.map(file => h('li', { class: 'small' }, `${file.filename || '（没有文件名）'} · ${file.mimeType} · ${file.size} 字节`)),
            loaded.attachmentCount > loaded.attachments.length && h('p', { class: 'small muted' }, `共 ${loaded.attachmentCount} 个附件，这里只列出前 ${loaded.attachments.length} 个。`))
          : null,
      ]);
  }
  void load();
  // The same shape as the other bodies a detail shows: the element under el.
  return { el: root };
}
