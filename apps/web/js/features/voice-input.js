import { h } from '../lib/dom.js';

export function createVoiceInput(input, beforeListen, api) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const button = h('button', { type: 'button', class: 'btn btn--sm' }, '语音输入');
  const caption = h('p', { role: 'status', class: 'small muted', hidden: true });
  const extensions = ['wav', 'mp3', 'webm', 'm4a', 'mp4', 'ogg', 'flac'];
  const file = h('input', { type: 'file', hidden: true, accept: extensions.map(ext => '.' + ext).join(',') });
  const choose = h('button', { type: 'button', class: 'btn btn--sm', onclick: () => { pickerBinding = binding; file.click(); } }, '录音转文字');
  const upload = h('span', null, file, choose);
  let session, binding, pending, pickerBinding;
  function show(text) {
    caption.textContent = text;
    caption.hidden = !text;
  }
  function reset() {
    pickerBinding = undefined;
    pending?.abort();
    pending = undefined;
    choose.disabled = false;
    const old = session;
    session = undefined;
    button.textContent = '语音输入';
    button.disabled = false;
    show('');
    old?.abort();
  }
  file.addEventListener('change', async () => {
    const audio = file.files?.[0];
    file.value = '';
    if (!audio || !binding || pickerBinding !== binding) return;
    reset();
    const format = audio.name.split('.').at(-1).toLowerCase();
    if (!extensions.includes(format) || !audio.size || audio.size > 8 * 1024 * 1024) {
      show('请选择不超过 8 MiB 的受支持录音。'); return;
    }
    const job = pending = new AbortController();
    choose.disabled = true;
    show('正在转写录音…');
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('无法读取录音'));
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.readAsDataURL(audio);
      });
      job.signal.throwIfAborted();
      const { text } = await api('/audio-transcription', { method: 'POST', body: { format, audio: data }, signal: job.signal });
      if (pending !== job) return;
      if (input.maxLength >= 0 && input.value.length + text.length > input.maxLength)
        throw new Error('转写文字超出消息长度限制');
      input.value += text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      show('转写已加入草稿，可编辑后发送。');
    } catch (error) {
      if (pending === job) show('转写失败：' + error.message);
    } finally {
      if (pending === job) { pending = undefined; choose.disabled = false; }
    }
  });
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
      if (pending) { pending.abort(); pending = undefined; choose.disabled = false; }
      beforeListen();
      current.start();
      button.textContent = '结束听写'; show('正在听写…');
    } catch { reset(); show('语音识别无法启动，可继续输入文字。'); }
  });
  return { button, upload, caption, reset, update(key, owner, snapshot) {
    const active = key && snapshot?.plugins?.some(p => p.id === 'voice-input' && p.status === 'active');
    key = active ? JSON.stringify([owner, key]) : null;
    if (key !== binding) reset();
    binding = key; button.hidden = !key; upload.hidden = !key;
  } };
}
