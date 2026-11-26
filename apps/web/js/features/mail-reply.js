// 回复一封邮件。提交后是一张审批，主人看过并同意后才会发出；这里不直接发送。
import { h, replace } from '../lib/dom.js';
import { Button, Field, Input, TextArea } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

/** What was written and not sent, by the message it answers. It lives as long as the page. */
const kept = new Map();

/** The subject a reply carries: the one there is when it already says Re, and Re: before it
 *  when it does not. */
export function replySubject(subject) {
  return /^\s*re\s*[:：]/i.test(subject) ? subject : 'Re: ' + subject;
}

/** The text a reply starts with: who wrote what and when, and the first lines of it quoted. */
export function replyBody(message) {
  const quoted = String(message.text ?? '').split('\n').slice(0, 40).map(line => '> ' + line).join('\n');
  const when = message.date ? new Date(message.date).toLocaleString('zh-CN', { hour12: false }) : '';
  const who = message.from?.name || message.from?.email || '';
  const head = [when, who].filter(Boolean).join('，');
  return '\n\n' + (head ? `—— ${head} 写道\n` : '') + quoted;
}

/** The thread a reply belongs to: the one the message is in, and the message itself. */
export function replyReferences(message) {
  const own = message.messageId ? [message.messageId] : [];
  return [...new Set([...(message.references ?? []), ...own])];
}

/** Addresses as the owner writes them: one or more, with or without a name, separated by
 *  commas. An address with a comma in its name cannot be written this way and is left out,
 *  rather than guessed at. */
function addresses(value) {
  return String(value ?? '').split(/[,，\n]/).map(item => item.trim()).filter(Boolean).map(item => {
    const withName = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(item);
    if (withName) return { name: withName[1].replace(/^["']|["']$/g, '').trim(), email: withName[2] };
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item) ? { name: '', email: item } : null;
  }).filter(Boolean);
}

/**
 * Opens the reply to one message. `message` is what the detail read.
 *
 *  What is written is kept while the page lives: closing the drawer any way but Cancel keeps
 *  it, and opening the reply to the same message again brings it back. The submit only asks
 *  for the send, so the drawer says so and never says the mail was sent.
 */
export function openMailReply({ api, account, message, onProposed }) {
  const key = 'mail-reply:' + account.id + ':' + message.mailbox + ':' + message.uid;
  const saved = kept.get(key);
  const initial = {
    to: message.from?.email ?? '', cc: (message.cc ?? []).map(item => item.email).join(', '),
    subject: replySubject(message.subject ?? ''), text: replyBody(message),
  };
  const draft = saved ? { ...saved } : { ...initial };
  let proposing = false, failure = '';
  // Set when the reply is over on purpose, by a cancel or by being asked for. Closing after
  // that keeps nothing.
  let done = false;
  const note = h('div', { role: 'alert' });
  const submit = Button({ label: '提交审批', kind: 'primary', type: 'submit' });
  const drawer = openDrawer({
    title: '回复邮件', subtitle: `从 ${account.email} 发出`, wide: true,
    // Any way of closing but the Cancel button keeps what was written.
    onClose: () => { if (!done) kept.set(key, { ...draft }); },
    body: h('form', { class: 'stack', onsubmit: async event => {
      event.preventDefault();
      if (proposing) return;
      const to = addresses(draft.to), cc = addresses(draft.cc), bcc = addresses(draft.bcc);
      if (!to.length) { failure = '请填写至少一个收件人。'; paint(); return; }
      if (!draft.subject.trim() && !draft.text.trim()) { failure = '请填写主题或正文。'; paint(); return; }
      proposing = true; failure = ''; paint();
      try {
        const approval = await api.post('/mail/send', {
          account: account.id, to, cc, bcc, subject: draft.subject, text: draft.text,
          in_reply_to: message.messageId || undefined,
          references: replyReferences(message).length ? replyReferences(message).join(' ') : undefined,
        });
        // The send is only asked for. The words say so, because the owner approves it after.
        done = true;
        kept.delete(key);
        drawer.close();
        onProposed?.(approval);
      } catch (cause) {
        // What was written stays, so the owner can change something and ask again.
        failure = cause.message;
        kept.set(key, { ...draft });
      } finally { proposing = false; paint(); }
    } },
    h('p', { class: 'small muted' }, '提交后是一张审批。你看过并同意后，这封邮件才会发出。'),
    (() => { const field = Input({ value: draft.to, required: true, 'aria-label': '收件人', placeholder: 'name@example.com，多个用逗号分开' }); field.addEventListener('input', () => { draft.to = field.value; }); return Field({ label: '收件人', control: field, required: true }); })(),
    (() => { const field = Input({ value: draft.cc, 'aria-label': '抄送' }); field.addEventListener('input', () => { draft.cc = field.value; }); return Field({ label: '抄送', control: field }); })(),
    (() => { const field = Input({ value: draft.bcc, 'aria-label': '密送' }); field.addEventListener('input', () => { draft.bcc = field.value; }); return Field({ label: '密送', control: field, hint: '收件人看不到密送的人。' }); })(),
    (() => { const field = Input({ value: draft.subject, 'aria-label': '主题', maxLength: 998 }); field.addEventListener('input', () => { draft.subject = field.value; }); return Field({ label: '主题', control: field }); })(),
    (() => { const field = TextArea({ rows: 14, value: draft.text, 'aria-label': '正文', maxLength: 100000 }); field.addEventListener('input', () => { draft.text = field.value; }); return Field({ label: '正文', control: field }); })(),
    note, submit),
    // The footer is created empty here and painted below. Without it the drawer has no foot
    // to paint into.
    footer: h('div'),
  });
  // The footer is painted here and not passed in above, because it changes while the reply
  // is being asked for.
  paint();
  function paint() {
    submit.disabled = proposing;
    note.textContent = proposing ? '' : failure;
    replace(drawer.foot,
      Button({ label: '取消', disabled: proposing, onClick: () => { done = true; kept.delete(key); drawer.close(); } }),
      h('span', { class: 'small muted' }, proposing ? '正在提交…' : '取消会丢掉这次写的内容。'));
  }
  return drawer;
}

