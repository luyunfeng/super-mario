import { h } from './dom.js';

export async function copyText(text, html) {
  if (html !== undefined && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      })]);
      return;
    } catch { /* Try the text clipboard when rich content is unavailable. */ }
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Plain HTTP workbenches may have only the synchronous copy event.
    const selection = h('textarea', { value: text, readOnly: true, style: { position: 'fixed', opacity: '0' } });
    const previous = document.activeElement;
    (previous?.closest('dialog[open]') ?? document.body).append(selection);
    selection.select();
    selection.addEventListener('copy', event => {
      if (!event.clipboardData) return;
      event.clipboardData.setData('text/plain', text);
      if (html !== undefined) event.clipboardData.setData('text/html', html);
      event.preventDefault();
    });
    try {
      if (!document.execCommand('copy')) throw new Error('剪贴板不可用');
    } finally {
      selection.remove();
      previous?.focus?.({ preventScroll: true });
    }
  }
}
