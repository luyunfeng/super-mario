// 邮箱渠道：用主人添加的邮箱账号收邮件。密码加密后留在工作台，页面只看到「已设置」。
import { h, replace } from '../lib/dom.js';
import { Button, Card, Dot, Field, Input, Pill, Select } from '../ui/kit.js';
import { openDrawer, confirmDialog } from '../ui/overlay.js';

const STATUS = { unknown: ['未检查', ''], ok: ['已连接', 'ok'], error: ['连接失败', 'danger'] };
const SECURITY = [['', '按端口自动判断'], ['tls', 'TLS'], ['starttls', 'STARTTLS'], ['none', '不加密']];
const ROLE = { inbox: '收件箱', sent: '已发送', drafts: '草稿', trash: '已删除', junk: '垃圾邮件', archive: '归档', other: '其他' };
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
const path = id => '/mail/accounts/' + encodeURIComponent(id);

export function createMailChannel({ api, store }) {
  let accounts = [];
  let error = '';
  let busy = '';
  let seq = 0;
  const body = h('div', { class: 'stack' });
  const status = h('p', { role: 'status', class: 'small muted' });
  const card = Card({ id: 'channel-mail', title: '邮箱', sub: '读取邮箱的文件夹和最新邮件。密码加密后留在工作台，不回显。',
    tools: Button({ label: '添加邮箱', icon: 'plus', size: 'sm', onClick: () => edit() }), body: [body, status] });

  async function load() {
    const stamp = ++seq;
    try {
      const value = await api.get('/mail/accounts');
      if (stamp !== seq) return;
      if (!Array.isArray(value)) throw Error('响应格式无效');
      accounts = value; error = '';
    } catch (cause) {
      if (stamp !== seq) return;
      error = cause.message;
    }
    paint();
  }

  /** The form of one account. `current` is the account being changed, if any. */
  async function form(current, done) {
    let preset = null;
    try { preset = (await api.get('/mail/preset?email=' + encodeURIComponent(current?.email ?? ''))).preset; }
    catch { /* The servers are typed by hand when the preset cannot be read. */ }
    const email = Input({ type: 'email', value: current?.email ?? '', required: true, maxLength: 254, autocomplete: 'off', 'aria-label': '邮箱地址' });
    const name = Input({ value: current?.name ?? '', maxLength: 80, 'aria-label': '账号名称', placeholder: '留空则用邮箱地址' });
    const password = Input({ type: 'password', value: '', autocomplete: 'new-password', 'aria-label': '密码或授权码' });
    const username = Input({ value: current?.username ?? '', maxLength: 320, 'aria-label': '登录名', placeholder: '留空则用邮箱地址' });
    const servers = {
      imapHost: Input({ value: current?.imapHost ?? preset?.imapHost ?? '', maxLength: 253, 'aria-label': '收件服务器' }),
      imapPort: Input({ type: 'number', value: current?.imapPort ?? preset?.imapPort ?? '', min: 1, max: 65535, 'aria-label': '收件端口' }),
      smtpHost: Input({ value: current?.smtpHost ?? preset?.smtpHost ?? '', maxLength: 253, 'aria-label': '发件服务器' }),
      smtpPort: Input({ type: 'number', value: current?.smtpPort ?? preset?.smtpPort ?? '', min: 1, max: 65535, 'aria-label': '发件端口' }),
    };
    const security = {
      imapSecurity: Select({ options: SECURITY, value: current?.imapSecurity ?? '', 'aria-label': '收件加密方式' }),
      smtpSecurity: Select({ options: SECURITY, value: current?.smtpSecurity ?? '', 'aria-label': '发件加密方式' }),
    };
    const advanced = h('details', null, h('summary', null, '服务器和加密方式'),
      h('div', { class: 'stack' },
        Field({ label: '登录名', control: username, hint: '多数服务商与邮箱地址相同。不同时在这里填写。' }),
        h('div', { class: 'form-row' },
          Field({ label: '收件服务器', control: servers.imapHost, required: true }),
          Field({ label: '收件端口', control: servers.imapPort, required: true }),
          Field({ label: '收件加密方式', control: security.imapSecurity })),
        h('div', { class: 'form-row' },
          Field({ label: '发件服务器', control: servers.smtpHost, required: true }),
          Field({ label: '发件端口', control: servers.smtpPort, required: true }),
          Field({ label: '发件加密方式', control: security.smtpSecurity })),
        h('p', { class: 'small muted' }, '常见邮箱会按地址自动填写。不在列表里的邮箱请自己填写收件和发件服务器。')));
    const hint = h('span', { class: 'field__hint' });
    const note = h('div', { role: 'alert' });
    // Where the owner makes the code that mail clients sign in with, for the providers that
    // need one. It follows the address as it is typed.
    let codeSite = preset?.codeSite ?? '';
    /** What to say about the password. It depends on whether there is one to keep. */
    function passwordHint() {
      if (current?.hasPassword) return '留空保留原密码。更换服务器后须重新填写。';
      if (current) return '这个账号还没有密码，请填写。';
      return codeSite ? `在 ${codeSite} 生成，并填写到这里。` : '多数邮箱需要用授权码登录，而不是登录密码。';
    }
    // An address of a known domain fills the servers in, so the owner does not have to look
    // them up. What they typed by hand is kept.
    email.addEventListener('input', async () => {
      const value = email.value.trim();
      if (!value.includes('@')) { codeSite = ''; hint.textContent = passwordHint(); return; }
      try {
        const found = (await api.get('/mail/preset?email=' + encodeURIComponent(value))).preset;
        if (found && email.value.trim() === value) {
          servers.imapHost.value = found.imapHost; servers.imapPort.value = String(found.imapPort);
          servers.smtpHost.value = found.smtpHost; servers.smtpPort.value = String(found.smtpPort);
          codeSite = found.codeSite ?? '';
          hint.textContent = passwordHint();
        }
      } catch { /* A preset that cannot be read leaves the fields for the owner to fill. */ }
    });
    const passwordField = () => Field({ label: '密码或授权码', control: password, hint, required: !current });
    password.addEventListener('input', () => { note.textContent = ''; });
    password.addEventListener('invalid', () => { note.textContent = '请填写密码或授权码。'; });
    hint.textContent = passwordHint();
    const save = Button({ label: current ? '保存' : '添加', kind: 'primary', type: 'submit' });
    return h('form', { class: 'stack', onsubmit: async event => {
      event.preventDefault();
      if (save.disabled) return;
      const address = email.value.trim();
      if (!address) { note.textContent = '请填写邮箱地址。'; email.focus(); return; }
      const change = { name: name.value.trim(), email: address, username: username.value.trim() || undefined };
      // An empty port is not sent: the port of the domain is used when there is one.
      for (const key of ['imapHost', 'smtpHost']) if (servers[key].value.trim()) change[key] = servers[key].value.trim();
      for (const key of ['imapPort', 'smtpPort']) if (servers[key].value) change[key] = Number(servers[key].value);
      for (const key of ['imapSecurity', 'smtpSecurity']) if (security[key].value) change[key] = security[key].value;
      if (password.value) change.password = password.value;
      if (!current && !change.password) { note.textContent = '请填写密码或授权码。'; password.focus(); return; }
      save.disabled = true; note.textContent = '';
      try {
        if (current) await api.put(path(current.id), { ...change, version: current.version });
        else await api.post('/mail/accounts', change);
        password.value = '';
        done();
        await load();
      } catch (cause) { note.textContent = cause.message; }
      finally { save.disabled = false; }
    } },
    h('p', { class: 'small muted' }, '添加后点击「检查连接」读取文件夹。读取是只读的，不会把邮件标记为已读。'),
    Field({ label: '邮箱地址', control: email, required: true }),
    Field({ label: '账号名称', control: name }),
    passwordField(), advanced, note, save);
  }

  function edit(current) {
    const drawer = openDrawer({ title: current ? '修改邮箱账号' : '添加邮箱', body: '正在读取…' });
    form(current, () => drawer.close()).then(node => { if (drawer.el.open) replace(drawer.body, node); }, () => {
      if (drawer.el.open) replace(drawer.body, h('p', { role: 'alert', class: 'small' }, '无法读取邮箱预设，请关闭后重试。'));
    });
  }

  /** What one read found, and what to do about a failure. */
  function inbox(account) {
    const found = accounts.find(item => item.account.id === account.id);
    if (!found?.mailboxes) return found?.failure ? h('p', { class: 'small', role: 'alert' }, found.failure.message) : null;
    const messages = found.messages ?? [];
    return h('div', { class: 'stack' },
      h('p', { class: 'small muted' }, '最近读取 ', h('time', { datetime: found.readAt }, time(found.readAt)), ' · ',
        found.mailboxes.map(box => `${ROLE[box.role] ?? box.name} ${box.total}`).join(' · ')),
      messages.length ? h('div', { class: 'list' }, messages.slice(0, 8).map(message => h('div', { class: 'item' },
        h('div', { class: 'item__main' },
          h('span', { class: 'item__title' }, message.seen ? '' : Dot('warn'), ' ', message.subject || '（无主题）'),
          h('span', { class: 'item__meta' }, `${message.from.name || message.from.email} · ${time(message.date)}${message.hasAttachments ? ' · 有附件' : ''}`)))))
        : h('p', { class: 'small muted' }, '收件箱里没有邮件。'),
      messages.length > 8 && h('p', { class: 'small muted' }, `只显示最新 8 封，共读取 ${messages.length} 封。`));
  }

  function paint() {
    if (error) { replace(body, h('p', { class: 'small', role: 'alert' }, '无法读取邮箱账号：' + error)); status.textContent = ''; return; }
    if (!accounts.length) {
      replace(body, h('p', { class: 'small muted' }, '还没有添加邮箱。添加后可以在这里检查连接，并查看文件夹和最新邮件。'));
      status.textContent = ''; return;
    }
    replace(body, h('div', { class: 'list' }, accounts.map(account => {
      const item = account.account;
      const [label, tone] = STATUS[item.status] ?? STATUS.unknown;
      const reading = busy === item.id;
      return h('div', { class: 'item', dataset: { mail: item.id } },
        h('div', { class: 'row row--wrap' },
          h('div', { class: 'item__main' },
            h('span', { class: 'item__title' }, item.name),
            h('span', { class: 'item__meta' }, `${item.email} · ${item.imapHost}:${item.imapPort}`)),
          Pill(label, tone), !item.hasPassword && Pill('未设置密码', 'warn'),
          Button({ label: reading ? '读取中…' : '检查连接', size: 'sm', disabled: busy !== '', onClick: async () => {
            busy = item.id; paint();
            try { await api.post(path(item.id) + '/read'); }
            catch { /* The reason is in the account's state, which is read again below. */ }
            finally { busy = ''; await load(); }
          } }),
          Button({ label: '修改', size: 'sm', disabled: busy !== '', onClick: () => edit(item) }),
          Button({ label: '移除', size: 'sm', disabled: busy !== '', onClick: async () => {
            const yes = await confirmDialog({ title: '移除邮箱', message: `移除后不再读取 ${item.email}。已保存的密码一起删除，这个操作不能撤销。`, confirmLabel: '移除', danger: true });
            if (!yes) return;
            try { await api.del(path(item.id) + '?version=' + item.version); await load(); }
            catch (cause) { status.textContent = '移除失败：' + cause.message; }
          } })),
        inbox(item));
    })));
    status.textContent = '';
  }

  return { el: card, load, update: () => paint() };
}
