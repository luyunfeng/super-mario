/** Explicit review and load UI; no downloads, dependency installation or automatic deployment. */
export function createAgentArtifactsUI({ api, element, onChanged }) {
  const node = (tag, text, className) => {
    const value = document.createElement(tag);
    if (text !== undefined) value.textContent = text;
    if (className) value.className = className;
    return value;
  };
  const root = node('section', undefined, 'card stack agent-artifacts');
  root.append(node('h2', '电脑插件文件'), node('p', '暂存单文件 ESM，查看代码并确认精确版本与 SHA256 后，再手动加载。确认的代码拥有电脑 Node 进程权限。'));
  const form = node('form', undefined, 'form-grid');
  const fields = {};
  for (const [name, title, tag] of [['machineId', '电脑', 'select'], ['id', '插件名称', 'input'], ['version', '版本（如 1.0.0）', 'input'], ['source', '已打包的单文件 ESM 源码', 'textarea']]) {
    const label = node('label', title);
    const field = node(tag);
    field.name = name;
    field.required = true;
    if (tag === 'textarea') field.rows = 12;
    fields[name] = field;
    label.append(field);
    form.append(label);
  }
  const stage = node('button', '暂存供检查');
  form.append(stage);
  const refresh = node('button', '重新读取', 'secondary');
  refresh.type = 'button';
  const notice = node('p');
  notice.setAttribute('role', 'status');
  const error = node('p');
  error.setAttribute('role', 'alert');
  const list = node('div', undefined, 'stack');
  root.append(form, refresh, notice, error, list);
  element.append(root);
  let generation = 0;
  let reading = 0;
  let writing = 0;
  let busy = false;
  let machines = [];
  const labels = { pending: '待确认', confirmed: '已确认', deploying: '正在加载', loaded: '已加载', failed: '失败', unknown: '结果未知', unloaded: '当前未加载' };
  function sync() { for (const button of root.querySelectorAll('button')) button.disabled = busy || button.dataset.blocked === 'true'; }
  function render(records) {
    list.replaceChildren();
    if (!records.length) list.append(node('p', '尚无暂存插件文件。'));
    for (const record of records) {
      const card = node('article', undefined, 'card');
      const machine = machines.find(item => item.id === record.machineId);
      card.append(node('h3', record.pluginId), node('p', `电脑：${machine?.name || record.machineId}；版本：${record.manifest.version}`), node('p', `SHA256：${record.manifest.sha256}`), node('p', `状态：${labels[record.status] || record.status}${record.reason ? `；${record.reason}` : ''}`));
      const details = node('details');
      details.append(node('summary', '查看完整源代码（确认前请检查）'), node('pre', record.source));
      card.append(details);
      for (const [action, title, allowed] of [['approve', '确认此版本', record.status === 'pending'], ['deploy', '加载到电脑', record.status === 'confirmed'], ['status', '核查电脑状态', true]]) {
        const button = node('button', title, 'secondary');
        button.type = 'button';
        button.dataset.blocked = String(!allowed);
        // An old DOM callback is invalid after reset/token changes, even if it is already queued.
        const epoch = generation;
        button.addEventListener('click', () => {
          if (epoch !== generation || !allowed) return;
          void mutate(async () => api(`/agent-artifacts/${encodeURIComponent(record.id)}/${action}`, action === 'status' ? {} : {
            method: 'POST', body: JSON.stringify(action === 'approve' ? { sha256: record.manifest.sha256 } : {}),
          }), action === 'status' ? '已核查电脑状态。' : action === 'approve' ? '已确认此版本。请另行点击加载。' : '电脑已确认加载。', action === 'status');
        });
        card.append(button);
      }
      if (record.status === 'unloaded') {
        const restage = node('button', '重新暂存此版本', 'secondary');
        restage.type = 'button';
        const epoch = generation;
        restage.addEventListener('click', () => {
          if (epoch !== generation) return;
          const body = { machineId: record.machineId, manifest: record.manifest, source: record.source };
          void mutate(() => api('/agent-artifacts', { method: 'POST', body: JSON.stringify(body) }),
            '已为此版本新建待确认记录。核对源码和 SHA256 后可确认加载。');
        });
        card.append(restage);
      }
      list.append(card);
    }
    sync();
  }
  async function load(epoch = generation) {
    const request = ++reading;
    const writeAtStart = writing;
    try {
      const [records, state] = await Promise.all([api('/agent-artifacts'), api('/state')]);
      if (epoch !== generation || request !== reading || writeAtStart !== writing) return;
      machines = state.machines || [];
      const selected = fields.machineId.value;
      fields.machineId.replaceChildren(node('option', '请选择电脑'));
      fields.machineId.firstChild.value = '';
      for (const machine of machines) {
        const option = node('option', `${machine.name || machine.id}（${machine.platform || '未知平台'}，${machine.online ? '在线' : '离线'}）`);
        option.value = machine.id;
        fields.machineId.append(option);
      }
      fields.machineId.value = selected;
      render(records);
    } catch (cause) {
      if (epoch === generation && request === reading && writeAtStart === writing) error.textContent = `读取失败：${cause.message || String(cause)}`;
    }
  }
  async function mutate(action, success, isStatus = false) {
    if (busy) return;
    const epoch = generation;
    const request = ++writing;
    ++reading;
    busy = true;
    error.textContent = '';
    notice.textContent = '正在处理…';
    sync();
    try {
      const result = await action();
      if (epoch !== generation || request !== writing) return;
      notice.textContent = isStatus ? `状态：${labels[result.status] || result.status}；${result.reason || ''}` : success;
      await load(epoch);
      if (epoch !== generation || request !== writing) return;
      try { await onChanged?.(); } catch (cause) {
        if (epoch === generation && request === writing) error.textContent = `操作成功，重读主状态失败：${cause.message || String(cause)}`;
      }
    } catch (cause) {
      if (epoch !== generation || request !== writing) return;
      error.textContent = `未收到成功回执：${cause.message || String(cause)}。不会自动重试；请核查电脑状态。`;
      notice.textContent = '';
      await load(epoch);
    } finally {
      if (epoch === generation && request === writing) { busy = false; sync(); }
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const body = { machineId: fields.machineId.value, manifest: { id: fields.id.value.trim(), version: fields.version.value.trim(), apiVersion: 1 }, source: fields.source.value };
    void mutate(() => api('/agent-artifacts', { method: 'POST', body: JSON.stringify(body) }), '已暂存，尚未确认或加载。');
  });
  refresh.addEventListener('click', () => { if (!busy) void load(); });
  return {
    open() { if (!busy) { error.textContent = ''; void load(); } },
    reset() {
      generation++; reading++; writing++;
      busy = false; machines = [];
      form.reset(); fields.machineId.replaceChildren();
      list.replaceChildren(); error.textContent = ''; notice.textContent = '';
      sync();
    },
  };
}
