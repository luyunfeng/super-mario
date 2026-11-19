import type { Extension } from '../packages/plugin-sdk/src/index.ts';

export const tokenStatistics: Extension = {
  id: 'token-statistics', name: 'Token 统计', capabilities: ['usage.read'],
  navigation: [{ id: 'dashboard', label: 'Token 统计', route: '#agent?tokenStats=1' }],
  activate() {},
};
