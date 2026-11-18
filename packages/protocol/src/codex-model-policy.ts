/** Disable native data/execution capabilities; the parent owns external actions.
 * Some versions still advertise a non-data control tool. Callers reject native
 * tool items rather than running another tool loop inside the CLI provider.
 */
export const CODEX_MODEL_CONFIG = {
  'features.shell_tool': false,
  'features.unified_exec': false,
  'features.apply_patch_freeform': false,
  'features.code_mode': false,
  'features.code_mode_host': false,
  'features.js_repl': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.apps': false,
  'features.tool_search': false,
  'features.tool_suggest': false,
  'features.image_generation': false,
  'features.view_image': false,
  'features.shell_snapshot': false,
  'features.memories': false,
  'features.hooks': false,
  'features.plugins': false,
  'features.plugin_hooks': false,
  'features.skill_search': false,
  'features.sleep_tool': false,
  'features.goals': false,
  'features.collaboration_modes': false,
  'features.default_mode_request_user_input': false,
  'features.skip_host_skill_discovery': true,
  'features.omit_skill_descriptions': true,
  'agents.enabled': false,
  'code_mode.enabled': false,
  'orchestrator.mcp.enabled': false,
  'cloud.skills.enabled': false,
  'skills.include_instructions': false,
  'plugins._default.enabled': false,
  'memories.generate_memories': false,
  'memories.use_memories': false,
  web_search: 'disabled', project_doc_max_bytes: 0, notify: [],
};

type ConfigValue = string | boolean | number | ConfigValue[] | { [key: string]: ConfigValue };
export function codexModelConfig(result: unknown): Record<string, ConfigValue> {
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(result) || !isObject(result.config)) throw new Error('Invalid Codex configuration response');
  const servers = result.config.mcp_servers;
  if (servers !== undefined && !isObject(servers)) throw new Error('Invalid Codex MCP configuration');
  const config: Record<string, ConfigValue> = { ...CODEX_MODEL_CONFIG };
  // CLI dotted overrides split on every dot, including quoted segments. Override
  // the parent table with literal keys; recursive merging preserves transports.
  config.mcp_servers = Object.fromEntries(Object.keys(servers ?? {}).map(name => [name, { enabled: false }]));
  return config;
}
export function codexConfigArgs(config: Record<string, unknown>): string[] {
  const toml = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, v]) => `${JSON.stringify(key)}=${toml(v)}`).join(',')}}`;
    return JSON.stringify(value);
  };
  return Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]);
}

/** Unknown native actions fail closed. CLI startup diagnostics have no tool
 * effect; accepting their frame never bypasses the final exit/JSON validation.
 */
export function codexTextItem(type: unknown): boolean {
  return typeof type === 'string' && ['agent_message', 'reasoning', 'user_message', 'agentMessage', 'userMessage', 'contextCompaction', 'error'].includes(type);
}
