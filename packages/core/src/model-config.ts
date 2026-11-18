import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppConfig, ModelConfig } from '../../protocol/src/index.ts';

export class ModelConfigError extends Error { status = 400; }
/** The browser receives only a credential-presence flag. Saved settings take precedence on restart. */
export function createModelConfig(config: AppConfig) {
  const file = join(config.dataDir, 'model.json');
  let source: 'saved' | 'startup' | 'automatic' = config.model ? 'startup' : 'automatic';
  function validate(input: Record<string, unknown>, previous?: ModelConfig): ModelConfig {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ModelConfigError('模型配置必须为对象');
    if (!['api', 'codex-cli'].includes(String(input.mode))) throw new ModelConfigError('请选择模型 API 或 Codex CLI 模式');
    if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') throw new ModelConfigError('clearApiKey必须为布尔值');
    const text = (value: unknown, title: string, max = 256) => {
      if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new ModelConfigError(`${title}格式无效`);
      return value.trim();
    };
    const cli = input.mode === 'codex-cli';
    const provider = cli ? 'codex-cli' : text(input.provider, '供应商');
    const model = text(input.model ?? (cli ? 'default' : ''), '模型');
    if (!model || !/^[a-z0-9][a-z0-9_-]*$/.test(provider) || (!cli && provider === 'codex-cli')) throw new ModelConfigError('请填写有效的供应商和模型');
    const next: ModelConfig = { provider, model };
    if (cli) {
      // Store one executable, never a shell command or an argument list.
      const command = input.cliCommand === undefined ? '' : text(input.cliCommand, '启动命令', 4096);
      if (command && !isAbsolute(command) && (/[\\/]/.test(command) || /\s/.test(command))) {
        throw new ModelConfigError('启动命令必须是 PATH 命令名或绝对路径，不能附带参数');
      }
      const configDir = input.cliConfigDir === undefined ? '' : text(input.cliConfigDir, '命令行配置目录', 4096);
      if (configDir && !isAbsolute(configDir)) throw new ModelConfigError('命令行配置目录必须是绝对路径');
      if (command) next.cliCommand = command;
      if (configDir) next.cliConfigDir = configDir;
    }
    if (!cli) {
      const key = input.apiKey === undefined ? '' : text(input.apiKey, 'API Key', 16384);
      const apiKey = input.clearApiKey ? undefined : key || (previous?.provider === provider ? previous.apiKey : undefined);
      if (apiKey) next.apiKey = apiKey;
      const baseUrl = input.baseUrl === undefined ? '' : text(input.baseUrl, '接口地址', 2048);
      if (baseUrl) {
        let url: URL; try { url = new URL(baseUrl); } catch { throw new ModelConfigError('接口地址必须是有效的 HTTP(S) 地址'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ModelConfigError('接口地址只支持不含凭证、查询参数和片段的 HTTP(S) 地址');
        next.baseUrl = baseUrl.replace(/\/+$/, '');
      }
      if (provider === 'openai-compatible' && !next.baseUrl) throw new ModelConfigError('OpenAI 兼容模式需要填写接口地址');
    }
    return next;
  }
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    config.model = validate(saved);
    source = 'saved';
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return {
    public() {
      const value = config.model;
      return { mode: value?.provider === 'codex-cli' ? 'codex-cli' : 'api', provider: value?.provider ?? '', model: value?.model ?? '', baseUrl: value?.baseUrl ?? '', apiKeyConfigured: Boolean(value?.apiKey), ...(value?.provider === 'codex-cli' ? { ...(value.cliCommand ? { cliCommand: value.cliCommand } : {}), ...(value.cliConfigDir ? { cliConfigDir: value.cliConfigDir } : {}) } : {}), source };
    },
    write(input: Record<string, unknown>) {
      const next = validate(input, config.model);
      mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
      const temp = `${file}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify({ mode: next.provider === 'codex-cli' ? 'codex-cli' : 'api', ...next }), { mode: 0o600 });
      renameSync(temp, file);
      config.model = next; source = 'saved';
    },
  };
}
