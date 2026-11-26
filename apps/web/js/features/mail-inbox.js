// 一条邮件收件的正文。经工作台从主人的邮箱读取，只读，不把邮件标记为已读。
import { h, replace } from '../lib/dom.js';
import { Button } from '../ui/kit.js';
import { openMailReply } from './mail-reply.js';

const time = value => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '';
};
const named = address => address?.name ? `${address.name} <${address.email}>` : address?.email ?? '';
const list = addresses => Array.isArray(addresses) && addresses.length ? addresses.map(named).join('、') : '';

/** `row` is the inbox item as stored. It is read once per item, when its detail opens. */
/** The account a message is in, as the page needs it to reply from it. */
async function accountOf(api, id) {
  const state = await api.get('/mail/accounts');
  return state.find(entry => entry.account.id === id)?.account;
}

export function mailInboxBody(api, row) {
  const root = h('div', { class: 'stack', 'aria-label': '邮件正文' });
  const target = row?.origin?.mail;
  if (!target) return { el: root };
  let loaded = null, busy = false, seq = 0, error = '', proposed = false, account = null;
  let downloading = '';
  let marking = false;
  const downloadNote = h('p', { class: 'small', role: 'status' });
  const flagNote = h('p', { class: 'small', role: 'status' });
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
      // The account is needed only to reply. When it cannot be read the message is still
      // shown, and the reply is not offered.
      account = await accountOf(api, target.account).catch(() => null);
      // Opening a message is reading it, so it is marked as read. Reading itself never marks
      // it: this is a separate change, made because the owner opened it. When it cannot be
      // made the message is still shown.
      if (value.seen === false) void markFlag({ seen: true }, true);
    } catch (cause) {
      if (stamp !== seq) return;
      error = cause.message;
    } finally { busy = false; if (stamp === seq) paint(); }
  }
  /** The name a file is saved under: the name it came with, without anything that could
   *  stand for a folder or a drive, because the name is the sender's and not the owner's. */
  function saveName(name) {
    const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
    const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned.slice(0, 200) : 'attachment';
  }

  /** Takes one attachment out and offers it to be saved. The file comes back with the
   *  token, as every other request does, so the token is never put in a link. */
  async function download(file) {
    if (downloading) return;
    downloading = file.id; downloadNote.textContent = '正在下载…';
    paint();
    try {
      const blob = await api.blob('/mail/inbox/' + encodeURIComponent(row.id) + '/attachments/' + encodeURIComponent(file.id));
      const url = URL.createObjectURL(blob);
      const link = h('a', { href: url, download: saveName(file.filename) });
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      downloadNote.textContent = '';
    } catch (cause) {
      downloadNote.textContent = '下载失败：' + cause.message;
    } finally { downloading = ''; paint(); }
  }

  /** Changes one of the two flags the owner can change. `quiet` is for the one made by
   *  opening the message, which is not something the owner asked to see confirmed. */
  async function markFlag(change, quiet) {
    if (marking) return;
    marking = true; flagNote.textContent = '';
    try {
      await api.post('/mail/inbox/' + encodeURIComponent(row.id) + '/flags', change);
      if (loaded) Object.assign(loaded, change);
    } catch (cause) {
      if (!quiet) flagNote.textContent = '没有改动标记：' + cause.message;
    } finally { marking = false; paint(); }
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
        // The two marks the owner can change. Opening the message has already marked it read,
        // so the first of these puts that back.
        h('div', { class: 'row row--wrap' },
          Button({ label: loaded.seen ? '标为未读' : '标为已读', size: 'sm', kind: 'ghost', disabled: marking,
            onClick: () => { void markFlag({ seen: !loaded.seen }); } }),
          Button({ label: loaded.flagged ? '取消星标' : '加星标', size: 'sm', kind: 'ghost', disabled: marking,
            onClick: () => { void markFlag({ flagged: !loaded.flagged }); } }),
          // Said only when there is something to say, so that an empty status is not read out.
          flagNote.textContent ? flagNote : null),
        // The text is put in as text. Nothing in an email is rendered as markup.
        loaded.text
          ? h('pre', { class: 'mailbox-content' }, loaded.text)
          : h('p', { class: 'small muted' }, '这封邮件没有可读的文字。'),
        loaded.textTruncated && h('p', { class: 'small muted' }, '正文太长，这里只有开头部分。'),
        Array.isArray(loaded.attachments) && loaded.attachments.length
          ? h('div', { class: 'stack' }, h('strong', { class: 'small' }, '附件'),
            loaded.attachments.map(file => h('li', { class: 'small row row--between row--wrap' },
              h('span', null, `${file.filename || '（没有文件名）'} · ${file.mimeType} · ${file.size} 字节`),
              Button({ label: '下载', size: 'sm', kind: 'ghost', ariaLabel: '下载附件 ' + (file.filename || ''), disabled: downloading === file.id,
                onClick: () => { void download(file); } }))),
            downloadNote,
            loaded.attachmentCount > loaded.attachments.length && h('p', { class: 'small muted' }, `共 ${loaded.attachmentCount} 个附件，这里只列出前 ${loaded.attachments.length} 个。`))
          : null,
        // Replying asks for the send. It is an approval, and the mail goes out after it.
        account ? h('div', { class: 'row row--wrap' },
          Button({ label: '回复', size: 'sm', onClick: () => openMailReply({ api, account, message: loaded,
            onProposed: () => { proposed = true; paint(); } }) }),
          h('span', { class: 'small muted' }, '回复会先成为一张审批，你同意后才会发出。')) : null,
        proposed ? h('p', { class: 'small', role: 'status' }, '已提交审批，这封邮件还没有发出。', ' ',
          h('a', { class: 'small', href: '#chat/approvals' }, '前往审批')) : null,
      ]);
  }
  void load();
  // The same shape as the other bodies a detail shows: the element under el.
  return { el: root };
}
