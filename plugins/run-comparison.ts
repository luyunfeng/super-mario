import type { Extension } from '../packages/plugin-sdk/src/index.ts';
import type { Json } from '../packages/protocol/src/index.ts';

export function createRunComparison(read: (id: string, path?: string) => Promise<Json>, status: (id: string) => Promise<Json>): Extension {
  return {
    id: 'run-comparison', name: '执行对比', capabilities: ['web.runComparison', 'runs.diff.read'],
    activate(context) {
      context.contribute('tools', 'run_worktree_status', {
        name: 'run_worktree_status', description: '读取本次执行独立工作树的当前分支、未提交文件和未进入来源目录当前 HEAD 的提交数。文件列表可能截断。目录已清理时返回 removedAt，以及保留分支的实时状态或分支删除回执时间 branchDeletedAt。',
        parameters: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string' } } },
        async execute({ id }, signal) {
          signal.throwIfAborted();
          if (typeof id !== 'string' || !id) throw new Error('缺少执行 ID');
          const result = await status(id);
          signal.throwIfAborted();
          return result;
        },
      });
      context.contribute('tools', 'run_commit_diff', {
        name: 'run_commit_diff', description: '读取一次执行的两个已记录提交之间的差异。省略 path 列出文件，传入返回的路径读取补丁。nextOffset 非空时可继续读取。',
        parameters: { type: 'object', required: ['id'], additionalProperties: false, properties: {
          id: { type: 'string', description: 'runs_list 返回的执行 ID' }, path: { type: 'string' },
          offset: { type: 'integer', minimum: 0 },
        } },
        async execute(args, signal): Promise<Json> {
          signal.throwIfAborted();
          const { id, path, offset = 0 } = args;
          if (typeof id !== 'string' || !id || path !== undefined && typeof path !== 'string'
            || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('执行差异参数无效');
          const result = await read(id, path);
          signal.throwIfAborted();
          if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('差异回执无效');
          if (path === undefined && Array.isArray(result.files)) {
            const files: string[] = [];
            let size = 0;
            for (const file of result.files.slice(offset, offset + 64)) {
              if (typeof file !== 'string') throw new Error('文件列表回执无效');
              if (files.length && size + file.length > 16000) break;
              files.push(file);
              size += file.length;
            }
            return { id, files, hidden: result.hidden ?? 0, nextOffset: offset + files.length < result.files.length ? offset + files.length : null };
          }
          if (path !== undefined && result.path === path && typeof result.text === 'string') {
            const text = result.text.slice(offset, offset + 16000);
            return { id, path, text, nextOffset: offset + text.length < result.text.length ? offset + text.length : null };
          }
          throw new Error('差异回执无效');
        },
      });
    },
  };
}
