import { cp, mkdir, rm } from 'node:fs/promises';
const destination = new URL('../dist/apps/web/', import.meta.url);
// 先清空再复制，避免改名或删除的前端文件残留在构建产物里。
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(new URL('../apps/web/', import.meta.url), destination, { recursive: true });

for (const name of ['change-watch','approval-followup']) {
  await cp(new URL(`../plugins/examples/${name}/super-mario.extension.json`, import.meta.url), new URL(`../dist/plugins/examples/${name}/super-mario.extension.json`, import.meta.url));
}
await cp(new URL('../plugins/command-inbox/super-mario.extension.json', import.meta.url), new URL('../dist/plugins/command-inbox/super-mario.extension.json', import.meta.url));
