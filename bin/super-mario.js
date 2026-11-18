#!/usr/bin/env node
import { existsSync } from 'node:fs';
// Published packages use JavaScript: Node does not strip TypeScript in node_modules.
const compiled = process.env.SUPER_MARIO_DEV !== '1' && existsSync(new URL('../dist/packages/core/src/config.js', import.meta.url));
const { readServerOptions } = await import(compiled ? '../dist/packages/core/src/config.js' : '../packages/core/src/config.ts');

async function main() {
  // Local credentials are ignored by Git; process environment takes precedence.
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = readServerOptions(process.argv.slice(2));
  if (config.help) {
    console.log(`Super Mario — 个人 AI 工作台

用法: super-mario [选项]
  --demo                  本地演示，不调用模型或真实执行者
  --host <地址>           默认 127.0.0.1
  --port <端口>           默认 3000
  --data-dir <目录>       默认 ~/.super-mario
  --token <令牌>          API和执行机连接令牌；推荐用 SUPER_MARIO_TOKEN
  --provider <供应商>     与 --model 同时提供
  --model <模型>          pi 模型名称
  --help, -h              查看帮助
  --version, -v           查看版本

本地验证: super-mario --demo
Web 页面与 API 由同一服务提供。`);
    return;
  }
  if (config.version) { console.log('0.1.0'); return; }
  const { startServer } = await import(compiled ? '../dist/apps/server/src/index.js' : '../apps/server/src/index.ts');
  const running = await startServer(config);
  console.log(`Super Mario ${config.demo ? '[演示模式]' : ''}\nWeb: ${running.url}\n数据: ${config.dataDir}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await running.close(); process.exitCode = 0; } catch (error) { console.error(error.message); process.exitCode = 1; }
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
main().catch(error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
