import { browserDevice } from './notice-worker.js';

export function installPresence(api) {
  // A per-document id avoids collisions when a tab is duplicated from sessionStorage.
  const tabId = [...crypto.getRandomValues(new Uint32Array(4))].map(n => n.toString(16).padStart(8,'0')).join('');
  // The browser's own id, the one its Web Push subscription is under, so that the server can
  // tell which browser has a page open.
  const device = browserDevice();
  let sequence = 0;
  let hidden = false;
  function beat() {
    void api('/presence', { method:'POST', keepalive:true, body:{ tabId, sequence:++sequence, device, visible: !hidden && document.visibilityState === 'visible', focused: !hidden && document.hasFocus() } }).catch(() => {});
  }
  document.addEventListener('visibilitychange', beat);
  window.addEventListener('focus', beat);
  window.addEventListener('blur', beat);
  window.addEventListener('pagehide', () => { hidden = true; beat(); });
  window.addEventListener('pageshow', () => { hidden = false; beat(); });
  setInterval(beat, 15000); beat();
}
