import { h } from '../lib/dom.js';
import { openDrawer } from '../ui/overlay.js';

export function openTerminalWall(api, projectId) {
  const params = new URLSearchParams();
  if (projectId && projectId !== 'all') params.set('projectId', projectId);
  const frame = h('iframe', { title: '多屏终端', src: '/terminals.html' + (params.size ? '?' + params : '') });
  // The same-origin child uses the live workbench client, including memory-only credentials.
  frame.workbenchApi = api;
  const drawer = openDrawer({ title: '多屏现场', body: frame });
  drawer.el.classList.add('terminal-wall');
}
