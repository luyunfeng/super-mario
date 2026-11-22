import type { Extension } from '../packages/plugin-sdk/src/index.ts';

export const conversationSearch: Extension = {
  id: 'conversation-search', name: '对话历史搜索', capabilities: ['conversation.search'],
  activate() {},
};
