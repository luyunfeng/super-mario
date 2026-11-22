import { h } from '../lib/dom.js';

export function createVoiceInput(input, beforeListen) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const button = h('button', { type: 'button', class: 'btn btn--sm' }, '语音输入');
  const caption = h('p', { role: 'status', class: 'small muted', hidden: true });
  let session, binding;
  function show(text) {
    caption.textContent = text;
    caption.hidden = !text;
  }
  function reset() {
    const old = session;
    session = undefined;
    button.textContent = '语音输入';
    button.disabled = false;
    show('');
    old?.abort();
  }
  button.addEventListener('click', () => {
    if (session) {
      button.disabled = true;
      try { session.stop(); } catch { reset(); }
      return;
    }
    if (!Recognition) { show('当前浏览器不支持语音识别，可继续输入文字。'); return; }
    try {
      const current = session = new Recognition();
      current.lang = document.documentElement.lang || 'zh-CN';
      current.interimResults = true;
      current.continuous = true;
      current.onresult = event => {
        if (session !== current) return;
        let partial = '', confirmed = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) confirmed += result[0].transcript;
          else partial += result[0].transcript;
        }
        if (confirmed) {
          if (input.maxLength >= 0 && input.value.length + confirmed.length > input.maxLength) {
            reset(); show('识别文字超出消息长度限制，已停止语音输入。'); return;
          }
          input.value += confirmed;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        show(partial || '正在听写…');
      };
      current.onerror = event => {
        if (session !== current) return;
        reset();
        show(event.error === 'not-allowed' ? '麦克风权限被拒绝，可继续输入文字。' : '语音识别中断，可重试或继续输入文字。');
      };
      current.onend = () => {
        if (session !== current) return;
        session = undefined; reset(); input.focus();
      };
      beforeListen();
      current.start();
      button.textContent = '结束听写'; show('正在听写…');
    } catch { reset(); show('语音识别无法启动，可继续输入文字。'); }
  });
  return { button, caption, reset, update(key, owner, snapshot) {
    const active = key && snapshot?.plugins?.some(p => p.id === 'voice-input' && p.status === 'active');
    key = active ? JSON.stringify([owner, key]) : null;
    if (key !== binding) reset();
    binding = key; button.hidden = !key;
  } };
}
