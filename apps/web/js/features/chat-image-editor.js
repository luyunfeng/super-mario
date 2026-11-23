import { h } from '../lib/dom.js';
import { openDrawer } from '../ui/overlay.js';

const inks = { 红色:'#ee332d', 黄色:'#ffcd16', 绿色:'#29a34b', 蓝色:'#2479de', 白色:'#ffffff', 黑色:'#151515' };
const shapes = { free:'自由', original:'原图比例', square:'正方形', '4:3':'4:3', '3:4':'3:4', '16:9':'16:9', '9:16':'9:16' };
const clamp = (v, min, max) => Math.max(min, Math.min(v, max));
const button = (label, click) => h('button', {type:'button', class:'btn btn--sm', onclick:click}, label);

function ratio(shape, width, height) {
  if (shape === 'free') return null;
  if (shape === 'original') return width / height;
  if (shape === 'square') return 1;
  const [w, h] = shape.split(':').map(Number);
  return w / h;
}

function paintMark(ctx, mark) {
  const { points, ink, width } = mark;
  const [a,b] = points;
  ctx.strokeStyle = ctx.fillStyle = ink;
  ctx.lineWidth = width;
  ctx.lineJoin = ctx.lineCap = 'round';
  if (mark.kind === 'box') {
    if (b) ctx.strokeRect(a.x,a.y,b.x-a.x,b.y-a.y);
    return;
  }
  ctx.beginPath();
  if (points.length === 1) {
    ctx.arc(a.x,a.y,width/2,0,2*Math.PI);
    ctx.fill();
    return;
  }
  ctx.moveTo(a.x,a.y);
  for (const p of points.slice(1)) ctx.lineTo(p.x,p.y);
  ctx.stroke();
}

// Paint marks in original pixels under the same transformation as their image.
// The preview can be downsampled without changing stroke geometry or export.
function paint(canvas, image, frame, marks, view, scale) {
  const w = Math.max(1, Math.round(view.w * scale));
  const h = Math.max(1, Math.round(view.h * scale));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.resetTransform();
  ctx.clearRect(0,0,w,h);
  ctx.scale(w/view.w,h/view.h);
  ctx.translate(-view.x,-view.y);
  ctx.save();
  const transforms = [[1,0,0,1,0,0],[0,-1,1,0,0,image.width],[-1,0,0,-1,image.width,image.height],[0,1,-1,0,image.height,0]];
  ctx.transform(...transforms[frame.turns]);
  ctx.drawImage(image,0,0);
  for (const mark of marks) paintMark(ctx,mark);
  ctx.restore();
  return ctx;
}

function sourcePoint(p,turns,image) {
  switch (turns) {
    case 1: return {x:image.width-p.y,y:p.x};
    case 2: return {x:image.width-p.x,y:image.height-p.y};
    case 3: return {x:p.y,y:image.height-p.x};
    default: return p;
  }
}

function cropDrag(d, p, size) {
  const { start, crop, xSide, ySide, shape } = d;
  if (d.move) {
    return {...crop, x:clamp(crop.x+p.x-start.x,0,size.w-crop.w), y:clamp(crop.y+p.y-start.y,0,size.h-crop.h)};
  }
  const anchor = d.draw ? start : {
    x:xSide === -1 ? crop.x+crop.w : xSide === 1 ? crop.x : crop.x+crop.w/2,
    y:ySide === -1 ? crop.y+crop.h : ySide === 1 ? crop.y : crop.y+crop.h/2,
  };
  const sx = d.draw ? Math.sign(p.x-start.x) || 1 : xSide;
  const sy = d.draw ? Math.sign(p.y-start.y) || 1 : ySide;
  const maxW = sx < 0 ? anchor.x : sx > 0 ? size.w-anchor.x : 2*Math.min(anchor.x,size.w-anchor.x);
  const maxH = sy < 0 ? anchor.y : sy > 0 ? size.h-anchor.y : 2*Math.min(anchor.y,size.h-anchor.y);
  let w = sx ? clamp(sx*(p.x-anchor.x),1,maxW) : crop.w;
  let h = sy ? clamp(sy*(p.y-anchor.y),1,maxH) : crop.h;
  const r = ratio(shape,size.w,size.h);
  if (r) {
    w = Math.min(!sx ? h*r : !sy ? w : Math.max(w,h*r),maxW,maxH*r);
    h = w/r;
  }
  return {x:anchor.x-(sx < 0 ? w : sx ? 0 : w/2),y:anchor.y-(sy < 0 ? h : sy ? 0 : h/2),w,h};
}

export function openChatImageEditor({ row, onSave, onClose }) {
  const source = row.editSource ?? row;
  const previous = row.editHistory;
  const history = previous?.version === 1 ? structuredClone(previous) : {version:1,steps:[],cursor:0};
  let image, original, drag, saving = false, animation;
  let tool = 'box', ink = inks.红色, width = 4;
  let frame, marks, view;
  const canvas = h('canvas', {'aria-label':'图片编辑画布'});
  const stage = h('div', {class:'chat-image-stage'}, canvas);
  const error = h('p', {class:'small',role:'alert'});
  const save = button('保存', saveImage);
  save.classList.add('btn--primary');
  const cancel = button('取消', () => drawer.close());
  const undo = button('撤销', () => seek(-1));
  const redo = button('重做', () => seek(1));
  const rotate = button('向左旋转', () => {
    const {x,y,w,h} = frame.crop;
    const shape = frame.shape.includes(':') ? frame.shape.split(':').reverse().join(':') : frame.shape;
    setFrame({turns:(frame.turns+1)%4,crop:{x:y,y:turnedSize().w-x-w,w:h,h:w},shape});
  });
  const reset = button('重置裁剪', () => setFrame(initialFrame()));
  const clear = button('清除标注', () => commit({kind:'clear'}));
  const toolButtons = Object.entries({box:'框选',pen:'画笔',crop:'裁剪'}).map(([id,label]) => {
    const b = button(label, () => { tool = id; drag = undefined; render(); });
    b.dataset.tool = id; return b;
  });
  const colors = Object.entries(inks).map(([name,value]) => {
    const b = button(name, () => { ink = value; render(); });
    b.classList.add('chat-image-ink'); b.style.setProperty('--ink',value); b.dataset.ink = value; b.title = name;
    return b;
  });
  const widths = [[2,'细'],[4,'中'],[8,'粗']].map(([value,label]) => {
    const b = button(label, () => { width = value; render(); });
    b.dataset.width = String(value); b.setAttribute('aria-label',label+'线'); return b;
  });
  const group = (label,...nodes) => h('div',{role:'group','aria-label':label,class:'chat-image-tools'},nodes);
  const markTools = group('标注样式',group('颜色',colors),group('线宽',widths),clear);
  const shapeSelect = h('select',{'aria-label':'裁剪比例',onchange:() => {
    const shape = shapeSelect.value, size = turnedSize(), r = ratio(shape,size.w,size.h);
    let crop = frame.crop;
    if (r) {
      const w = Math.min(size.w,size.h*r), h = w/r;
      crop = {x:clamp(crop.x+(crop.w-w)/2,0,size.w-w),y:clamp(crop.y+(crop.h-h)/2,0,size.h-h),w,h};
    }
    setFrame({...frame,shape,crop});
  }},Object.entries(shapes).map(([value,label]) => h('option',{value},label)));
  const cropTools = group('裁剪设置',shapeSelect,rotate,reset);
  const drawer = openDrawer({title:'编辑图片',wide:true,
    body:[group('工具',toolButtons,undo,redo),markTools,cropTools,stage,error],
    footer:[cancel,save],onClose:() => { cancelAnimationFrame(animation); image?.close(); onClose?.(); }});
  drawer.el.classList.add('chat-image-editor');

  function initialFrame() { return {turns:0,crop:{x:0,y:0,w:image.width,h:image.height},shape:'free'}; }
  function turnedSize() { return frame.turns%2 ? {w:image.height,h:image.width} : {w:image.width,h:image.height}; }
  function rebuild() {
    frame = initialFrame(); marks = [];
    for (const step of history.steps.slice(0,history.cursor)) {
      if (step.kind === 'frame') frame = step.frame;
      else if (step.kind === 'clear') marks = [];
      else marks.push(step);
    }
  }
  function commit(step) {
    history.steps.splice(history.cursor,Infinity,step); history.cursor++;
    rebuild(); render();
  }
  function setFrame(next) {
    if (JSON.stringify(frame) !== JSON.stringify(next)) commit({kind:'frame',frame:next});
  }
  function seek(offset) {
    if (!image || saving) return;
    drag = undefined; history.cursor = clamp(history.cursor+offset,0,history.steps.length);
    rebuild(); render();
  }
  function render() {
    const ready = !!image && !saving;
    for (const b of [...toolButtons,...colors,...widths,shapeSelect,rotate,reset,save]) b.disabled = !ready;
    for (const b of toolButtons) b.setAttribute('aria-pressed',String(tool === b.dataset.tool));
    for (const b of colors) b.setAttribute('aria-pressed',String(ink === b.dataset.ink));
    for (const b of widths) b.setAttribute('aria-pressed',String(width === Number(b.dataset.width)));
    markTools.hidden = tool === 'crop'; cropTools.hidden = tool !== 'crop';
    undo.disabled = !ready || history.cursor === 0;
    redo.disabled = !ready || history.cursor === history.steps.length;
    clear.disabled = !ready || !marks?.length;
    if (!image) return;
    shapeSelect.value = frame.shape;
    const size = turnedSize(), isCrop = tool === 'crop';
    view = isCrop ? {x:0,y:0,...size} : frame.crop;
    const ctx = paint(canvas,image,frame,drag?.mark ? [...marks,drag.mark] : marks,view,Math.min(1,1800/Math.max(view.w,view.h)));
    if (isCrop) {
      const c = drag?.next ?? frame.crop;
      ctx.fillStyle = 'rgba(0,0,0,.48)';
      ctx.beginPath(); ctx.rect(0,0,size.w,size.h); ctx.rect(c.x,c.y,c.w,c.h); ctx.fill('evenodd');
      const unit = view.w / Math.max(1,canvas.getBoundingClientRect().width);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = unit*1.5; ctx.strokeRect(c.x,c.y,c.w,c.h);
      ctx.fillStyle = '#fff';
      for (const dx of [0,.5,1]) for (const dy of [0,.5,1]) {
        if (dx !== .5 || dy !== .5) ctx.fillRect(c.x+c.w*dx-unit*3,c.y+c.h*dy-unit*3,unit*6,unit*6);
      }
    }
  }
  function point(e) {
    const r = canvas.getBoundingClientRect();
    return {x:view.x+clamp((e.clientX-r.left)/r.width,0,1)*view.w,y:view.y+clamp((e.clientY-r.top)/r.height,0,1)*view.h};
  }
  function updatePointer(e) {
    const p = point(e);
    if (drag.mark) {
      const s = sourcePoint(p,frame.turns,image);
      const points = drag.mark.points, last = points.at(-1);
      if (s.x !== last.x || s.y !== last.y) {
        if (drag.mark.kind === 'box') points[1] = s; else points.push(s);
      }
    } else if (Math.hypot(e.clientX-drag.clientX,e.clientY-drag.clientY) >= 2) {
      drag.next = cropDrag(drag,p,turnedSize());
    }
  }
  canvas.addEventListener('pointerdown', e => {
    if (!image || saving || drag || e.button !== 0) return;
    const p = point(e), unit = view.w / canvas.getBoundingClientRect().width;
    if (tool === 'crop') {
      const c = frame.crop, margin = 10*unit;
      const side = (n,a,len) => Math.abs(n-a) <= Math.min(margin,len/3) ? -1 : Math.abs(n-a-len) <= Math.min(margin,len/3) ? 1 : 0;
      const inside = p.x >= c.x-margin && p.x <= c.x+c.w+margin && p.y >= c.y-margin && p.y <= c.y+c.h+margin;
      const xSide = inside ? side(p.x,c.x,c.w) : 0, ySide = inside ? side(p.y,c.y,c.h) : 0;
      const draw = !inside || (!xSide && !ySide && c.w >= view.w && c.h >= view.h);
      drag = {start:p,crop:c,xSide,ySide,draw,move:!draw && !xSide && !ySide,shape:frame.shape,clientX:e.clientX,clientY:e.clientY};
    } else drag = {mark:{kind:tool,ink,width:width*unit,points:[sourcePoint(p,frame.turns,image)]}};
    drag.pointer = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', e => {
    if (drag?.pointer !== e.pointerId) return;
    updatePointer(e);
    if (!animation) animation = requestAnimationFrame(() => { animation = undefined; render(); });
  });
  canvas.addEventListener('pointerup', e => {
    if (drag?.pointer !== e.pointerId) return;
    updatePointer(e);
    const {mark,next} = drag; drag = undefined;
    if (mark && (mark.kind === 'pen' || mark.points.length === 2)) commit(mark);
    else if (next && next.w >= 1 && next.h >= 1) setFrame({...frame,crop:next});
    else render();
  });
  const abortDrag = e => { if (drag?.pointer === e.pointerId) { drag = undefined; render(); } };
  canvas.addEventListener('lostpointercapture',abortDrag);
  canvas.addEventListener('pointercancel',abortDrag);
  drawer.el.addEventListener('keydown', e => {
    if ((!e.ctrlKey && !e.metaKey) || e.altKey) return;
    if (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y') {
      e.preventDefault(); seek(e.shiftKey || e.key.toLowerCase() === 'y' ? 1 : -1);
    }
  });
  async function saveImage() {
    if (saving || !image || drag) return;
    saving = true; render(); error.textContent = '';
    try {
      let blob = original;
      const c = frame.crop;
      if (marks.length || frame.turns || c.x || c.y || c.w !== image.width || c.h !== image.height) {
        const out = document.createElement('canvas');
        paint(out,image,frame,marks,c,1);
        blob = await new Promise(resolve => out.toBlob(resolve,'image/png'));
        if (!blob) throw new Error('无法导出图片。');
        // Try a smaller encoding at full resolution before the attachment
        // pipeline has to resample a screenshot containing small text.
        if (blob.size > 3_750_000) {
          const webp = await new Promise(resolve => out.toBlob(resolve,'image/webp',0.92));
          if (webp && webp.size < blob.size) blob = webp;
        }
      }
      if (!drawer.el.open) return;
      await onSave(blob,structuredClone(history));
      drawer.close();
    } catch (e) {
      if (drawer.el.open) { saving = false; error.textContent = e.message || '图片保存失败。'; render(); }
    }
  }
  render();
  (async () => {
    try {
      const bytes = Uint8Array.from(atob(source.data),c => c.charCodeAt(0));
      original = new Blob([bytes],{type:source.mime});
      const decoded = await createImageBitmap(original);
      if (!drawer.el.open) { decoded.close(); return; }
      image = decoded; rebuild(); render();
    } catch { error.textContent = '无法读取这张图片。'; }
  })();
  return {close:drawer.close,isOpen:()=>drawer.el.open};
}
