import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { activateRelease, installRelease, listReleases, ReleaseError, releaseRoot, rollbackRelease } from './release.ts';

const usage = `super-mario release install [--from <构建产物目录>] [--root <发布根目录>] [--dependencies <依赖目录>]
super-mario release activate <提交号>
super-mario release rollback
super-mario release list

install 把已构建的产物放到 releases/<提交号>。构建记录里的提交号决定目录名，
含未提交改动的构建不能安装。正在运行的版本不能被原地覆盖。
依赖不随版本复制。每个版本通过一个链接使用同一份已安装的依赖，默认是构建目录里的 node_modules。
activate 把 current 链接切换到已安装的版本，并记住切换前的版本。
rollback 切回上一个版本。
这些命令不重启服务。切换后请执行：
  systemctl --user restart super-mario.service super-mario-agent.service
  systemctl --user is-active super-mario.service super-mario-agent.service
然后打开管理端的执行机列表，核对执行机与服务端的构建一致。`;

const short = (commit: string) => commit.slice(0, 10);
const shown = (release: { commit: string; dirty: boolean } | undefined) => release ? short(release.commit) + (release.dirty ? '（含未提交改动）' : '') : '无';

/** One line per action, so a person and a script can both read the result. */
export async function releaseCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  if (!args.length || args[0] === '--help' || args[0] === '-h') return usage;
  const [action, ...rest] = args;
  const parsed = parseArgs({ args: rest, options: { from: { type: 'string' }, root: { type: 'string' }, dependencies: { type: 'string' } }, allowPositionals: true });
  const { values, positionals } = parsed;
  // The root can be pointed elsewhere, which is how this is tried without touching a live install.
  const root = releaseRoot(values.root ?? join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'super-mario'));
  const builtTree = resolve(values.from ?? '.');
  try {
    if (action === 'install' && !positionals.length) {
      const release = await installRelease(root, builtTree, values.dependencies ?? join(builtTree, 'node_modules'));
      return { action, ...release, message: `已安装 ${short(release.commit)}。用 super-mario release activate ${release.commit} 切换到它。` };
    }
    if (action === 'activate' && positionals.length === 1 && values.from === undefined) {
      const result = await activateRelease(root, positionals[0]!);
      return { action, ...result, message: result.from && result.from !== result.to
        ? `已从 ${short(result.from)} 切换到 ${short(result.to)}。现在重启服务。`
        : `当前已是 ${short(result.to)}。现在重启服务。` };
    }
    if (action === 'rollback' && !positionals.length && values.from === undefined) {
      const result = await rollbackRelease(root);
      return { action, ...result, message: `已从 ${short(result.from!)} 回退到 ${short(result.to)}。现在重启服务。` };
    }
    if (action === 'list' && !positionals.length && values.from === undefined) {
      const state = await listReleases(root);
      return { action, ...state,
        message: [`当前 ${shown(state.releases.find(release => release.commit === state.current))}`,
          `上一个 ${shown(state.releases.find(release => release.commit === state.previous))}`,
          `已安装 ${state.releases.map(release => short(release.commit) + (release.dirty ? '*' : '')).join('、') || '无'}`].join('，') + (state.releases.some(release => release.dirty) ? '。* 含未提交改动' : '') };
    }
    throw new ReleaseError('子命令或参数无效。请查看 super-mario release --help。');
  } catch (error) {
    if (error instanceof ReleaseError) throw error;
    throw new ReleaseError('无法完成操作，请检查目录权限、可用空间和路径。');
  }
}
