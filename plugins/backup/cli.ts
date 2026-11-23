import { parseArgs } from 'node:util';
import { BackupError } from './format.ts';

const usage = `super-mario backup create [--data-dir <数据目录>] --output <新备份包>
super-mario backup verify <备份包>
super-mario backup inspect <备份包>
super-mario backup restore <备份包> --data-dir <尚不存在的目标目录>

创建前先停止所有写入该数据目录的进程。备份包含私密配置，请妥善保管。
verify 校验归档内容，inspect 同时汇总数据库、知识和附件覆盖情况。restore 还会检查恢复出的 SQLite 数据库。`;

export async function backupCli(args: string[], defaultDirectory: string) {
  if (!args.length || args[0] === '--help' || args[0] === '-h') return usage;
  const [action, ...rest] = args;
  let parsed;
  try {
    parsed = parseArgs({args:rest, options:{'data-dir':{type:'string'}, output:{type:'string'}}, allowPositionals:true});
  } catch { throw new BackupError('参数格式无效。请查看 super-mario backup --help。'); }
  const {values, positionals} = parsed;
  const directory = values['data-dir'];
  try {
    if (action === 'create' && !positionals.length && values.output && directory !== '') {
      const {createBackup} = await import('./create.ts');
      return {action, ...await createBackup(directory ?? defaultDirectory, values.output)};
    }
    if (action === 'inspect' && positionals.length === 1 && positionals[0] && directory === undefined && values.output === undefined) {
      const {inspectBackup} = await import('./read.ts');
      return {action, ...await inspectBackup(positionals[0])};
    }
    if (positionals.length === 1 && positionals[0] && values.output === undefined &&
        ((action === 'verify' && directory === undefined) || (action === 'restore' && directory))) {
      const {readBackup} = await import('./read.ts');
      return {action, ...await readBackup(positionals[0], directory)};
    }
    throw new BackupError('子命令或参数无效。请查看 super-mario backup --help。');
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError('无法完成操作，请检查文件权限、可用空间和备份包完整性。');
  }
}
