// Keep the binding and path in this page. Only an identifier travels through the OS drag buffer.
import { conversationSearchActive } from './search.js';
import { toast } from '../ui/overlay.js';

const type = 'application/x-super-mario-file-reference';
let dragged;
let sequence = 0;

export function sourceOf(api, store, projectId) {
  const { snapshot, unauthorized, snapshotOwner } = store.view;
  if (!snapshot || unauthorized || snapshotOwner !== api.draftOwner()) return;
  const project = snapshot.projects.find(p => p.id === projectId && !p.archivedAt);
  if (project?.workspace) return JSON.stringify([snapshotOwner, projectId, project.workspace.machineId, project.workspace.cwd]);
}

export function makeFileDraggable(button, { api, store, projectId, path, directory }) {
  if (!path || /[\p{Cc}]/u.test(path)) return;
  const source = sourceOf(api, store, projectId);
  button.draggable = true;
  button.addEventListener('dragstart', event => {
    if (!source || !conversationSearchActive(store.view.snapshot) || sourceOf(api, store, projectId) !== source || !event.dataTransfer) { event.preventDefault(); return; }
    const id = String(++sequence);
    dragged = { id, source, path: path + (directory ? '/' : '') };
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(type, id);
  });
  button.addEventListener('dragend', () => { dragged = undefined; });
}

export function attachFileDrop({ input, store, api, getProjectId }) {
  input.addEventListener('dragover', event => {
    if (event.dataTransfer?.types.includes(type)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  });
  input.addEventListener('drop', event => {
    if (!event.dataTransfer?.types.includes(type)) return;
    event.preventDefault();
    const entry = dragged;
    dragged = undefined;
    if (input.disabled || !conversationSearchActive(store.view.snapshot) || !entry || event.dataTransfer.getData(type) !== entry.id ||
        sourceOf(api, store, getProjectId()) !== entry.source) {
      toast('请从当前项目的代码侧栏重新选择文件。', 'danger');
      return;
    }
    const start = input.selectionStart, end = input.selectionEnd;
    const lead = start > 0 && !/\s/u.test(input.value[start - 1]) ? ' ' : '';
    const replaceEnd = input.value[end] === ' ' ? end + 1 : end;
    input.setRangeText(lead + '@' + entry.path + ' ', start, replaceEnd, 'end');
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
