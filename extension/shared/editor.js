/* YT-Vision-Notes — Lightbox + canvas image editor (zoom/pan, crop, pen, highlighter, arrow, rect, ellipse, text,
 * undo/redo, clear all). Shared by the extension panel and the web app.
 *
 * YVN.Editor.open({
 *   images: [{ id, ts, edits, load: async () => Blob|string(url) }],   // load() returns the ORIGINAL frame
 *   index: 0,
 *   onSave: async (image, { edits, blob }) => {},   // edits=null & blob=null → reverted to original
 *   onSeek: (ts, image) => {},                      // optional: timestamp chip click
 *   readOnly: false,
 * })
 *
 * edits = { crop: {x,y,w,h}|null, shapes: [ {type:'pen'|'hl', color, size, pts:[[x,y]...]}
 *                                         | {type:'arrow'|'rect'|'ellipse', color, size, x1,y1,x2,y2}
 *                                         | {type:'text', color, size, x, y, text} ] }
 * All coordinates are in ORIGINAL image pixels, so crop and annotations stay independent and re-editable.
 */
(function (g) {
  'use strict';
  const YVN = (g.YVN = g.YVN || {});

  const COLORS = ['#ff3b30', '#ff9f0a', '#ffd60a', '#30d158', '#0a84ff', '#bf5af2', '#ffffff', '#111111'];
  const TOOLS = [
    ['pan', '✋', '平移 / 檢視 (V)'],
    ['pen', '✏️', '畫筆 (P)'],
    ['hl', '🖍️', '螢光筆 (H)'],
    ['arrow', '↗', '箭頭 (A)'],
    ['rect', '▭', '矩形 (R)'],
    ['ellipse', '◯', '圓形 (E)'],
    ['text', 'T', '文字 (T，或直接雙擊圖片)'],
    ['crop', '⛶', '裁切 (C)'],
  ];
  const KEY_TOOL = { v: 'pan', p: 'pen', h: 'hl', a: 'arrow', r: 'rect', e: 'ellipse', t: 'text', c: 'crop' };

  const emptyEdits = () => ({ crop: null, shapes: [] });
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const isEmpty = (e) => !e || (!e.crop && !(e.shapes && e.shapes.length));

  function drawShape(ctx, s) {
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = s.size;
    if (s.type === 'pen' || s.type === 'hl') {
      if (s.type === 'hl') { ctx.globalAlpha = 0.38; ctx.lineWidth = s.size * 4; ctx.lineCap = 'butt'; }
      ctx.beginPath();
      s.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] + 0.01, s.pts[0][1]);
      ctx.stroke();
    } else if (s.type === 'rect') {
      ctx.strokeRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
    } else if (s.type === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2, Math.abs(s.x2 - s.x1) / 2, Math.abs(s.y2 - s.y1) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.type === 'arrow') {
      const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const head = Math.max(s.size * 4, 12);
      const bx = s.x2 - Math.cos(ang) * head * 0.8, by = s.y2 - Math.sin(ang) * head * 0.8;
      ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(bx, by); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s.x2, s.y2);
      ctx.lineTo(s.x2 - head * Math.cos(ang - 0.45), s.y2 - head * Math.sin(ang - 0.45));
      ctx.lineTo(s.x2 - head * Math.cos(ang + 0.45), s.y2 - head * Math.sin(ang + 0.45));
      ctx.closePath(); ctx.fill();
    } else if (s.type === 'text') {
      const fs = s.size * 6;
      ctx.font = `700 ${fs}px "Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif`;
      ctx.textBaseline = 'top';
      ctx.lineWidth = Math.max(2, fs / 7);
      ctx.strokeStyle = s.color === '#111111' ? '#ffffff' : 'rgba(0,0,0,.85)';
      String(s.text).split('\n').forEach((line, i) => {
        ctx.strokeText(line, s.x, s.y + i * fs * 1.25);
        ctx.fillText(line, s.x, s.y + i * fs * 1.25);
      });
    }
    ctx.restore();
  }

  /** Render original + edits to a WebP blob (used on save; also exported for callers). */
  async function renderEdited(img, edits, quality) {
    const R = (edits && edits.crop) || { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
    const c = document.createElement('canvas');
    c.width = Math.round(R.w); c.height = Math.round(R.h);
    const ctx = c.getContext('2d');
    ctx.translate(-R.x, -R.y);
    ctx.drawImage(img, 0, 0);
    for (const s of (edits && edits.shapes) || []) drawShape(ctx, s);
    return new Promise((res) => c.toBlob(res, 'image/webp', quality || 0.92));
  }

  function loadImage(src) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('image load failed'));
      im.src = src;
    });
  }

  function open(opts) {
    const images = opts.images || [];
    if (!images.length) return;
    const readOnly = !!opts.readOnly;
    let idx = Math.min(images.length - 1, Math.max(0, opts.index || 0));
    // per-image session state
    const st = images.map((im) => ({ img: null, url: null, edits: clone(im.edits || emptyEdits()), undo: [], redo: [], dirty: false }));
    let tool = 'pan', color = COLORS[0], sizeLv = 3;
    let view = { s: 1, ox: 0, oy: 0 };
    let drag = null, pendingCrop = null, spaceDown = false, closed = false, textInput = null;

    // ---------- DOM ----------
    const root = document.createElement('div');
    root.className = 'yvne-root';
    root.tabIndex = -1;
    YVN.setHTML(root, `
      <div class="yvne-top">
        <div class="yvne-tools"></div>
        <div class="yvne-sep"></div>
        <div class="yvne-colors"></div>
        <label class="yvne-size" title="粗細"><input type="range" min="1" max="10" value="3"></label>
        <div class="yvne-sep"></div>
        <button class="yvne-btn" data-act="undo" title="復原 (Ctrl+Z)">↶</button>
        <button class="yvne-btn" data-act="redo" title="重做 (Ctrl+Y)">↷</button>
        <button class="yvne-btn" data-act="clear" title="清除全部：還原為原始未裁切/未標註底圖">Clear All</button>
        <div class="yvne-grow"></div>
        <button class="yvne-btn yvne-ts" data-act="seek" title="跳到此時間點"></button>
        <span class="yvne-count"></span>
        <button class="yvne-btn" data-act="fit" title="符合視窗 (0)">⤢</button>
        <button class="yvne-btn" data-act="download" title="下載目前圖片">⬇</button>
        <button class="yvne-btn yvne-primary" data-act="save">儲存修改</button>
        <button class="yvne-btn" data-act="close" title="關閉 (Esc)">✕</button>
      </div>
      <div class="yvne-stage">
        <canvas></canvas>
        <button class="yvne-nav yvne-prev" data-act="prev" title="上一張 (←)">‹</button>
        <button class="yvne-nav yvne-next" data-act="next" title="下一張 (→)">›</button>
        <div class="yvne-cropbar" hidden>
          <span>拖曳框選要保留的區域</span>
          <button class="yvne-btn yvne-primary" data-act="crop-apply">套用裁切 (Enter)</button>
          <button class="yvne-btn" data-act="crop-reset">取消裁切</button>
        </div>
        <div class="yvne-msg" hidden></div>
      </div>
      <div class="yvne-strip"></div>`);
    const $ = (sel) => root.querySelector(sel);
    const canvas = $('canvas'), ctx = canvas.getContext('2d'), stage = $('.yvne-stage');
    const toolsEl = $('.yvne-tools'), colorsEl = $('.yvne-colors'), stripEl = $('.yvne-strip');
    const msgEl = $('.yvne-msg'), cropbar = $('.yvne-cropbar');

    for (const [id, icon, title] of TOOLS) {
      if (readOnly && id !== 'pan') continue;
      const b = document.createElement('button');
      b.className = 'yvne-btn yvne-tool'; b.dataset.tool = id; b.title = title; b.textContent = icon;
      toolsEl.appendChild(b);
    }
    for (const c of COLORS) {
      const b = document.createElement('button');
      b.className = 'yvne-color'; b.dataset.color = c; b.style.background = c; b.title = c;
      colorsEl.appendChild(b);
    }
    if (readOnly) for (const sel of ['.yvne-colors', '.yvne-size', '[data-act=undo]', '[data-act=redo]', '[data-act=clear]', '[data-act=save]']) $(sel).style.display = 'none';
    if (!opts.onSeek) $('[data-act=seek]').disabled = true;

    images.forEach((im, i) => {
      const t = document.createElement('button');
      t.className = 'yvne-thumb'; t.dataset.i = i;
      const badge = document.createElement('span');
      badge.textContent = im.ts == null ? '' : YVN.fmtTime(im.ts);
      t.appendChild(badge);
      stripEl.appendChild(t);
    });
    if (images.length < 2) { stripEl.style.display = 'none'; $('.yvne-prev').style.display = $('.yvne-next').style.display = 'none'; }

    (opts.mount || document.body).appendChild(root);
    root.focus();

    // ---------- geometry ----------
    const cur = () => st[idx];
    const region = () => {
      const s = cur();
      const full = { x: 0, y: 0, w: s.img.naturalWidth, h: s.img.naturalHeight };
      return tool === 'crop' ? full : s.edits.crop || full;
    };
    const baseSize = () => Math.max(1, cur().img.naturalWidth / 420) * sizeLv;
    const toImg = (ev) => {
      const r = canvas.getBoundingClientRect(), R = region();
      return [(ev.clientX - r.left - view.ox) / view.s + R.x, (ev.clientY - r.top - view.oy) / view.s + R.y];
    };
    function fit() {
      if (!cur().img) return;
      const R = region(), w = stage.clientWidth, h = stage.clientHeight, pad = 24;
      view.s = Math.min((w - pad * 2) / R.w, (h - pad * 2) / R.h);
      view.ox = (w - R.w * view.s) / 2; view.oy = (h - R.h * view.s) / 2;
      draw();
    }
    function resize() {
      const dpr = g.devicePixelRatio || 1;
      canvas.width = Math.round(stage.clientWidth * dpr); canvas.height = Math.round(stage.clientHeight * dpr);
      canvas.style.width = stage.clientWidth + 'px'; canvas.style.height = stage.clientHeight + 'px';
      draw();
    }

    function draw() {
      const s = cur(), dpr = g.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!s.img) return;
      const R = region();
      ctx.save();
      ctx.translate(view.ox, view.oy); ctx.scale(view.s, view.s); ctx.translate(-R.x, -R.y);
      ctx.beginPath(); ctx.rect(R.x, R.y, R.w, R.h); ctx.clip();
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(s.img, 0, 0);
      for (const sh of s.edits.shapes) drawShape(ctx, sh);
      if (drag && drag.shape) drawShape(ctx, drag.shape);
      if (tool === 'crop') {
        const c = pendingCrop || s.edits.crop;
        if (c) {
          ctx.fillStyle = 'rgba(0,0,0,.6)';
          ctx.beginPath(); ctx.rect(R.x, R.y, R.w, R.h); ctx.rect(c.x, c.y, c.w, c.h); ctx.fill('evenodd');
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / view.s; ctx.setLineDash([8 / view.s, 6 / view.s]);
          ctx.strokeRect(c.x, c.y, c.w, c.h);
        }
      }
      ctx.restore();
    }

    // ---------- state helpers ----------
    function refreshUI() {
      const s = cur();
      toolsEl.querySelectorAll('.yvne-tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
      colorsEl.querySelectorAll('.yvne-color').forEach((b) => b.classList.toggle('on', b.dataset.color === color));
      stripEl.querySelectorAll('.yvne-thumb').forEach((b, i) => { b.classList.toggle('on', i === idx); b.classList.toggle('dirty', st[i].dirty); });
      $('[data-act=undo]').disabled = !s.undo.length;
      $('[data-act=redo]').disabled = !s.redo.length;
      const anyDirty = st.some((x) => x.dirty);
      const saveBtn = $('[data-act=save]');
      saveBtn.disabled = !anyDirty; saveBtn.textContent = anyDirty ? '儲存修改 ●' : '儲存修改';
      $('.yvne-ts').textContent = '⏱ ' + YVN.fmtTime(images[idx].ts);
      $('.yvne-ts').style.visibility = images[idx].ts == null ? 'hidden' : '';
      $('.yvne-count').textContent = `${idx + 1} / ${images.length}`;
      cropbar.hidden = tool !== 'crop';
      canvas.style.cursor = tool === 'pan' ? (drag ? 'grabbing' : 'grab') : tool === 'text' ? 'text' : 'crosshair';
    }
    function commit(mutator) {
      const s = cur();
      s.undo.push(JSON.stringify(s.edits));
      if (s.undo.length > 100) s.undo.shift();
      s.redo.length = 0;
      mutator(s.edits);
      s.dirty = true;
      refreshUI(); draw();
    }
    function undo() { const s = cur(); if (!s.undo.length) return; s.redo.push(JSON.stringify(s.edits)); s.edits = JSON.parse(s.undo.pop()); s.dirty = true; pendingCrop = null; refreshUI(); tool === 'crop' ? draw() : fit(); }
    function redo() { const s = cur(); if (!s.redo.length) return; s.undo.push(JSON.stringify(s.edits)); s.edits = JSON.parse(s.redo.pop()); s.dirty = true; pendingCrop = null; refreshUI(); tool === 'crop' ? draw() : fit(); }
    function setTool(t) {
      if (readOnly && t !== 'pan') return;
      commitText();
      const was = tool; tool = t; pendingCrop = null;
      refreshUI();
      if ((was === 'crop') !== (t === 'crop')) fit(); else draw();
    }
    function say(text) { msgEl.textContent = text || ''; msgEl.hidden = !text; }

    async function show(i) {
      commitText();
      idx = (i + images.length) % images.length;
      pendingCrop = null; drag = null;
      if (tool === 'crop') tool = 'pan';
      const s = cur();
      refreshUI();
      if (!s.img) {
        say('載入中…'); draw();
        try {
          if (!s.url) {
            const src = await images[idx].load();
            if (closed) return;
            if (!src) throw new Error('no image');
            if (!s.url) s.url = typeof src === 'string' ? src : URL.createObjectURL(src);
          }
          s.img = await loadImage(s.url);
          const th = stripEl.children[idx];
          if (th) th.style.backgroundImage = `url("${s.url}")`;
        } catch (e) { say('圖片載入失敗（尚未同步或離線）'); return; }
      }
      if (closed || s !== cur()) return;
      say(''); resize(); fit(); refreshUI();
    }
    // lazily fill thumbnails of the other images
    images.forEach(async (im, i) => {
      if (images.length < 2) return;
      try {
        const src = await im.load();
        if (closed || !src) return;
        if (!st[i].url) st[i].url = typeof src === 'string' ? src : URL.createObjectURL(src);
        stripEl.children[i].style.backgroundImage = `url("${st[i].url}")`;
      } catch (e) { /* ignore */ }
    });

    // ---------- text tool ----------
    function startText(pt, ev) {
      if (readOnly) return;
      commitText();
      const r = stage.getBoundingClientRect();
      const ta = document.createElement('textarea');
      ta.className = 'yvne-text'; ta.rows = 1; ta.placeholder = '輸入文字，Enter 確認';
      const fs = baseSize() * 6 * view.s;
      Object.assign(ta.style, { left: ev.clientX - r.left + 'px', top: ev.clientY - r.top + 'px', color, fontSize: Math.max(12, fs) + 'px' });
      stage.appendChild(ta);
      textInput = { ta, pt, color, size: baseSize() };
      setTimeout(() => ta.focus(), 0);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); }
        else if (e.key === 'Escape') { e.preventDefault(); ta.remove(); textInput = null; root.focus(); }
        e.stopPropagation();
      });
      ta.addEventListener('blur', () => setTimeout(commitText, 0));
    }
    function commitText() {
      if (!textInput) return;
      const { ta, pt, color: c, size } = textInput;
      textInput = null;
      const text = ta.value.trim();
      ta.remove();
      if (text) commit((e) => e.shapes.push({ type: 'text', color: c, size, x: pt[0], y: pt[1], text }));
      root.focus();
    }

    // ---------- pointer ----------
    canvas.addEventListener('pointerdown', (ev) => {
      if (!cur().img || textInput) return;
      canvas.setPointerCapture(ev.pointerId);
      const pt = toImg(ev);
      if (tool === 'pan' || ev.button === 1 || ev.button === 2 || spaceDown) {
        drag = { pan: true, x: ev.clientX, y: ev.clientY, ox: view.ox, oy: view.oy };
      } else if (tool === 'text') {
        startText(pt, ev); return;
      } else if (tool === 'crop') {
        drag = { crop: true, start: pt };
        pendingCrop = { x: pt[0], y: pt[1], w: 0, h: 0 };
      } else if (tool === 'pen' || tool === 'hl') {
        drag = { shape: { type: tool, color, size: baseSize(), pts: [pt] } };
      } else {
        drag = { shape: { type: tool, color, size: baseSize(), x1: pt[0], y1: pt[1], x2: pt[0], y2: pt[1] } };
      }
      refreshUI(); ev.preventDefault();
    });
    canvas.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      if (drag.pan) { view.ox = drag.ox + ev.clientX - drag.x; view.oy = drag.oy + ev.clientY - drag.y; draw(); return; }
      const pt = toImg(ev);
      if (drag.crop) {
        const im = cur().img, cl = (v, a, b) => Math.min(b, Math.max(a, v));
        const x1 = cl(drag.start[0], 0, im.naturalWidth), y1 = cl(drag.start[1], 0, im.naturalHeight);
        const x2 = cl(pt[0], 0, im.naturalWidth), y2 = cl(pt[1], 0, im.naturalHeight);
        pendingCrop = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
      } else if (drag.shape.pts) drag.shape.pts.push(pt);
      else { drag.shape.x2 = pt[0]; drag.shape.y2 = pt[1]; }
      draw();
    });
    const endDrag = () => {
      if (!drag) return;
      const d = drag; drag = null;
      if (d.shape) {
        const sh = d.shape;
        const tiny = !sh.pts && Math.hypot(sh.x2 - sh.x1, sh.y2 - sh.y1) < 3 / view.s;
        if (!tiny) {
          if (sh.pts) sh.pts = sh.pts.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
          commit((e) => e.shapes.push(sh));
        }
      }
      if (d.crop && pendingCrop && (pendingCrop.w < 8 || pendingCrop.h < 8)) pendingCrop = null;
      refreshUI(); draw();
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('dblclick', (ev) => { if (cur().img && tool !== 'crop') startText(toImg(ev), ev); });
    canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      if (!cur().img) return;
      const r = canvas.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
      const f = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015));
      const ns = Math.min(40, Math.max(0.05, view.s * f));
      view.ox = mx - ((mx - view.ox) * ns) / view.s; view.oy = my - ((my - view.oy) * ns) / view.s; view.s = ns;
      draw();
    }, { passive: false });

    function applyCrop() {
      if (!pendingCrop) { setTool('pan'); return; }
      const c = { x: Math.round(pendingCrop.x), y: Math.round(pendingCrop.y), w: Math.round(pendingCrop.w), h: Math.round(pendingCrop.h) };
      pendingCrop = null;
      commit((e) => { e.crop = c; });
      setTool('pan');
    }

    // ---------- actions ----------
    async function save() {
      if (!opts.onSave) return;
      const btn = $('[data-act=save]');
      btn.disabled = true; btn.textContent = '儲存中…';
      try {
        for (let i = 0; i < st.length; i++) {
          const s = st[i];
          if (!s.dirty || !s.img) continue;
          if (isEmpty(s.edits)) await opts.onSave(images[i], { edits: null, blob: null });
          else await opts.onSave(images[i], { edits: clone(s.edits), blob: await renderEdited(s.img, s.edits) });
          images[i].edits = isEmpty(s.edits) ? null : clone(s.edits);
          s.dirty = false;
        }
      } catch (e) { console.error(e); say('儲存失敗：' + e.message); setTimeout(() => say(''), 3000); }
      refreshUI();
    }
    function close(force) {
      if (!force && st.some((s) => s.dirty) && !confirm('有尚未儲存的修改，確定要關閉嗎？')) return;
      closed = true;
      g.removeEventListener('keydown', onKey, true);
      g.removeEventListener('keyup', onKeyUp, true);
      g.removeEventListener('resize', resize);
      for (const s of st) if (s.url && s.url.startsWith('blob:')) URL.revokeObjectURL(s.url);
      root.remove();
      if (opts.onClose) opts.onClose();
    }
    async function download() {
      const s = cur(); if (!s.img) return;
      const blob = await renderEdited(s.img, s.edits);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `${images[idx].id || 'screenshot'}.webp`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }

    root.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-act],[data-tool],[data-color],[data-i]');
      if (!t || !root.contains(t)) return;
      if (t.dataset.tool) return setTool(t.dataset.tool);
      if (t.dataset.color) { color = t.dataset.color; if (textInput) textInput.ta.style.color = textInput.color = color; return refreshUI(); }
      if (t.dataset.i) return show(+t.dataset.i);
      switch (t.dataset.act) {
        case 'undo': return undo();
        case 'redo': return redo();
        case 'clear': if (!isEmpty(cur().edits)) { commit((e) => { e.crop = null; e.shapes = []; }); setTool('pan'); fit(); } return;
        case 'fit': return fit();
        case 'save': return save();
        case 'close': return close();
        case 'prev': return show(idx - 1);
        case 'next': return show(idx + 1);
        case 'download': return download();
        case 'seek': if (opts.onSeek) { opts.onSeek(images[idx].ts, images[idx]); close(); } return;
        case 'crop-apply': return applyCrop();
        case 'crop-reset': pendingCrop = null; if (cur().edits.crop) commit((e) => { e.crop = null; }); return setTool('pan');
      }
    });
    $('.yvne-size input').addEventListener('input', (e) => { sizeLv = +e.target.value; });

    // Capture keys at window level so the host page (YouTube hotkeys) never sees them while the editor is open.
    function onKey(ev) {
      if (closed) return;
      ev.stopImmediatePropagation();
      if (textInput && ev.target === textInput.ta) return;
      const k = ev.key.toLowerCase(), mod = ev.ctrlKey || ev.metaKey;
      if (k === ' ') { spaceDown = true; ev.preventDefault(); return; }
      if (k === 'escape') { ev.preventDefault(); if (tool === 'crop') setTool('pan'); else close(); return; }
      if (mod && k === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
      if (mod && k === 'y') { ev.preventDefault(); redo(); return; }
      if (mod && k === 's') { ev.preventDefault(); save(); return; }
      if (mod) return;
      if (k === 'arrowleft') { ev.preventDefault(); show(idx - 1); }
      else if (k === 'arrowright') { ev.preventDefault(); show(idx + 1); }
      else if (k === 'enter' && tool === 'crop') { ev.preventDefault(); applyCrop(); }
      else if (k === '0') fit();
      else if (KEY_TOOL[k]) { ev.preventDefault(); setTool(KEY_TOOL[k]); }
    }
    function onKeyUp(ev) { if (closed) return; ev.stopImmediatePropagation(); if (ev.key === ' ') spaceDown = false; }
    g.addEventListener('keydown', onKey, true);
    g.addEventListener('keyup', onKeyUp, true);
    g.addEventListener('resize', resize);

    show(idx);
    return { close: () => close(true) };
  }

  YVN.Editor = { open, renderEdited, drawShape };
})(typeof self !== 'undefined' ? self : globalThis);
