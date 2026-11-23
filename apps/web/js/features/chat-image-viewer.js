import { h } from '../lib/dom.js';

const suffixes = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp']]);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function openChatImageViewer({ index, count, load, valid, onEdit, onClose }) {
  const dialog = h('dialog', { class: 'chat-image-viewer', 'aria-label': '图片查看器' });
  const position = h('strong', { 'aria-live': 'polite' });
  const status = h('p', { role: 'status', 'aria-label':'图片读取与操作状态' });
  const zoomLabel = h('output', { 'aria-label': '缩放比例' });
  const canvas = h('div', { class: 'chat-image-viewer__canvas', tabIndex:0, role:'group', 'aria-label':'图片区域，按住 Shift 和方向键平移' }, status);
  const tools = h('div', { class: 'chat-image-viewer__tools', role: 'group', 'aria-label': '图片操作' });
  const button = (label, click) => h('button', { class: 'btn', type: 'button', onclick: click }, label);
  let shown, url, request, action, closed = false;
  let scale = 1, fitting = true, angle = 0, dx = 0, dy = 0, drag;
  const prev = button('上一张', () => show(index - 1));
  const next = button('下一张', () => show(index + 1));
  const actions = [
    button('缩小', () => zoom(1 / 1.25)), button('放大', () => zoom(1.25)),
    button('原尺寸', () => reset(false)), button('适应窗口', () => reset(true)),
    button('向右旋转', () => { if (permitted() && shown) { angle = (angle + 90) % 360; dx = dy = 0; paint(); } }),
    button('下载图片', () => useImage('download')),
    ...(window.isSecureContext && navigator.clipboard?.write && typeof ClipboardItem === 'function' ? [button('复制图片', () => useImage('copy'))] : []),
    ...(onEdit ? [button('编辑到草稿', () => useImage('edit'))] : []),
  ];
  tools.append(...actions, zoomLabel);
  const dismiss = button('关闭', close);
  dialog.append(h('div', {class:'chat-image-viewer__head'}, position, h('div', {class:'row'}, prev, next, dismiss)), canvas, tools);
  const observer = new ResizeObserver(() => { if (permitted()) paint(); });
  function release() {
    shown?.remove(); shown = undefined; drag = undefined;
    if (url) URL.revokeObjectURL(url);
    url = undefined;
  }
  function close() {
    if (closed) return;
    closed = true;
    window.removeEventListener('hashchange', close);
    request?.abort(); action?.abort(); observer.disconnect(); release();
    if (dialog.open) dialog.close();
    dialog.remove();
    onClose?.();
  }
  function permitted() {
    if (closed) return false;
    if (valid()) return true;
    close();
    return false;
  }
  function renderButtons() {
    actions.forEach(b => { b.disabled = !shown || !!action; });
    prev.disabled = !!action || index <= 0; next.disabled = !!action || index >= count - 1;
  }
  function paint() {
    if (!shown) return;
    const rotated = angle % 180 !== 0;
    const width = rotated ? shown.naturalHeight : shown.naturalWidth;
    const height = rotated ? shown.naturalWidth : shown.naturalHeight;
    if (fitting) scale = Math.min(1, canvas.clientWidth / width, canvas.clientHeight / height);
    const maxX = Math.max(0, (width * scale - canvas.clientWidth) / 2);
    const maxY = Math.max(0, (height * scale - canvas.clientHeight) / 2);
    dx = clamp(dx, -maxX, maxX); dy = clamp(dy, -maxY, maxY);
    shown.style.transform = 'translate(-50%, -50%) translate(' + dx + 'px,' + dy + 'px) rotate(' + angle + 'deg) scale(' + scale + ')';
    canvas.classList.toggle('can-pan', maxX > 0 || maxY > 0);
    zoomLabel.textContent = Math.round(scale * 100) + '%';
  }
  function reset(fit) {
    if (!permitted() || !shown) return;
    fitting = fit; scale = 1; dx = dy = 0; paint();
  }
  function zoom(factor, x = 0, y = 0) {
    if (!permitted() || !shown) return;
    const prior = scale;
    const min = Math.min(0.02, canvas.clientWidth / shown.naturalWidth, canvas.clientHeight / shown.naturalHeight);
    scale = clamp(prior * factor, min, 6);
    dx = x - (x - dx) * scale / prior; dy = y - (y - dy) * scale / prior;
    fitting = false; paint();
  }
  function showError(error) {
    if ([401,403,404,410].includes(error?.status) || !permitted()) { close(); return; }
    release(); renderButtons(); zoomLabel.textContent = '';
    const retry = button('重新加载', () => show(index));
    status.replaceChildren('图片读取失败。', retry);
  }
  async function fetchImage(which, controller) {
    const blob = await load(which, controller.signal);
    if (!permitted() || controller.signal.aborted) return;
    if (!(blob instanceof Blob) || !blob.size || !suffixes.has(blob.type)) throw Error('不支持的图片格式');
    return blob;
  }
  async function show(which) {
    if (!permitted() || which < 0 || which >= count) return;
    request?.abort(); action?.abort(); action = undefined; release();
    const controller = new AbortController();
    request = controller; index = which;
    position.textContent = '图片 ' + (index + 1) + ' / ' + count;
    status.textContent = '正在读取图片…'; zoomLabel.textContent = ''; renderButtons();
    try {
      const blob = await fetchImage(which, controller);
      if (!blob) return;
      const img = h('img', { alt: '消息图片 ' + (which + 1), draggable:false });
      url = URL.createObjectURL(blob); img.src = url;
      await img.decode();
      if (controller.signal.aborted || !permitted()) return;
      shown = img; fitting = true; angle = dx = dy = 0;
      canvas.append(img); status.replaceChildren(); paint(); renderButtons();
    } catch (error) { if (!controller.signal.aborted) showError(error); }
  }
  async function useImage(operation) {
    if (!permitted() || !shown || action) return;
    const controller = new AbortController(), which = index;
    action = controller; renderButtons();
    try {
      // A displayed object URL is not authority to download or reuse its bytes.
      if (operation === 'copy') {
        // Start the clipboard write within the gesture. Its promised contents
        // resolve only after checking the original message and converting to PNG.
        const content = (async () => {
          const blob = await fetchImage(which, controller);
          if (!blob) throw Error('图片已关闭');
          if (blob.type === 'image/png') return blob;
          const bitmap = await createImageBitmap(blob);
          try {
            const buffer = document.createElement('canvas');
            buffer.width = bitmap.width; buffer.height = bitmap.height;
            buffer.getContext('2d').drawImage(bitmap, 0, 0);
            const png = await new Promise(resolve => buffer.toBlob(resolve, 'image/png'));
            if (!png || controller.signal.aborted || !permitted()) throw Error('图片不可用');
            return png;
          } finally { bitmap.close(); }
        })();
        // Await both paths so that an access failure retains its original HTTP status.
        await Promise.all([content,navigator.clipboard.write([new ClipboardItem({'image/png':content})])]);
        if (permitted() && !controller.signal.aborted) status.textContent = '图片已复制。';
        return;
      }
      const blob = await fetchImage(which, controller);
      if (!blob) return;
      if (operation === 'edit') { await onEdit(which, blob); close(); }
      else {
        const href = URL.createObjectURL(blob);
        const link = h('a', {href, download:'消息图片-' + (which + 1) + '.' + suffixes.get(blob.type)});
        dialog.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(href), 0);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        if ([401,403,404,410].includes(error?.status) || !permitted()) close();
        else if (operation === 'copy') status.textContent = '图片复制失败，请检查浏览器剪贴板权限。';
        else if (operation === 'edit') status.textContent = '无法将图片交给草稿，请重试。';
        else showError(error);
      }
    } finally { controller.abort(); if (action === controller) { action = undefined; renderButtons(); } }
  }
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    // Touchpads report many small pixel deltas; mouse wheels can report lines or pages.
    const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? rect.height : 1;
    const factor = Math.exp(clamp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.002), -5, 5));
    if (factor === 1) return;
    zoom(factor, e.clientX - rect.left - rect.width/2, e.clientY - rect.top - rect.height/2);
  }, {passive:false});
  canvas.addEventListener('dblclick', e => {
    if (!fitting) { reset(true); return; }
    const rect = canvas.getBoundingClientRect();
    zoom(Math.max(2, 1 / scale), e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2);
  });
  canvas.addEventListener('pointerdown', e => {
    if (!permitted() || !shown || !e.isPrimary || e.button !== 0) return;
    drag = {id:e.pointerId,x:e.clientX-dx,y:e.clientY-dy};
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (drag?.id !== e.pointerId || !permitted()) return;
    dx = e.clientX - drag.x; dy = e.clientY - drag.y; paint();
  });
  canvas.addEventListener('lostpointercapture', () => { drag = undefined; });
  dialog.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.shiftKey && e.key.startsWith('Arrow') && permitted() && shown) {
      e.preventDefault();
      dx += e.key === 'ArrowLeft' ? 40 : e.key === 'ArrowRight' ? -40 : 0;
      dy += e.key === 'ArrowUp' ? 40 : e.key === 'ArrowDown' ? -40 : 0;
      paint();
      return;
    }
    const keys = {ArrowLeft:()=>prev.click(), ArrowRight:()=>next.click(), '+':()=>zoom(1.25), '=':()=>zoom(1.25), '-':()=>zoom(1/1.25), '0':()=>reset(true)};
    if (Object.hasOwn(keys,e.key)) {
      e.preventDefault(); keys[e.key]();
    }
  });
  dialog.addEventListener('close',close);
  if (count > 0 && index >= 0 && index < count && permitted()) {
    window.addEventListener('hashchange', close);
    document.body.append(dialog); dialog.showModal(); dismiss.focus(); observer.observe(canvas); show(index);
  }
  return {close};
}
