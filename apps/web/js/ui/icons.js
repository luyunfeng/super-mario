// 线性图标，统一 24 栅格、1.8 描边。图标只做辅助，文字永远在旁边或有 aria-label。
import { svg } from '../lib/dom.js';

const p = d => ['path', { d }];
const circle = (cx, cy, r) => ['circle', { cx, cy, r }];
const rect = (x, y, width, height, rx) => ['rect', { x, y, width, height, rx }];

const shapes = {
  chat: [p('M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z')],
  inbox: [p('M4 4h16l2 10v6H2v-6L4 4Z'), p('M2 14h6l2 3h4l2-3h6')],
  agent: [p('M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3Z'), p('M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8L18 15Z')],
  projects: [p('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z')],
  memory: [p('M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Z'), p('M5 17a3 3 0 0 1 3-3h11')],
  channels: [p('M22 3 11 14'), p('M22 3l-7 18-4-7-7-4 18-7Z')],
  info: [circle(12, 12, 9), p('M12 11v5'), p('M12 8h.01')],
  plus: [p('M12 5v14M5 12h14')],
  check: [p('M5 12.5l4.5 4.5L19 7.5')],
  x: [p('M6 6l12 12M18 6 6 18')],
  search: [circle(11, 11, 7), p('m20 20-3.5-3.5')],
  send: [p('M12 19V5'), p('m5 12 7-7 7 7')],
  copy: [rect(9, 9, 11, 11, 2), p('M5 15V6a2 2 0 0 1 2-2h9')],
  more: [circle(5, 12, 1), circle(12, 12, 1), circle(19, 12, 1)],
  chevron: [p('m9 6 6 6-6 6')],
  back: [p('m15 6-6 6 6 6')],
  terminal: [p('m5 8 4 4-4 4'), p('M12 17h7'), rect(2, 4, 20, 16, 2)],
  alert: [p('M12 3 2 20h20L12 3Z'), p('M12 10v4'), p('M12 17h.01')],
};

export function icon(name, className = '') {
  if (!shapes[name]) throw new Error(`Unknown icon: ${name}`);
  return svg(shapes[name], className);
}
