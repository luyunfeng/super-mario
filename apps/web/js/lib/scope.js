// 顶栏的“项目范围”。对话、待办、执行、记忆都按它过滤；空字符串表示全部项目。
import { readLocal, writeLocal } from './dom.js';

export function createScope() {
  const listeners = new Set();
  let value = readLocal('sm.scope', '');
  return {
    get: () => value,
    set(next) { if (next === value) return; value = next; writeLocal('sm.scope', value); for (const fn of listeners) fn(value); },
    /** 项目被归档或删除后，范围回到“全部”。 */
    validate(projects) { if (value && !projects.some(item => item.id === value && !item.archivedAt)) this.set(''); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
