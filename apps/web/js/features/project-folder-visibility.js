// 隐藏只是当前浏览器的显示偏好，不删除远端目录，不归档项目。
import { readLocal, writeLocal } from '../lib/dom.js';
const storageKey = 'sm.project-folders.hidden.v1';
const eventName = 'project-folder-visibility';
export const folderKey = (machineId, cwd) => JSON.stringify([machineId, cwd]);
export function hiddenFolders() {
  const values = readLocal(storageKey, []);
  return new Set(Array.isArray(values) ? values.filter(value => typeof value === 'string') : []);
}
export function setFolderHidden(machineId, cwd, hidden) {
  const values = hiddenFolders(), key = folderKey(machineId, cwd);
  if (hidden) values.add(key); else values.delete(key);
  writeLocal(storageKey, [...values]);
  window.dispatchEvent(new Event(eventName));
}
export function onFolderVisibilityChange(listener) {
  const storage = event => { if (event.key === storageKey || event.key === null) listener(); };
  window.addEventListener(eventName, listener);
  window.addEventListener('storage', storage);
  return () => { window.removeEventListener(eventName, listener); window.removeEventListener('storage', storage); };
}
