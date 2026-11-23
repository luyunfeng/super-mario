// 抽屉、确认框、轻提示。创建/编辑用抽屉，只有破坏性确认用对话框。
import { h } from '../lib/dom.js';
import { icon } from './icons.js';
import { friendlyError } from '../lib/format.js';

let toastRoot;
function toasts() {
  if (!toastRoot) { toastRoot = h('div', { class: 'toasts', 'aria-live': 'polite' }); document.body.append(toastRoot); }
  return toastRoot;
}

/** 轻提示只用于连接状态和操作失败；成功的操作在原处变化，不弹提示。 */
export function toast(message, tone = '') {
  const node = h('div', { class: `toast ${tone ? `toast--${tone}` : ''}`, role: tone === 'danger' ? 'alert' : 'status' }, message);
  toasts().append(node);
  setTimeout(() => node.remove(), tone === 'danger' ? 7000 : 3500);
  return node;
}

export function toastError(error) { toast(friendlyError(error), 'danger'); }

/** Route changes must also run each drawer's cleanup and cancel modal consent. */
export function closeOverlays(){for(const dialog of document.querySelectorAll('dialog.drawer[open], dialog.modal[open]'))dialog.close();}

/**
 * 右侧抽屉。body/footer 可以是节点或节点数组。返回 { el, body, close }。
 * Esc、点击遮罩、关闭按钮都会关闭；关闭后自动移除。
 */
export function openDrawer({ title, subtitle, body, footer, wide = false, onClose, canDismiss = () => true }) {
  const closeButton = h('button', { class: 'btn btn--ghost btn--icon btn--sm', type: 'button', 'aria-label': '关闭', title: '关闭' }, icon('x'));
  const bodyEl = h('div', { class: 'drawer__body' }, body);
  const footEl = footer ? h('div', { class: 'drawer__foot' }, footer) : null;
  const el = h('dialog', { class: `drawer ${wide ? 'drawer--wide' : ''}`, 'aria-label': title },
    h('div', { class: 'drawer__head' },
      h('div', null, h('h2', null, title), subtitle && h('p', { class: 'muted small' }, subtitle)),
      closeButton),
    bodyEl, footEl);
  const previous = document.activeElement;
  const close = () => { if (el.open) el.close(); };
  const dismiss = () => { if (canDismiss()) close(); };
  closeButton.addEventListener('click', dismiss);
  el.addEventListener('cancel', event => { if (!canDismiss()) event.preventDefault(); });
  el.addEventListener('click', (event) => { if (event.target === el) dismiss(); });
  el.addEventListener('close', () => { el.remove(); onClose?.(); previous?.focus?.(); });
  document.body.append(el);
  el.showModal();
  return { el, body: bodyEl, foot: footEl, close };
}

/** 破坏性或高风险操作的确认。正文必须写明后果，按钮用具体动词。 */
export function confirmDialog({ title, message, confirmLabel = '确认', danger = false, signal }) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let answer = false;
    const ok = h('button', { class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, type: 'button' }, confirmLabel);
    const cancel = h('button', { class: 'btn', type: 'button' }, '取消');
    const el = h('dialog', { class: 'modal', 'aria-label': title },
      h('h2', null, title), h('div', { class: 'small' }, message), h('div', { class: 'modal__actions' }, cancel, ok));
    ok.addEventListener('click', () => { answer = true; el.close(); });
    cancel.addEventListener('click', () => el.close());
    const abort = () => { answer=false; el.close(); };
    signal?.addEventListener('abort',abort,{once:true});
    el.addEventListener('close', () => { signal?.removeEventListener('abort',abort); el.remove(); resolve(answer); });
    document.body.append(el);
    el.showModal();
    cancel.focus();
  });
}
