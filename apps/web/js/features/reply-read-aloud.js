import { h } from '../lib/dom.js';

export function createReplyReadAloud(router, beforeSpeak) {
  let binding, playback;
  function stop() {
    if (!playback) return;
    const { button } = playback;
    playback = null;
    button.textContent = '朗读回复';
    window.speechSynthesis?.cancel();
  }
  router.subscribe(stop);
  return {
    stop,
    update(key, owner, snapshot) {
      const active = key && snapshot?.plugins?.some(p => p.id === 'reply-read-aloud' && p.status === 'active');
      const next = active ? JSON.stringify([owner, key]) : '';
      if (binding !== next) stop();
      binding = next;
    },
    get active() { return Boolean(binding); },
    action(message, displayedText) {
      if (!binding || message.role !== 'assistant' || (message.status ?? 'done') !== 'done' || !message.text?.trim()) return null;
      const button = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, '朗读回复');
      const feedback = h('span', { role: 'status', class: 'small muted', hidden: true });
      if (playback?.id === message.id) {
        playback.button = button;
        playback.feedback = feedback;
        button.textContent = '停止朗读';
      }
      button.addEventListener('click', () => {
        const same = playback?.id === message.id;
        stop();
        feedback.hidden = true;
        if (same) return;
        if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
          feedback.hidden = false; feedback.textContent = '当前浏览器不支持朗读。'; return;
        }
        // Feed only the selected response to speech synthesis. Short chunks avoid
        // engine length limits without altering the words or splitting a code point.
        beforeSpeak();
        const chunks = displayedText(message).match(/[\s\S]{1,180}(?:[。！？.!?\n]|\s)|[\s\S]{1,180}/gu) || [];
        const current = playback = { id: message.id, button, feedback };
        button.textContent = '停止朗读';
        function next(index) {
          if (current !== playback) return;
          if (index >= chunks.length) { stop(); return; }
          const failed = () => {
            if (current !== playback) return;
            stop(); current.feedback.hidden = false; current.feedback.textContent = '朗读中断，可重新朗读。';
          };
          try {
            const utterance = new SpeechSynthesisUtterance(chunks[index]);
            utterance.onend = () => next(index + 1);
            utterance.onerror = failed;
            window.speechSynthesis.speak(utterance);
          } catch { failed(); }
        }
        next(0);
      });
      return h('span', null, button, feedback);
    },
  };
}
