import { h, replace } from '../lib/dom.js';
import { Button, Field, Input, Select, TextArea } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

export function officeDocumentsButton({ api, store }) {
  const active = () => !store.view.unauthorized && store.view.snapshot?.plugins?.some(p => p.id === 'office-documents' && p.status === 'active');
  const button = Button({ label: '办公文件', size: 'sm', onClick: open });
  const update = () => { button.hidden = !active(); };
  store.subscribe(update);
  update();
  function open() {
    if (!active()) return;
    const token = api.token(), route = location.hash;
    const title = Input({ required: true, maxLength: 120 });
    const format = Select({ options: [['docx', 'Word'], ['pptx', 'PowerPoint'], ['xlsx', 'Excel']] });
    const source = TextArea({ required: true, rows: 7 });
    const list = h('div', { class: 'stack' });
    const status = h('p', { role: 'status' });
    const submit = Button({ label: '生成文件', kind: 'primary', type: 'submit' });
    const form = h('form', { class: 'stack', onsubmit(event) { event.preventDefault(); void create(); } },
      Field({ label: '文件标题', control: title }), Field({ label: '格式', control: format }),
      Field({ label: '源内容', control: source, hint: 'Word 和演示文稿使用 Markdown。Excel 使用 CSV 或包含 sheets 的 JSON。' }), submit);
    const input = Input({ type: 'file', accept: '.docx,.pptx,.xlsx', onchange: inspect });
    const details = h('p', { role: 'status' });
    const inspectFile = h('details', { class: 'stack' }, h('summary', null, '查看已有文件内容摘要'), Field({ label: '选择办公文件', control: input }), details);
    const drawer = openDrawer({ title: '办公文件', wide: true, body: [form, status, inspectFile, list], onClose() {
      unsubscribe(); window.removeEventListener('hashchange', changed); drawer.body.replaceChildren();
    } });
    const current = () => drawer.el.open && active() && token === api.token() && route === location.hash;
    const changed = () => { if (!current()) drawer.close(); };
    const unsubscribe = store.subscribe(changed);
    window.addEventListener('hashchange', changed);
    const post = input => api.post('/office-documents', input);
    let fetching = 0;
    async function refresh() {
      const order = ++fetching;
      try {
        const records = await post({ action: 'list' });
        if (!current() || order !== fetching) return;
        replace(list, h('h3', null, '已生成文件'), !records.length && h('p', { class: 'muted' }, '还没有生成文件。'),
          records.map(doc => h('div', { class: 'item' }, h('div', { class: 'item__main' },
            h('strong', null, doc.filename), h('span', { class: 'item__meta' }, doc.summary)),
            Button({ label: '下载', ariaLabel: '下载 ' + doc.filename, onClick: () => download(doc.id) }))));
      } catch (cause) {
        if (current() && order === fetching) replace(list, h('p', { role: 'alert' }, '读取列表失败：' + cause.message), Button({ label: '重新读取', onClick: refresh }));
      }
    }
    async function create() {
      if (submit.disabled || !current()) return;
      submit.disabled = true;
      status.textContent = '正在生成…';
      try {
        const doc = await post({ action: 'create', title: title.value, format: format.value, source: source.value });
        if (current()) { status.textContent = '已生成 ' + doc.filename; await refresh(); }
      } catch (cause) {
        if (current()) {
          status.textContent = cause.status === 400 || cause.status === 413 ? cause.message : '生成结果待核对：' + cause.message;
          await refresh();
        }
      } finally { if (current()) submit.disabled = false; }
    }
    async function inspect() {
      const file = input.files?.[0];
      if (!file) { details.textContent = ''; return; }
      if (file.size > 12 * 1024 * 1024) { details.textContent = '文件超过 12 MiB。'; return; }
      const valid = () => current() && input.files?.[0] === file;
      details.textContent = '正在读取摘要…';
      try {
        const reader = new FileReader();
        const data = await new Promise((resolve, reject) => {
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('文件无法读取'));
          reader.readAsDataURL(file);
        });
        if (!valid()) return;
        const result = await post({ action: 'inspect', base64: data.slice(data.indexOf(',') + 1) });
        if (valid()) details.textContent = result.summary;
      } catch (cause) { if (valid()) details.textContent = '读取失败：' + cause.message; }
    }
    async function download(id) {
      try {
        const doc = await post({ action: 'download', id });
        if (!current()) return;
        const bytes = Uint8Array.from(atob(doc.base64), c => c.charCodeAt(0));
        const link = URL.createObjectURL(new Blob([bytes]));
        h('a', { href: link, download: doc.filename }).click();
        setTimeout(() => URL.revokeObjectURL(link), 1000);
      } catch (cause) { if (current()) status.textContent = '下载失败：' + cause.message; }
    }
    void refresh();
  }
  return button;
}
