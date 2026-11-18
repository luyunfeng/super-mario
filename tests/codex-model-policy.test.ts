import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODEX_MODEL_CONFIG, codexModelConfig, codexConfigArgs, codexTextItem } from '../packages/protocol/src/codex-model-policy.ts';

test('model policy disables native work capabilities and retains only named MCP denial overrides', () => {
  for (const key of ['shell_tool', 'unified_exec', 'apply_patch_freeform', 'code_mode', 'code_mode_host', 'js_repl',
    'multi_agent', 'multi_agent_v2', 'apps', 'tool_search', 'tool_suggest', 'image_generation', 'view_image',
    'shell_snapshot', 'memories', 'hooks', 'plugins', 'plugin_hooks', 'skill_search', 'sleep_tool', 'goals',
    'collaboration_modes', 'default_mode_request_user_input']) {
    assert.equal(CODEX_MODEL_CONFIG[`features.${key}` as keyof typeof CODEX_MODEL_CONFIG], false, key);
  }
  assert.equal(CODEX_MODEL_CONFIG.web_search, 'disabled');
  assert.equal(CODEX_MODEL_CONFIG.project_doc_max_bytes, 0);
  assert.deepEqual(CODEX_MODEL_CONFIG.notify, []);
  const name = 'test.canary';
  const config = codexModelConfig({config:{mcp_servers:{[name]:{command:'secret-source',env:{TOKEN:'secret-auth'}}}},origins:{auth:'secret-auth'}});
  assert.deepEqual(config.mcp_servers, {[name]:{enabled:false}});
  assert.ok(codexConfigArgs(config).includes('mcp_servers={"test.canary"={"enabled"=false}}'));
  assert.doesNotMatch(JSON.stringify(config), /secret-source|secret-auth|origins/);
  assert.notDeepEqual(config.mcp_servers, codexModelConfig({config:{}}).mcp_servers);
  assert.throws(() => codexModelConfig({}));
  assert.throws(() => codexModelConfig({config:{mcp_servers:[]}}));
});

test('unknown native items and non-data user interaction fail closed', () => {
  for (const type of ['command_execution','mcp_tool_call','web_search','file_change','todo_list','request_user_input','future_tool','commandExecution','dynamicToolCall']) assert.equal(codexTextItem(type), false);
  for (const type of ['reasoning','agent_message','agentMessage','userMessage','contextCompaction','error']) assert.equal(codexTextItem(type), true);
});
