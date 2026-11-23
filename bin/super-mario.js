#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
// Published packages use JavaScript: Node does not strip TypeScript in node_modules.
const compiled = process.env.SUPER_MARIO_DEV !== '1' && existsSync(new URL('../dist/packages/core/src/config.js', import.meta.url));
const { readServerOptions, serverDataDirectory } = await import(compiled ? '../dist/packages/core/src/config.js' : '../packages/core/src/config.ts');

async function main() {
  if (process.argv[2] !== 'office' && existsSync('.env')) process.loadEnvFile('.env');
  if (process.argv[2] === 'admin') {
    if (process.argv[3] !== 'setup-code') throw new Error('用法：super-mario admin setup-code [--port 端口]');
    const {values} = parseArgs({args:process.argv.slice(4),options:{port:{type:'string'}}});
    const port = Number(values.port ?? process.env.SUPER_MARIO_PORT ?? (process.env.SUPER_MARIO_DEV === '1' ? 3001 : 3000));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('请指定有效的服务端口');
    const token = process.env.SUPER_MARIO_TOKEN;
    if (!token) throw new Error('请通过 SUPER_MARIO_TOKEN 提供本机服务的工作台主令牌');
    // Always contact the local service. Do not forward the credential across redirects.
    const host = process.env.SUPER_MARIO_HOST === '::1' ? '[::1]' : '127.0.0.1';
    const response = await fetch(`http://${host}:${port}/api/v1/admin/setup-code`, {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(10000),
      headers:{authorization:'Bearer '+token,'content-type':'application/json'}, body:'{}',
    });
    if (!response.ok) throw new Error('无法领取设置码（HTTP '+response.status+'），请核对服务端口、主令牌和首次设置状态');
    const result = await response.json();
    if (typeof result.code !== 'string' || !/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(result.code)) throw new Error('未收到有效设置码');
    console.log(result.code);
    return;
  }
  if (process.argv[2] === 'backup') {
    const { backupCli } = await import(compiled ? '../dist/plugins/backup/cli.js' : '../plugins/backup/cli.ts');
    const result = await backupCli(process.argv.slice(3), serverDataDirectory());
    console.log(typeof result === 'string' ? result : JSON.stringify(result));
    return;
  }
  if (process.argv[2] === 'office') {
    const { officeCli } = await import(compiled ? '../dist/plugins/office/cli.js' : '../plugins/office/cli.ts');
    console.log(JSON.stringify(await officeCli(process.argv.slice(3))));
    return;
  }
  const config = readServerOptions(process.argv.slice(2));
  if (config.help) {
    console.log(`Super Mario — 个人 AI 工作台

用法: super-mario [选项]
      super-mario office <docx|pptx|xlsx> <源文件> [-o 输出文件] [--title 标题]
      super-mario office check <办公文件>
      super-mario admin setup-code [--port 端口]
      super-mario backup --help
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
main().catch(error => { console.error((process.argv[2] === 'admin' ? '管理员操作失败：' : process.argv[2] === 'backup' ? '备份操作失败：' : process.argv[2] === 'office' ? '办公文件处理失败：' : '启动失败：') + error.message); process.exitCode = 1; });
