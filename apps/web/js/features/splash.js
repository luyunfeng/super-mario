import { h, readLocal, writeLocal } from '../lib/dom.js';

let stopCurrent;
export function playSplash({ title = 'Super Mario', durationMs, force = false } = {}) {
  if (!force && readLocal('sm.splash.seen', false)) return;
  stopCurrent?.();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const video = h('video', { class: 'splash__video', muted: true, playsInline: true });
  // 两个文件是同一段影片。优先选浏览器能解码的版本。
  video.src = video.canPlayType('video/mp4; codecs="hvc1"')
    ? '/assets/boot/intro.mp4' : '/assets/boot/intro-avc.mp4';
  const el = h('div', { class: 'splash', 'aria-label': title + ' 开屏' }, video,
    h('span', { class: 'splash__hint' }, '点击或按键跳过'));
  const events = new AbortController();
  const options = { signal: events.signal };
  let timer = setTimeout(stop, 5000);
  function stop() {
    events.abort();
    clearTimeout(timer);
    video.pause();
    video.removeAttribute('src');
    video.load();
    el.remove();
    stopCurrent = undefined;
  }
  stopCurrent = stop;
  video.addEventListener('playing', () => {
    clearTimeout(timer);
    writeLocal('sm.splash.seen', true);
    timer = setTimeout(stop, durationMs ?? (video.duration + 2) * 1000);
  }, { ...options, once: true });
  video.addEventListener('ended', stop, options);
  video.addEventListener('error', stop, options);
  for (const event of ['pointerdown', 'keydown', 'beforeinput']) window.addEventListener(event, () => {
    writeLocal('sm.splash.seen', true);
    stop();
  }, { ...options, capture: true });
  document.body.append(el);
  video.play().catch(() => { if (!events.signal.aborted) stop(); });
}
