import { openDrawer } from '../ui/overlay.js';
import { Button, Field, Input, TextArea } from '../ui/kit.js';
import { h } from '../lib/dom.js';

export function createVoiceInput(input, beforeListen, api) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const idleLabel = Recognition ? '语音输入' : '录音后转写';
  const button = h('button', { type: 'button', class: 'btn btn--sm' }, idleLabel);
  const caption = h('p', { role: 'status', class: 'small muted', hidden: true });
  const extensions = ['wav', 'mp3', 'webm', 'm4a', 'mp4', 'ogg', 'flac'];
  const file = h('input', { type: 'file', hidden: true, accept: extensions.map(ext => '.' + ext).join(',') });
  const choose = h('button', { type: 'button', class: 'btn btn--sm', onclick: () => { pickerBinding = binding; file.click(); } }, '录音转文字');
  const meeting = Button({ label: '整理会议转写', size: 'sm', onClick: reviewMeeting });
  meeting.hidden = true;
  const record = Recognition && Button({ label: '录音后转写', size: 'sm', onClick: recordForTranscription });
  const pause = Button({ label: '暂停录音', size: 'sm', onClick: () => session?.togglePause?.() });
  const retry = Button({ label: '重试转写', size: 'sm', onClick: () => {
    if (retainedAudio && binding) void transcribe(retainedAudio);
  } });
  const discard = Button({ label: '丢弃录音片段', size: 'sm', onClick: () => { reset(); show('已丢弃录音片段。'); } });
  pause.hidden = retry.hidden = discard.hidden = true;
  const upload = h('span', null, file, choose, record, pause, retry, discard, meeting);
  let transcript, destination, review;
  function reviewMeeting() {
    if (!transcript || !destination) return;
    const captured = binding;
    const title = Input({ value: transcript.title, maxLength: 500 });
    const recorded = transcript.startedAt;
    const localStart = recorded && new Date(recorded.getTime() - recorded.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const started = Input({ type: 'datetime-local', value: localStart || '' });
    const offset = Input({ placeholder: '+08:00', disabled: !recorded });
    let customOffset = false;
    offset.addEventListener('input', () => { customOffset = Boolean(offset.value); });
    started.addEventListener('input', () => {
      offset.disabled = !started.value;
      if (!started.value) { offset.value = ''; customOffset = false; return; }
      if (customOffset) return;
      const minutes = -(started.value === localStart ? recorded : new Date(started.value)).getTimezoneOffset();
      if (Number.isFinite(minutes)) offset.value = (minutes < 0 ? '-' : '+') +
        String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0') + ':' + String(Math.abs(minutes) % 60).padStart(2, '0');
    });
    if (recorded) started.dispatchEvent(new Event('input'));
    const body = TextArea({ value: transcript.text, rows: 12, maxLength: 200000 });
    const status = h('p', { role: 'status' });
    const save = Button({ label: '提交会议整理', onClick: async () => {
      if (binding !== captured || !destination || !review?.el.open) return;
      if (!title.value.trim() || !body.value.trim()) { status.textContent = '请填写会议标题并核对转写正文。'; return; }
      if (started.validity.badInput || (started.value && !/^(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(offset.value.trim()))) {
        status.textContent = '请核对会议日期和 UTC 偏移，例如 +08:00。'; return;
      }
      save.disabled = true;
      const dialog = review;
      try {
        const job = await api.post('/knowledge/sources', { materialKind: 'meeting-transcript', title: title.value.trim(),
          ...(started.value ? { meetingStartedAt: started.value + offset.value.trim() } : {}),
          text: body.value.trim(), layer: destination.projectId ? 'project' : 'personal', ...(destination.projectId ? { projectId: destination.projectId } : {}) });
        if (binding !== captured || review !== dialog) return;
        dialog.close(); transcript = null; meeting.hidden = true;
        show('已登记「' + job.title + '」。');
        caption.append(h('a', { href: '#memory?curator=1' }, '查看整理队列'));
      } catch (error) { status.textContent = error.message; }
      finally { save.disabled = false; }
    } });
    const dialog = openDrawer({ title: '核对会议转写', subtitle: '保存到' + destination.label,
      body: [Field({ label: '会议标题', control: title }), Field({ label: '会议开始时间（可选）', control: started, hint: recorded ? '已填入开始录音的时间，可按实际开会时间修改。' : undefined }),
        Field({ label: '会议时区（UTC 偏移）', control: offset, hint: '默认使用本机在所选日期的偏移，可按会议所在地修改。' }), Field({ label: '转写正文', control: body }), status],
      footer: save, onClose: () => { if (review === dialog) review = null; } });
    review = dialog;
  }
  let session, binding, pending, pickerBinding, retainedAudio;
  function show(text) {
    caption.textContent = text;
    caption.hidden = !text;
  }
  function reset() {
    review?.close(); review = null; transcript = null; meeting.hidden = true;
    pickerBinding = undefined;
    retainedAudio = undefined;
    pause.hidden = retry.hidden = discard.hidden = true;
    if (record) record.hidden = false;
    pending?.abort();
    pending = undefined;
    choose.disabled = false;
    const old = session;
    session = undefined;
    button.textContent = idleLabel;
    button.disabled = false;
    show('');
    old?.abort();
  }
  file.addEventListener('change', async () => {
    const audio = file.files?.[0];
    file.value = '';
    if (!audio || !binding || pickerBinding !== binding) return;
    reset();
    await transcribe({ audio, format: audio.name.split('.').at(-1).toLowerCase(), title: audio.name.replace(/\.[^.]+$/, '') });
  });
  async function transcribe(recording) {
    const { audio, format, title, startedAt, partial, pauses = [] } = recording;
    if (!extensions.includes(format) || !audio.size || audio.size > 8 * 1024 * 1024) {
      show('请选择不超过 8 MiB 的受支持录音。'); return;
    }
    retainedAudio = undefined; retry.hidden = discard.hidden = true;
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
      const result = await api('/audio-transcription', { method: 'POST', body: { format, audio: data }, signal: job.signal });
      if (pending !== job) return;
      const coverage = [];
      if (partial) coverage.push('〔录音中断，仅含中断前的片段〕');
      if (pauses.length) {
        const ranges = pauses.map(({ from, to }) => (from / 1000).toFixed(3) + '–' + (to / 1000).toFixed(3));
        coverage.push('〔手动暂停，距开始录音的秒数：' + ranges.join('、') + '〕');
      }
      const text = [...coverage, result.text].join('\n');
      // Keep the full provider text even if timing exists for only some utterances.
      const segments = result.segments?.map(row => '[' + row.start + '–' + row.end + ' 秒] ' +
        (row.speaker ? row.speaker + '：' : '') + row.text);
      const reviewedText = segments?.length ? text + '\n\n录音分段（音频内时间）：\n' + segments.join('\n') : text;
      transcript = { title, text: reviewedText, startedAt };
      const addition = coverage.length && input.value && !input.value.endsWith('\n') ? '\n' + text : text;
      meeting.hidden = !destination;
      if (input.maxLength >= 0 && input.value.length + addition.length > input.maxLength) {
        show(destination ? '转写超过消息长度限制，可核对后提交会议整理。' : '转写文字超出消息长度限制。'); return;
      }
      input.value += addition;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      show('转写已加入草稿，可编辑后发送。');
    } catch (error) {
      if (pending === job) {
        retainedAudio = recording;
        retry.textContent = '重试转写'; retry.hidden = false; discard.hidden = !partial;
        show('转写失败：' + error.message);
      }
    } finally {
      if (pending === job) { pending = undefined; choose.disabled = false; }
    }
  }
  async function recordForTranscription() {
    const mime = ['audio/webm', 'audio/mp4', 'audio/ogg'].find(type => window.MediaRecorder?.isTypeSupported(type));
    if (!mime || !navigator.mediaDevices?.getUserMedia) {
      show('当前浏览器不支持麦克风录音，可选择已有录音文件。'); return;
    }
    reset();
    let stream, recorder, startedAt, confirmed = false;
    const pauses = [];
    let clockStart, pauseStart;
    function endPause() {
      if (pauseStart === undefined) return;
      pauses.push({ from: pauseStart, to: performance.now() - clockStart });
      pauseStart = undefined;
    }
    const current = session = {
      abort() {
        if (recorder && recorder.state !== 'inactive') recorder.stop();
        stream?.getTracks().forEach(track => track.stop());
      },
      togglePause() {
        if (confirmed || !recorder || recorder.state === 'inactive') return;
        const pausing = recorder.state === 'recording';
        if (pausing) {
          recorder.pause();
          pauseStart = performance.now() - clockStart;
        } else {
          recorder.resume();
          endPause();
        }
        for (const track of stream.getAudioTracks()) track.enabled = !pausing;
        pause.textContent = pausing ? '继续录音' : '暂停录音';
        show(pausing ? '录音已暂停，可继续录音或结束并转写。' : '正在录音，结束后会发送到服务端转写。');
      },
      stop() {
        if (!recorder) { reset(); return; }
        confirmed = true;
        endPause();
        recorder.stop();
      },
    };
    beforeListen();
    if (record) record.hidden = true;
    button.textContent = '取消录音';
    show('正在请求麦克风权限…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (session !== current) { current.abort(); return; }
      recorder = new MediaRecorder(stream, { mimeType: mime });
      const chunks = [];
      let size = 0;
      recorder.ondataavailable = event => {
        if (session !== current || !event.data.size) return;
        size += event.data.size;
        if (size > 8 * 1024 * 1024) { reset(); show('录音超过 8 MiB，已停止。'); return; }
        chunks.push(event.data);
      };
      function interrupted() {
        if (session !== current) return;
        confirmed = false;
        endPause();
        button.disabled = pause.disabled = true;
        if (recorder.state !== 'inactive') recorder.stop();
      }
      recorder.onerror = interrupted;
      for (const track of stream.getAudioTracks()) track.addEventListener('ended', interrupted, { once: true });
      recorder.onstop = () => {
        if (session !== current) return;
        endPause();
        reset();
        const audio = new Blob(chunks, { type: mime });
        const recording = { audio, format: mime.slice(6), title: confirmed ? '会议转写' : '会议转写片段', startedAt, pauses, partial: !confirmed };
        if (confirmed) void transcribe(recording);
        else if (audio.size) {
          retainedAudio = recording;
          retry.textContent = '转写已录片段'; retry.hidden = discard.hidden = false;
          show('录音中断。已录片段保留在当前对话，尚未上传。');
        } else show('录音中断，未取得音频。');
      };
      recorder.start(500);
      clockStart = performance.now();
      startedAt = new Date();
      pause.textContent = '暂停录音'; pause.disabled = false; pause.hidden = false;
      button.textContent = '结束并转写';
      show('正在录音，结束后会发送到服务端转写。');
    } catch (error) {
      if (session !== current) return;
      reset();
      show(error.name === 'NotAllowedError' ? '麦克风权限被拒绝，可选择录音文件。' : '麦克风录音无法启动。');
    }
  }
  button.addEventListener('click', () => {
    if (session) {
      button.disabled = true;
      try { session.stop(); } catch { reset(); }
      return;
    }
    if (!Recognition) { void recordForTranscription(); return; }
    try {
      reset();
      record.hidden = true;
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
  return { button, upload, caption, reset, update(key, owner, snapshot, projectId) {
    const active = key && snapshot?.plugins?.some(p => p.id === 'voice-input' && p.status === 'active');
    key = active ? JSON.stringify([owner, key]) : null;
    if (key !== binding) reset();
    const project = projectId && snapshot?.projects?.find(p => p.id === projectId && !p.archivedAt);
    destination = key && snapshot.plugins.some(p => p.id === 'knowledge-local' && p.status === 'active') && (!projectId || project)
      ? { projectId, label: project ? '项目记忆 · ' + project.name : '个人记忆' } : null;
    if (!destination) review?.close();
    meeting.hidden = !destination || !transcript;
    binding = key; button.hidden = !key; upload.hidden = !key;
  } };
}
