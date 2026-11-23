// 主模型配置：在抽屉里完成，保存后立即应用。密钥只存在于表单里，提交后清空。
import { h } from '../lib/dom.js';
import { Button, Field, Input, Select, Check, Banner } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

// The same conversation can be selected from its bot in Feishu or its named row on the Web.
function conversationModelPicker(api, path, name) {
  const catalog = h('div', { class: 'stack', 'aria-live': 'polite' });
  const load = async () => {
    refresh.disabled = true;
    catalog.textContent = '正在读取模型清单…';
    try {
      const result = await api.get(path + '/catalog');
      const description = result.source === 'builtin' ? '内置目录，账号权限需另行核实。'
        : result.source === 'configured' ? '仅列出配置中记录的模型。' : '自动选择模型。';
      const current = h('p');
      const report = value => {
        current.textContent = (result.demo ? '演示模式。' : '') +
          (value ? `${name}当前配置为 ${result.provider} / ${value}。` : `${name}尚无已选模型记录。`) + description;
      };
      report(result.current);
      catalog.replaceChildren(current);
      if (!result.models.length) return;
      const list = Select({ name: 'catalogModels', options: result.models.map(id => [id, id]), value: result.current });
      const feedback = h('p', { role: 'status' });
      const apply = Button({ label: '应用到此会话', size: 'sm', disabled: true, onClick: async () => {
        list.disabled = true;
        refresh.disabled = true;
        try {
          const saved = await api.put(path + '/pick', { model: list.value });
          result.current = saved.current;
          report(saved.current);
          feedback.textContent = '已保存，下条消息使用所选模型。';
        } catch (cause) {
          feedback.textContent = cause.status && cause.status < 500 ? `切换失败：${cause.message}` : '切换结果未知，请重新查看清单核对。';
        } finally {
          list.disabled = false;
          refresh.disabled = false;
          apply.disabled = list.value === result.current;
        }
      } });
      list.addEventListener('change', () => { apply.disabled = list.value === result.current; feedback.textContent = ''; });
      catalog.append(Field({ label: `模型清单（${result.models.length}）`, control: list }), apply, feedback);
    } catch { catalog.textContent = '模型清单读取失败，可重新查看。'; }
    finally { refresh.disabled = false; }
  };
  const refresh = Button({ label: '查看当前配置的模型清单', size: 'sm', onClick: load });
  return { controls: [refresh, catalog], load };
}

export function openBotModelDrawer({ api, bot }) {
  const picker = conversationModelPicker(api, '/feishu/bots/' + encodeURIComponent(bot.id) + '/model', bot.name);
  openDrawer({ title: bot.name + '的主会话模型', body: picker.controls });
  void picker.load();
}

export function openModelDrawer({ api, config, onSaved }) {
  const mode = Select({ options: [['api', '模型 API（填写服务商和密钥）'], ['codex-cli', 'Codex 命令行']], value: config.mode === 'codex-cli' ? 'codex-cli' : 'api', name: 'mode' });
  const provider = Input({ name: 'provider', value: config.provider === 'codex-cli' ? '' : config.provider ?? '', list: 'model-providers', placeholder: '例如 openai、anthropic' });
  const datalist = h('datalist', { id: 'model-providers' }, ['openai', 'anthropic', 'google', 'deepseek', 'openai-compatible'].map(value => h('option', { value })));
  const baseUrl = Input({ name: 'baseUrl', type: 'url', value: config.baseUrl ?? '', placeholder: 'https://…/v1（可选）' });
  const apiKey = Input({ name: 'apiKey', type: 'password', autocomplete: 'new-password', placeholder: config.apiKeyConfigured ? '已保存，留空保持不变' : '粘贴密钥' });
  const clearKey = Check({ label: '清除已保存的密钥', name: 'clearApiKey' });
  const model = Input({ name: 'model', value: config.model ?? '', placeholder: '模型名称', required: true });
  const picker = conversationModelPicker(api, '/model', 'Web 主会话');
  const cliCommand = Input({ name: 'cliCommand', value: config.cliCommand ?? '', maxlength: 4096, placeholder: 'codex' });
  const cliConfigDir = Input({ name: 'cliConfigDir', value: config.cliConfigDir ?? '', maxlength: 4096, placeholder: '绝对路径（可选）' });
  const cliFields = h('div', { class: 'stack' },
    Field({ label: '启动命令（可选）', control: cliCommand, hint: '留空使用当前环境 PATH 中的 codex。可填命令名或绝对路径，不附带参数。' }),
    Field({ label: '命令行配置目录（可选）', control: cliConfigDir, hint: '留空复用当前环境的默认认证目录。保存不会登录或测试模型，配置不代表已认证或可用。' }));
  const error = h('div', { role: 'alert' });
  const apiFields = h('div', { class: 'stack' },
    Field({ label: '服务商', control: provider, required: true }), datalist,
    Field({ label: '服务地址', control: baseUrl, hint: '使用兼容接口时必填，需要是 HTTP(S) 地址。' }),
    Field({ label: '密钥', control: apiKey, hint: '换服务商时需要重新填写。' }), clearKey);

  const sync = () => {
    const cli = mode.value === 'codex-cli';
    apiFields.hidden = cli;
    cliFields.hidden = !cli;
    if (cli && !model.value) model.value = 'default';
  };
  mode.addEventListener('change', () => { apiKey.value = ''; model.value = mode.value === 'codex-cli' ? 'default' : ''; sync(); });
  clearKey.querySelector('input').addEventListener('change', (event) => { if (event.target.checked) apiKey.value = ''; });

  const save = Button({
    label: '保存并应用', kind: 'primary',
    onClick: async () => {
      error.replaceChildren();
      const cli = mode.value === 'codex-cli';
      const body = { mode: cli ? 'codex-cli' : 'api', provider: cli ? 'codex-cli' : provider.value.trim(), model: model.value.trim() || (cli ? 'default' : '') };
      const fail = (text) => { error.replaceChildren(Banner({ tone: 'danger', children: text })); };
      if (cli) {
        if (cliCommand.value.trim()) body.cliCommand = cliCommand.value.trim();
        if (cliConfigDir.value.trim()) body.cliConfigDir = cliConfigDir.value.trim();
      }
      if (!cli) {
        if (!body.provider || !body.model) return fail('请填写服务商和模型。');
        if (baseUrl.value.trim()) {
          try { if (!['http:', 'https:'].includes(new URL(baseUrl.value.trim()).protocol)) throw new Error(); }
          catch { return fail('服务地址必须是有效的 HTTP(S) 地址。'); }
          body.baseUrl = baseUrl.value.trim();
        } else if (body.provider === 'openai-compatible') return fail('兼容接口必须填写服务地址。');
        if (clearKey.querySelector('input').checked) body.clearApiKey = true;
        else if (apiKey.value) body.apiKey = apiKey.value;
      }
      try { await api.put('/model', body); }
      catch (cause) {
        return fail(cause.status && cause.status < 500 ? `保存失败：${cause.message}` : '保存结果未知，请先核对当前配置再重试，不会自动重试。');
      }
      apiKey.value = '';
      drawer.close();
      await onSaved?.();
    },
  });
  const drawer = openDrawer({
    title: '主 Agent 模型', subtitle: '保存接入配置会更新工作台默认模型。模型清单中的「应用到此会话」只切换 Web 主会话。',
    body: [Field({ label: '接入方式', control: mode }), apiFields, cliFields, Field({ label: '模型', control: model }), ...picker.controls, error],
    footer: [Button({ label: '取消', onClick: () => drawer.close() }), save],
  });
  sync();
}
