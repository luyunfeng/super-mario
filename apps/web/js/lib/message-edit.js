import { h, replace } from './dom.js';

export function createMessageEdit({ input, quote, context }) {
  const notice = h('div', { class: 'small', role: 'status', hidden: true });
  let previous;

  function reset() {
    previous = undefined;
    notice.hidden = true;
    replace(notice);
  }

  function active(scope) {
    const live = context();
    return live.enabled && live.key && live.owner && live.key === scope.key && live.owner === scope.owner;
  }

  function write(text, start = text.length, end = start, direction = 'none') {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    input.setSelectionRange(start, end, direction);
  }

  function action(message) {
    const scope = context();
    if (!scope.enabled || !scope.key || !scope.owner || message.role !== 'user' || message.readOnly ||
        (message.origin !== undefined && message.origin !== 'user') || typeof message.text !== 'string' || !message.text.trim()) return null;

    return h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-label': '编辑消息', onclick: () => {
      if (!active(scope) || input.disabled) return;
      const { quotesEnabled } = context();
      const draft = { text: input.value, quote: quotesEnabled ? quote.capture() : quote.swapHidden(scope.key, ''), quotesEnabled,
        start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
      previous = draft;
      write(quotesEnabled ? quote.restoreMessage(message.text) : message.text);
      notice.hidden = false;
      replace(notice, '修改后将作为新消息发送。 ', h('button', { type: 'button', class: 'btn btn--ghost btn--sm',
        'aria-label': '撤销替换', onclick: () => {
          if (previous !== draft || !active(scope) || input.disabled || context().quotesEnabled !== draft.quotesEnabled) return;
          reset();
          if (draft.quotesEnabled) quote.setSelection(draft.quote);
          else quote.swapHidden(scope.key, draft.quote);
          write(draft.text, draft.start, draft.end, draft.direction);
        } }, '撤销替换'));
    } }, '编辑');
  }

  // A send receipt may arrive after another message has been opened for editing.
  function onAccepted() {
    const submitted = previous;
    return () => { if (submitted && submitted === previous) reset(); };
  }

  return { notice, action, reset, onAccepted };
}
