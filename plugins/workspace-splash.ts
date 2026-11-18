import type { Extension } from '../packages/plugin-sdk/src/index.ts';

/** Optional presentation plugin, independent of the eight system capabilities. */
export const workspaceSplash: Extension = {
  id: 'workspace-splash', name: '工作台开屏', capabilities: ['web.startup'],
  activate(context) {
    const duration = context.config.durationMs ?? 2600;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 600 || duration > 5000) throw new Error('开屏时长必须在 600–5000 毫秒之间');
    context.contribute('web_extensions', context.id, {
      slot: 'startup', renderer: 'brand-splash',
      title: typeof context.config.title === 'string' ? context.config.title : 'Super Mario',
      subtitle: typeof context.config.subtitle === 'string' ? context.config.subtitle : '让每一个目标，都有下一步。',
      durationMs: duration,
    });
  },
};
