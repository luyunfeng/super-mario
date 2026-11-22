import type { Extension } from '../packages/plugin-sdk/src/index.ts';
import type { MainAssistantProfile } from '../packages/protocol/src/index.ts';

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

export const assistantProfile: Extension = {
  id: 'assistant-profile', name: '主助手资料', capabilities: ['assistant.profile'],
  permissions: ['service.provide:assistant-profile.manage', 'store.read', 'store.write', 'events.publish'],
  activate({ store, events, provide }) {
    const read = (): MainAssistantProfile => store.get<MainAssistantProfile>('assistant-profile', 'main') ?? { name: '主 Agent', revision: 0 };
    provide('assistant-profile.manage', input => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, '主助手资料参数必须为对象');
      const { action, revision } = input;
      if (action !== 'read' && action !== 'save') fail(400, '主助手资料操作无效');
      const allowed = action === 'read' ? ['action'] : ['action', 'name', 'revision'];
      if (Object.keys(input).some(key => !allowed.includes(key))) fail(400, '主助手资料包含未知字段');
      if (action === 'read') return read();
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER)
        fail(400, '主助手资料版本无效');
      // Check the original string before trimming so a leading newline or tab cannot be hidden.
      if (typeof input.name !== 'string' || /[\p{Cc}\p{Cs}\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(input.name))
        fail(400, '名称不能包含控制字符或换行');
      const name = input.name.trim();
      if (!name || name.length > 80 || Array.from(name).length > 40) fail(400, '名称须为 1 至 40 个字符');
      return store.transaction(() => {
        const current = read();
        if (current.revision !== revision) fail(409, '主助手资料已更新，请重新加载');
        if (name === current.name) return current;
        const next = { name, revision: revision + 1 };
        store.put('assistant-profile', 'main', next);
        events.publish('assistant-profile.changed', { revision: next.revision });
        return next;
      });
    });
  },
};
