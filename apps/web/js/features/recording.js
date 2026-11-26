// 在浏览器里录音，并把录到的声音变成转写引擎要的格式。解码和降采样都在这里做，
// 服务端不留音频，也不需要音频库。音频的格式和时长上限由服务端的状态给出，这里不另存一份。
import { h, replace } from '../lib/dom.js';
import { Button, Field, Input } from '../ui/kit.js';
import { openDrawer } from '../ui/overlay.js';

/**
 * 把浏览器给的任意音频解码成单声道 PCM16 小端。采样率取服务端给的那个，录音的采样率
 * 比它高，所以只会降不会升。
 */
export async function toPcm16(buffer, { sampleRate }) {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) throw new Error('这个浏览器不能处理音频。');
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(buffer);
    const length = decoded.length;
    // 所有声道合成一个。
    const mono = new Float32Array(length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const data = decoded.getChannelData(channel);
      for (let i = 0; i < length; i++) mono[i] += data[i] / decoded.numberOfChannels;
    }
    const ratio = decoded.sampleRate / sampleRate;
    if (ratio < 1) throw new Error('录音的采样率低于 ' + sampleRate + '，请换一个麦克风或浏览器。');
    // Rounding, not cutting off: a length that is a hair under a whole number of output
    // samples would otherwise lose its last sample, and the piece would read a little short.
    const samples = Math.round(length / ratio);
    const pcm = new Uint8Array(samples * 2);
    const view = new DataView(pcm.buffer);
    for (let i = 0; i < samples; i++) {
      // 取相邻两个采样之间按比例的位置。
      const at = i * ratio, low = Math.floor(at), high = Math.min(low + 1, length - 1);
      const value = mono[low] + (mono[high] - mono[low]) * (at - low);
      // 限制在 -1 到 1 之间，再放大到 16 位有整数的范围。
      const clamped = Math.max(-1, Math.min(1, value));
      view.setInt16(i * 2, Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), true);
    }
    return pcm;
  } finally { void context.close(); }
}

/**
 * 录音。到上限会自动停，并把原因告诉调用方，所以一次不会录得太长。
 * 返回的 stop 停止录音并给出录到的内容。
 */
export function startRecording(stream, { maxSeconds, onTick, onLimit }) {
  const recorder = new MediaRecorder(stream);
  const parts = [];
  const startedAt = Date.now();
  recorder.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
  const stopped = new Promise(resolve => { recorder.onstop = () => resolve(new Blob(parts, { type: recorder.mimeType })); });
  const timer = setInterval(() => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    onTick?.(seconds);
    if (seconds >= maxSeconds) { stop('limit'); onLimit?.(); }
  }, 500);
  function stop(reason = 'user') {
    clearInterval(timer);
    if (recorder.state !== 'inactive') recorder.stop();
    return stopped.then(blob => ({ blob, seconds: Math.floor((Date.now() - startedAt) / 1000), reason }));
  }
  recorder.start(500);
  return { stop, seconds: () => Math.floor((Date.now() - startedAt) / 1000) };
}

/** 一段 PCM16 单声道音频有多长。 */
export function pcmSeconds(bytes, sampleRate) {
  return bytes / (sampleRate * 2);
}

// Minutes and seconds. The seconds are padded so that one position reads like the next.
const clock = seconds => [Math.floor(seconds / 60), String(Math.floor(seconds % 60)).padStart(2, '0')].join(':');

/** 录音并转写的抽屉。结果可以存成当前范围的一页知识。 */
export function openRecording({ api, store, scope }) {
  const status = h('p', { role: 'status', class: 'small' });
  const body = h('div', { class: 'stack stack--lg' });
  const title = Input({ value: '录音转写 ' + new Date().toLocaleString('zh-CN'), maxLength: '120', 'aria-label': '知识页标题' });
  const save = Button({ label: '存为知识页', kind: 'primary', onClick: async () => {
    if (!result) return;
    try {
      const layer = scope.get() ? 'project' : 'personal';
      const page = await api.post('/knowledge', { title: title.value.trim(), content: content(), layer, ...(scope.get() ? { projectId: scope.get() } : {}) });
      drawer.close();
      store.refresh();
      location.hash = '#memory/' + encodeURIComponent(page.id);
    } catch (error) { status.textContent = '没有存成：' + error.message; }
  } });
  save.disabled = true;
  const drawer = openDrawer({ title: '录音转写', body: [status, body], footer: save });
  let state, recording, stream, result;
  // The audio never leaves this page until it is in the format the server takes.
  function content() {
    return result.segments.map(item => '[' + clock(item.from) + '–' + clock(item.to) + '] ' + item.text).join('\n')
      + (result.gaps.length ? '\n\n以下时间没有听清，未编造内容：\n' + result.gaps.map(item => '[' + clock(item.from) + '–' + clock(item.to) + ']').join('、') : '');
  }
  function paint() {
    if (!state) { replace(body, h('p', { class: 'muted' }, '正在读取转写设置…')); return; }
    if (state.reason && !state.ready) {
      replace(body, h('p', { class: 'small' }, state.reason),
        state.engines.length ? h('label', { class: 'field' }, h('span', { class: 'field__label' }, '转写引擎'),
          h('select', { class: 'select', 'aria-label': '转写引擎', onchange: async event => {
            try { state = await api.put('/transcription/choice', { service: event.target.value }); paint(); }
            catch (error) { status.textContent = error.message; }
          } }, state.engines.map(engine => h('option', { value: engine.service, selected: engine.service === state.choice?.service }, engine.name)))) : null);
      return;
    }
    if (result) {
      replace(body, Field({ label: '标题', control: title }),
        h('p', { class: 'small muted' }, '时长 ' + clock(result.seconds) + ' · ' + result.segments.length + ' 段' + (result.gaps.length ? ' · ' + result.gaps.length + ' 处没听清' : '')),
        h('ol', { class: 'stack', 'aria-label': '转写结果' }, result.segments.map(item => h('li', { class: 'stack' },
          h('time', { class: 'small muted', dateTime: 'PT' + Math.floor(item.from) + 'S' }, clock(item.from)),
          h('span', null, item.text)))),
        result.gaps.length ? h('p', { class: 'small muted' }, '没有听清、未编造内容：' + result.gaps.map(item => clock(item.from) + '–' + clock(item.to)).join('、')) : null);
      save.disabled = false;
      return;
    }
    replace(body, h('p', { class: 'small muted' }, '录音在这个页面里变成文字后再上传，服务端不留音频。一次最多 ' + clock(state.audio.maxSeconds) + '。'),
      h('div', { class: 'row row--wrap' }, Button({ label: '开始录音', kind: 'primary', onClick: start }),
        h('label', { class: 'btn' }, '上传音频文件', h('input', { type: 'file', accept: 'audio/*', hidden: true, 'aria-label': '上传音频文件', onchange: upload }))));
  }
  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      status.textContent = '';
      const meter = h('span', { class: 'small muted' }, '0:00');
      replace(body, h('p', { class: 'small' }, '正在录音… ', meter, ' 最多 ' + clock(state.audio.maxSeconds)), Button({ label: '停止并转写', kind: 'danger', onClick: () => void recording?.stop() }));
      recording = startRecording(stream, { maxSeconds: state.audio.maxSeconds, onTick: seconds => { meter.textContent = clock(seconds); }, onLimit: () => { status.textContent = '已到时长上限，自动停止。'; } });
      const taken = await recording.stop();
      stream.getTracks().forEach(track => track.stop());
      await transcribe(await taken.blob.arrayBuffer(), taken.seconds);
    } catch (error) { status.textContent = error.name === 'NotAllowedError' ? '没有拿到麦克风权限。可以在浏览器地址栏里允许后重试。' : error.message; stream?.getTracks().forEach(track => track.stop()); paint(); }
  }
  async function upload(event) {
    const file = event.target.files[0];
    if (!file) return;
    try { await transcribe(await file.arrayBuffer(), pcmSeconds(file.size, state.audio.sampleRate)); }
    catch (error) { status.textContent = error.message; paint(); }
  }
  async function transcribe(buffer) {
    status.textContent = '正在转写…';
    const pcm = await toPcm16(buffer, { sampleRate: state.audio.sampleRate });
    // The audio goes as the body itself. api adds the path prefix, the credential and the
    // handling of an expired session, so this goes through it like every other request.
    const value = await api('/transcription/jobs', { method: 'POST', body: new Blob([pcm], { type: 'application/octet-stream' }),
      headers: { 'Content-Type': 'application/octet-stream' } });
    result = value;
    status.textContent = '';
    paint();
  }
  void (async () => {
    try { state = await api.get('/transcription'); paint(); }
    catch (error) { status.textContent = '无法读取转写设置：' + error.message; }
  })();
  return drawer;
}
