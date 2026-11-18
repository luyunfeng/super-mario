// 主模型配置：在抽屉里完成，保存后立即应用。密钥只存在于表单里，提交后清空。
import { h } from '../lib/dom.js';
import { Button, Field, Input, Select, Check, Banner } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

export function openModelDrawer({ api, config, onSaved }) {
  const mode = Select({ options: [['api', '模型 API（填写服务商和密钥）'], ['codex-cli', 'Codex 命令行']], value: config.mode === 'codex-cli' ? 'codex-cli' : 'api', name: 'mode' });
  const provider = Input({ name: 'provider', value: config.provider === 'codex-cli' ? '' : config.provider ?? '', list: 'model-providers', placeholder: '例如 openai、anthropic' });
  const datalist = h('datalist', { id: 'model-providers' }, ['openai', 'anthropic', 'google', 'deepseek', 'openai-compatible'].map(value => h('option', { value })));
  const baseUrl = Input({ name: 'baseUrl', type: 'url', value: config.baseUrl ?? '', placeholder: 'https://…/v1（可选）' });
  const apiKey = Input({ name: 'apiKey', type: 'password', autocomplete: 'new-password', placeholder: config.apiKeyConfigured ? '已保存，留空保持不变' : '粘贴密钥' });
  const clearKey = Check({ label: '清除已保存的密钥', name: 'clearApiKey' });
  const model = Input({ name: 'model', value: config.model ?? '', placeholder: '模型名称', required: true });
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
    title: '主 Agent 模型', subtitle: '主 Agent 和自动跟进共用这份配置，但对话各自独立。',
    body: [Field({ label: '接入方式', control: mode }), apiFields, cliFields, Field({ label: '模型', control: model }), error],
    footer: [Button({ label: '取消', onClick: () => drawer.close() }), save],
  });
  sync();
}
