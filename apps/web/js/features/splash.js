import { h, readLocal, writeLocal } from '../lib/dom.js';

let stopCurrent;
export function stopSplash() { stopCurrent?.(); }

function bootVideo(name, className) {
  const video = h('video', { class: className, muted: true, playsInline: true });
  video.src = '/assets/boot/' + name + (video.canPlayType('video/mp4; codecs="hvc1"') ? '.mp4' : '-avc.mp4');
  return video;
}

function release(video) {
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function playBackground() {
  const video = bootVideo('loop', 'splash-background');
  video.loop = true;
  video.setAttribute('aria-hidden', 'true');
  const events = new AbortController();
  const options = { signal: events.signal };
  function stop() {
    events.abort();
    release(video);
    video.remove();
    stopCurrent = undefined;
  }
  function sync() {
    if (document.hidden) video.pause();
    else video.play().catch(() => { if (!events.signal.aborted && !document.hidden) stop(); });
  }
  stopCurrent = stop;
  document.body.prepend(video);
  video.addEventListener('error', stop, options);
  document.addEventListener('visibilitychange', sync, options);
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', stop, options);
  sync();
}

export function playSplash({ title = 'Super Mario', durationMs, force = false } = {}) {
  stopSplash();
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!force && readLocal('sm.splash.seen', false)) return playBackground();

  const video = bootVideo('intro', 'splash__video');
  const el = h('div', { class: 'splash', 'aria-label': title + ' 开屏' }, video,
    h('span', { class: 'splash__hint' }, '点击或按键跳过'));
  const events = new AbortController();
  const options = { signal: events.signal };
  let timer = setTimeout(stop, 5000);
  function stop() {
    events.abort();
    clearTimeout(timer);
    release(video);
    el.remove();
    stopCurrent = undefined;
  }
  stopCurrent = stop;
  function enterWorkbench() {
    stop();
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) playBackground();
  }
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', stop, options);
  video.addEventListener('playing', () => {
    clearTimeout(timer);
    writeLocal('sm.splash.seen', true);
    timer = setTimeout(enterWorkbench, durationMs ?? (video.duration + 2) * 1000);
  }, { ...options, once: true });
  video.addEventListener('ended', enterWorkbench, options);
  video.addEventListener('error', stop, options);
  for (const event of ['pointerdown', 'keydown', 'beforeinput']) window.addEventListener(event, () => {
    writeLocal('sm.splash.seen', true);
    enterWorkbench();
  }, { ...options, capture: true });
  document.body.append(el);
  video.play().catch(() => { if (!events.signal.aborted) stop(); });
}
