import { h, replace } from '../lib/dom.js';
import { Button, Card, Field, Input } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

const enabled = store => !store.view.unauthorized && !!store.view.snapshot?.plugins?.some(
  plugin => plugin.id === 'assistant-skills' && plugin.status === 'active');

function readArchive(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取所选文件。'));
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    reader.readAsDataURL(file);
  });
}

export function createAssistantSkills({ api, store }) {
  const el = Card({ id: 'assistant-skills', title: '助手技能',
    sub: '供 Web 主助手和全局飞书机器人使用', body: Button({ label: '管理技能', onClick: open }) });
  const visibility = () => { el.hidden = !enabled(store); };
  store.subscribe?.(visibility);
  visibility();

  function open() {
    if (!enabled(store)) return;
    const token = api.token(), route = location.hash;
    const post = body => api.post('/assistant-skills', body);
    let book, busy = false, removing, selected;
    const status = h('div', { role: 'status', class: 'small' });
    const errors = h('div', { role: 'alert' });
    const upload = Input({ type: 'file', accept: '.zip,application/zip', onchange: () => void previewFile() });
    const confirm = h('div', { class: 'stack' });
    const rows = h('div', { class: 'stack' });
    const details = h('div', { class: 'stack', tabIndex: -1 });
    const controls = h('fieldset', { class: 'stack', 'aria-label': '技能管理' },
      Field({ label: '技能 ZIP 文件', control: upload, hint: '选择不超过 4 MiB 的 ZIP 包，核对内容后安装。' }), confirm, rows, details);
    const drawer = openDrawer({ title: '助手技能', wide: true, body: [status, errors, controls], onClose() {
      unsubscribe(); book = undefined; upload.value = ''; drawer.body.replaceChildren();
    } });
    const current = () => drawer.el.open && token === api.token() && route === location.hash && enabled(store);
    const unsubscribe = store.subscribe(() => { if (!current()) drawer.close(); });

    function closeFile() {
      selected = undefined;
      details.replaceChildren();
    }
    async function run(label, work, mutation = false) {
      if (busy || !current()) return;
      busy = true;
      controls.disabled = true;
      status.textContent = label + '中…';
      errors.replaceChildren();
      try {
        await work();
        if (current() && status.textContent === label + '中…') status.textContent = '';
      } catch (cause) {
        if (!current()) return;
        status.textContent = '';
        const uncertain = mutation && (!cause.status || cause.status >= 500);
        errors.textContent = label + (uncertain ? '结果未确认，请核对技能列表。' : '失败：') + cause.message;
        if (cause.status === 409 || uncertain) {
          // 只核对列表。安装仍需重新预览，删除仍需重新选择和确认。
          book = undefined;
          removing = undefined;
          confirm.replaceChildren();
          if (mutation && upload.files?.length) replace(confirm, Button({ label: '重新预览', onClick: previewFile }));
          closeFile();
          renderList();
          try { await loadList(); }
          catch (error) { if (current()) errors.append(h('p', null, '重新读取列表失败：' + error.message)); }
        }
      } finally { busy = false; if (current()) controls.disabled = false; }
    }
    async function loadList() {
      const next = await post({ action: 'list' });
      if (!current()) return;
      book = next;
      renderList();
    }
    function removeSkill(name, revision) {
      return run('删除', async () => {
        const next = await post({ action: 'remove', name, revision });
        if (!current()) return;
        book = next;
        removing = undefined;
        confirm.replaceChildren();
        upload.value = '';
        if (selected === name) closeFile();
        renderList();
        status.textContent = '已删除技能「' + name + '」。';
      }, true);
    }
    function renderList() {
      upload.disabled = !book;
      if (!book) { replace(rows, Button({ label: '重新读取技能列表', onClick: () => run('读取列表', loadList) })); return; }
      replace(rows, h('h3', null, '已安装技能'),
        !book.skills.length && h('p', { class: 'muted' }, '还没有安装助手技能。'),
        book.skills.map(skill => h('article', { class: 'card' }, h('div', { class: 'card__body stack' },
          h('strong', null, skill.name), h('p', { class: 'small' }, skill.description),
          h('div', { class: 'row row--wrap' },
            Button({ label: '查看', ariaLabel: '查看 ' + skill.name, size: 'sm', onClick: () => showFile(skill.name) }),
            Button({ label: '删除', ariaLabel: '删除 ' + skill.name, size: 'sm', onClick() {
              removing = skill.name; errors.replaceChildren(); renderList();
            } })),
          removing === skill.name && h('div', { class: 'stack' },
            h('p', null, '从助手中删除技能「' + skill.name + '」？'),
            h('div', { class: 'row row--wrap' },
              Button({ label: '取消', onClick() { removing = undefined; renderList(); } }),
              Button({ label: '确认删除', kind: 'danger', onClick: () => removeSkill(skill.name, book.revision) })))))));
    }
    function showFile(name, filePath) {
      return run('读取文件', async () => {
        selected = name;
        const path = Input({ value: filePath ?? 'SKILL.md', required: true });
        const content = h('div');
        replace(details, h('h3', null, name), h('form', { class: 'stack', onsubmit(event) {
          event.preventDefault();
          if (path.value.trim()) void showFile(name, path.value.trim());
        } }, Field({ label: '文件路径', control: path }), h('div', { class: 'row row--wrap' },
          Button({ label: '读取文件', type: 'submit' }), Button({ label: '关闭文件', onClick: closeFile }))), content);
        const result = await post({ action: 'read', name, ...(filePath && { path: filePath }) });
        if (!current()) return;
        path.value = result.path;
        replace(content, h('pre', { class: 'mailbox-content', 'aria-label': '技能文件内容' }, result.text));
        details.focus({ preventScroll: true });
        details.scrollIntoView({ block: 'start' });
      });
    }
    function previewFile() {
      const file = upload.files?.[0];
      confirm.replaceChildren();
      if (!file || !book) return;
      return run('预览', async () => {
        if (file.size > 4 * 1024 * 1024) throw new Error('技能 ZIP 文件超过 4 MiB。');
        const encoded = await readArchive(file);
        if (!current() || file !== upload.files?.[0]) return;
        const info = await post({ action: 'preview', archive: encoded });
        if (!current() || file !== upload.files?.[0]) return;
        const revision = book.revision;
        replace(confirm, h('h3', null, '技能包预览'), h('strong', null, info.name),
          h('p', null, info.description), h('ul', { 'aria-label': '文件清单' }, info.files.map(path => h('li', null, path))),
          Button({ label: '确认安装', kind: 'primary', onClick: () => run('安装', async () => {
            const next = await post({ action: 'install', archive: encoded, digest: info.digest, revision });
            if (!current()) return;
            book = next;
            removing = undefined;
            confirm.replaceChildren();
            upload.value = '';
            renderList();
            status.textContent = '已安装技能「' + info.name + '」。';
          }, true) }));
      });
    }
    renderList();
    void run('读取列表', loadList);
  }
  return { el };
}
