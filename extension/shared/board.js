/* YT-Vision-Notes — whiteboard engine (Milanote-style boards inside boards).
 * Shared by the YouTube side panel, the pop-out window and the web app. No dependencies.
 *
 * const view = new YVN.BoardView(rootEl, api, {
 *   mode: 'panel' | 'window' | 'web',
 *   capture: async () => ({ dataURL, w, h, ts, video }) | null,   // optional: grab the current YouTube frame
 *   currentVideo: () => video | null,                              // optional: for "總結筆記"
 *   seek: (video, ts) => {},                                       // timestamp click
 *   headerExtras: [elements],  onNavigate: (boardId) => {},  toast: (msg) => {},
 * });
 * view.open(boardId)
 *
 * api (all async): getBoard(id), summaries(), createBoard(parentId,{title,color,x,y}), updateBoard(id,patch),
 *   putItem(boardId,item,origDataURL?), patchItems(boardId,patches), deleteItems(boardId,ids),
 *   moveItems(from,to,ids,positions), getImage(boardId,item,which) → url, saveImageEdit(boardId,itemId,edits,blob),
 *   search(q), recent(), touchRecent(id), onChange(fn(boardId|null)) → unsubscribe
 */
(function (g) {
  'use strict';
  const YVN = (g.YVN = g.YVN || {});
  const HOME = YVN.HOME || 'home';

  // ---------- DOM helpers (no innerHTML except trusted SVG/markdown via YVN.setHTML) ----------
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k === 'html') YVN.setHTML(n, v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(c));
    return n;
  }
  const ICONS = {
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    summary: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 11h7M9 15h7M9 7h4"/>',
    note: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 10h8M8 14h6"/>',
    board: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="3.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    todo: '<rect x="4" y="5" width="5" height="5" rx="1"/><path d="m5 7.5 1.3 1.3L8.5 6.3M12 7.5h8M4 15h5v5H4zM12 17.5h8"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m5 18 5-5 3 3 2-2 4 4"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/>',
    more: '<circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/>',
    home: '<path d="M4 11 12 4l8 7v9h-5v-6H9v6H4z"/>',
    minus: '<path d="M6 12h12"/>',
    plus: '<path d="M12 6v12M6 12h12"/>',
    fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    play: '<path d="M8 5v14l11-7z"/>',
    popout: '<rect x="3" y="7" width="12" height="12" rx="2"/><path d="M10 4h10v10M20 4l-8 8"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    dock: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M14 5v14"/>',
    comment: '<path d="M4 5h16v11H10l-4 4v-4H4z"/>',
    column: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h8"/>',
    table: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M3 15h18M9 5v14M15 5v14"/>',
    sketch: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 15c2-4 3 1 5-2s3-3 5 0"/>',
    heading: '<path d="M6 5h12M12 5v14M9 19h6"/>',
    video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
    map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
    audio: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
    doc: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
    upload: '<path d="M6 3h8l5 5v13H6z"/><path d="M13 3v6h6"/>',
    draw: '<path d="m4 20 4-1 11-11-3-3L5 16z"/><path d="m14 6 3 3"/>',
    file: '<path d="M6 3h8l5 5v13H6z"/><path d="M13 3v6h6"/>',
    line: '<path d="M5 19 19 5"/><path d="M12 5h7v7"/>',
    swatch: '<rect x="4" y="4" width="12" height="16" rx="2"/><path d="M4 14h12"/><path d="m16 7 4 2-4 9"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  };
  const icon = (name, size) => el('span', { class: 'yb-ic', 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24" width="${size || 18}" height="${size || 18}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>` });
  const ytId = (url) => { const m = /(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/)([\w-]{11})/.exec(url || ''); return m ? m[1] : null; };
  const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; } };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const snap = (v) => Math.round(v / 10) * 10;

  class BoardView {
    constructor(root, api, opts) {
      this.root = root; this.api = api; this.o = opts || {};
      this.mode = this.o.mode || 'web';
      this.boardId = null; this.board = null; this.sums = {};
      this.els = new Map(); this.sel = new Set(); this.editing = null;
      this.view = { x: 0, y: 0, z: 1 };
      this.imgCache = new Map();
      this.gesture = null;
      this.history = []; this.future = [];
      // mutations go through this recording wrapper so they can be undone (Ctrl+Z)
      const rec = (name, boardsOf) => async (...a) => {
        const ids = boardsOf(...a).filter(Boolean);
        const before = await this._snap(ids);
        const r = await api[name](...a);
        await this._pushHistory(ids, before);
        return r;
      };
      this.m = {
        putItem: rec('putItem', (b) => [b]),
        patchItems: rec('patchItems', (b) => [b]),
        deleteItems: rec('deleteItems', (b) => [b]),
        createBoard: rec('createBoard', (p) => [p]),
        moveItems: rec('moveItems', (f, t) => [f, t]),
      };
      this._build();
      this._unsub = api.onChange && api.onChange((id) => { if (!id || id === this.boardId || this._refs(id)) this._scheduleReload(); });
    }

    _refs(boardId) { return this.board && YVN.liveItems(this.board).some((i) => i.type === 'board' && i.boardId === boardId); }
    _scheduleReload() { clearTimeout(this._rt); this._rt = setTimeout(() => this.reload(), 120); }

    // ---------- layout ----------
    _build() {
      const r = this.root;
      r.classList.add('yb', 'yb-' + this.mode);
      YVN.setHTML(r, '');
      this.crumbs = el('nav', { class: 'yb-crumbs', 'aria-label': 'Board path' });
      this.zoomLbl = el('button', { class: 'yb-hbtn yb-zoom', title: 'Fit to screen (Ctrl+wheel to zoom)', onclick: () => this.fit() }, '100%');
      this.head = el('header', { class: 'yb-head' }, this.crumbs, el('span', { class: 'yb-grow' }),
        this.mode !== 'panel' && el('button', { class: 'yb-hbtn', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', onclick: () => this.undo() }, icon('undo', 17)),
        this.mode !== 'panel' && el('button', { class: 'yb-hbtn', title: 'Redo (Ctrl+Y)', 'aria-label': 'Redo', onclick: () => this.redo() }, icon('redo', 17)),
        el('button', { class: 'yb-hbtn', title: 'Search all notes (Ctrl+F)', 'aria-label': 'Search', onclick: () => this.toggleSearch(true) }, icon('search')),
        this.mode !== 'panel' && el('button', { class: 'yb-hbtn', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => this.zoomBy(1 / 1.2) }, icon('minus', 16)),
        this.zoomLbl,
        this.mode !== 'panel' && el('button', { class: 'yb-hbtn', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => this.zoomBy(1.2) }, icon('plus', 16)),
        ...(this.o.headerExtras || []));
      this.recentRow = el('div', { class: 'yb-recent', hidden: true });
      this.layer = el('div', { class: 'yb-layer' });
      this.marquee = el('div', { class: 'yb-marquee', hidden: true });
      this.empty = el('div', { class: 'yb-empty', hidden: true });
      this.vp = el('div', { class: 'yb-vp', tabindex: '0' }, this.layer, this.marquee, this.empty);
      this.menu = el('div', { class: 'yb-menu', hidden: true, role: 'menu' });
      this.searchBox = this._buildSearch();
      this.toastEl = el('div', { class: 'yb-toast', role: 'status', hidden: true });
      this.fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: (e) => { this._addFiles([...e.target.files], null, this._fileKind); e.target.value = ''; } });

      const T = {
        shot: ['camera', 'Capture', 'Capture the current video frame into this board (Alt+S)'],
        summary: ['summary', 'Summary', 'A summary note for the whole video (no screenshot)'],
        note: ['note', 'Note', 'Text note (or double-click empty space)'],
        link: ['link', 'Link', 'A web link or YouTube video'],
        todo: ['todo', 'To-do', 'To-do list'],
        line: ['line', 'Line', 'Draw a line or arrow between cards'],
        board: ['board', 'Board', 'New board inside this one'],
        column: ['column', 'Column', 'Column: stack cards in a list and move them together'],
        comment: ['comment', 'Comment', 'Comment thread: reply to it, put it in a column'],
        table: ['table', 'Table', 'Table'],
        sketch: ['sketch', 'Sketch', 'Sketch inside a card'],
        color: ['swatch', 'Color', 'Color swatch (click the hex code to copy it)'],
        heading: ['heading', 'Heading', 'Large heading text (no card background)'],
        video: ['video', 'Video', 'Embed a YouTube / Vimeo video, or upload a video file'],
        map: ['map', 'Map', 'Embed a map of a place'],
        audio: ['audio', 'Audio', 'Upload an audio file and play it in the card'],
        doc: ['doc', 'Document', 'Long-form document: the card shows a preview, opens full screen'],
        upload_image: ['image', 'Image', 'Add an image (or paste / drop one)'],
        upload: ['upload', 'Upload', 'Upload any file (PDF, audio, video…)'],
        draw: ['draw', 'Draw', 'Draw freehand on the board'],
      };
      const MAIN = [this.o.capture && 'shot', this.o.capture && 'summary', 'note', 'link', 'todo', 'line', 'board', 'column', 'comment', 'table', 'sketch', 'color'].filter(Boolean);
      const MORE = ['heading', 'video', 'map', 'audio', 'doc'];
      const LOWER = ['upload_image', 'upload', 'draw'];
      const btn = (act) => {
        const b = el('button', { class: 'yb-tool' + (act === 'shot' ? ' yb-primary' : ''), title: T[act][2] + ' — click, or drag onto the board', dataset: { tool: act }, onclick: () => { if (this._toolDragged) { this._toolDragged = false; return; } this.tool(act); } }, icon(T[act][0], 20), el('span', {}, T[act][1]));
        this._dragTool(b, act);
        return b;
      };
      let toolbar;
      if (this.mode === 'panel') {
        const main = ['shot', 'summary', 'board'].filter((k) => MAIN.includes(k));
        const rest = [...MAIN, ...MORE, ...LOWER].filter((k) => !main.includes(k));
        toolbar = el('div', { class: 'yb-bar' }, main.map(btn),
          el('button', { class: 'yb-tool', title: 'More', onclick: (e) => this._menuAt(e.currentTarget, [
            ...rest.map((k) => ({ label: T[k][1], icon: T[k][0], run: () => this.tool(k) })),
            { sep: true },
            { label: 'Undo (Ctrl+Z)', icon: 'undo', run: () => this.undo() },
            { label: 'Redo (Ctrl+Y)', icon: 'redo', run: () => this.redo() },
            { label: 'Trash', icon: 'trash', run: () => this.openTrash() },
          ], true) }, icon('more', 20), el('span', {}, 'More')));
        r.append(this.head, this.recentRow, el('div', { class: 'yb-body' }, this.vp), toolbar);
      } else {
        this.flyout = el('div', { class: 'yb-flyout', hidden: true },
          ...MORE.map((k) => { const b = el('button', { class: 'yb-tool', title: T[k][2], onclick: () => { if (this._toolDragged) { this._toolDragged = false; return; } this.flyout.hidden = true; this.tool(k); } }, icon(T[k][0], 24), el('span', {}, T[k][1])); this._dragTool(b, k); return b; }));
        const moreBtn = el('button', { class: 'yb-tool yb-moretool', title: 'More tools', 'aria-label': 'More tools', onclick: (e) => {
          const fr = e.currentTarget.getBoundingClientRect(), rr = r.getBoundingClientRect();
          this.flyout.hidden = !this.flyout.hidden;
          this.flyout.style.left = fr.right - rr.left + 8 + 'px';
          this.flyout.style.top = Math.max(8, Math.min(fr.top - rr.top - 60, rr.height - 260)) + 'px';
        } }, el('span', { class: 'yb-dots' }, icon('more', 20)));
        toolbar = el('div', { class: 'yb-tools' }, MAIN.map(btn), moreBtn, el('hr', { class: 'yb-tsep' }), LOWER.map(btn),
          el('button', { class: 'yb-tool yb-trashbtn', title: 'Trash: deleted cards are kept for 30 days and can be restored', onclick: () => this.openTrash() }, icon('trash', 20), el('span', {}, 'Trash')));
        r.append(this.head, this.recentRow, el('div', { class: 'yb-body' }, toolbar, this.vp), this.flyout);
      }
      this.drawBar = this._buildDrawBar();
      r.append(this.drawBar);
      this.cpop = el('div', { class: 'yb-cpop', hidden: true, role: 'dialog' });
      this.trashBox = el('div', { class: 'yb-search yb-trashbox', hidden: true });
      r.append(this.menu, this.searchBox, this.trashBox, this.cpop, this.toastEl, this.fileInput);
      this.fmt = new YVN.FormatBar(r);
      this.cpop.addEventListener('keydown', (e) => e.stopPropagation());
      this._bind();
    }

    _buildSearch() {
      this.sInput = el('input', { type: 'search', placeholder: 'Search notes, #tags and video titles in all boards…', 'aria-label': 'Search' });
      this.sList = el('ul', { class: 'yb-sres' });
      let t;
      this.sInput.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => this._runSearch(), 150); });
      this.sInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') this.toggleSearch(false);
        if (e.key === 'Enter') { const f = this.sList.querySelector('li'); if (f) f.click(); }
      });
      return el('div', { class: 'yb-search', hidden: true },
        el('div', { class: 'yb-srow' }, this.sInput, el('button', { class: 'yb-hbtn', 'aria-label': 'Close search', onclick: () => this.toggleSearch(false) }, '✕')),
        this.sList);
    }
    toggleSearch(on, q) {
      this.searchBox.hidden = !on;
      if (on) { if (q != null) this.sInput.value = q; this.sInput.focus(); this._runSearch(); }
    }
    async _runSearch() {
      const q = this.sInput.value.trim();
      this.sList.replaceChildren();
      if (!q) return;
      const res = await this.api.search(q);
      if (!res.length) { this.sList.append(el('li', { class: 'yb-snone' }, 'No matching notes')); return; }
      const label = { note: 'Note', shot: 'Capture', image: 'Image', board: 'Board', link: 'Link', column: 'Column', line: 'Line', color: 'Color', comment: 'Comment', heading: 'Heading', table: 'Table', sketch: 'Sketch', video: 'Video', map: 'Map', audio: 'Audio', file: 'File', doc: 'Document', ink: 'Draw' };
      for (const r of res) {
        const text = (r.text || '').replace(/\s+/g, ' ');
        this.sList.append(el('li', { tabindex: '0', onclick: () => { this.toggleSearch(false); this.open(r.type === 'board' && !r.itemId ? r.boardId : r.boardId, r.itemId); } },
          el('small', {}, `${r.boardTitle || 'Home'} · ${label[r.type] || ''}${r.ts != null ? ' · ' + YVN.fmtTime(r.ts) : ''}`),
          el('span', {}, text.length > 90 ? text.slice(0, 90) + '…' : text || '(no text)')));
      }
    }

    toast(msg) {
      if (this.o.toast) return this.o.toast(msg);
      this.toastEl.textContent = msg; this.toastEl.hidden = false;
      clearTimeout(this._tt); this._tt = setTimeout(() => { this.toastEl.hidden = true; }, 2600);
    }

    // ---------- navigation ----------
    async open(boardId, focusItemId) {
      if (this.editing) await this.commitEdit();
      const prev = this.boardId;
      this.boardId = boardId || HOME;
      this.sel.clear();
      if (prev !== this.boardId) { this.layer.replaceChildren(); this.els.clear(); }
      this.view = this._loadView(this.boardId);
      await this.reload();
      if (!this.board) return this.open(HOME);
      this.api.touchRecent && this.api.touchRecent(this.boardId);
      if (this.o.onNavigate) this.o.onNavigate(this.boardId);
      if (focusItemId) this.focusItem(focusItemId);
      this.vp.focus({ preventScroll: true });
    }

    async reload() {
      const id = this.boardId;
      const [board, sums] = await Promise.all([this.api.getBoard(id), this.api.summaries()]);
      if (id !== this.boardId) return;
      this.board = board && !board.deleted ? board : null; this.sums = sums || {};
      if (!this.board) return;
      this._renderCrumbs();
      await this._renderRecent();
      this._renderItems();
      this._applyView();
    }

    _chain() {
      const out = [];
      let cur = this.boardId;
      const seen = new Set();
      while (cur && !seen.has(cur) && out.length < 30) {
        seen.add(cur);
        out.unshift(cur);
        if (cur === HOME) break;
        const s = this.sums[cur] || (cur === this.boardId && this.board);
        cur = s && s.parentId ? s.parentId : HOME;
      }
      if (out[0] !== HOME) out.unshift(HOME);
      return out;
    }
    _title(id) { return id === HOME ? 'Home' : (this.sums[id] && this.sums[id].title) || (this.board && this.board.id === id && this.board.title) || 'Untitled'; }

    _renderCrumbs() {
      const chain = this._chain();
      this.crumbs.replaceChildren();
      chain.forEach((id, i) => {
        const last = i === chain.length - 1;
        if (i) this.crumbs.append(el('span', { class: 'yb-sep', 'aria-hidden': 'true' }, '›'));
        const b = el('button', { class: 'yb-crumb' + (last ? ' yb-cur' : ''), title: last && id !== HOME ? 'Double-click to rename' : this._title(id) },
          id === HOME ? icon('home', 16) : el('i', { class: 'yb-cdot', style: `background:${(this.sums[id] || this.board || {}).color || '#8b8d98'}` }),
          el('span', {}, id === HOME ? 'Home' : this._title(id)));
        if (!last) b.onclick = () => this.open(id);
        else if (id !== HOME) b.ondblclick = () => this._renameInline(b.querySelector('span'), id);
        this.crumbs.append(b);
      });
      requestAnimationFrame(() => { this.crumbs.scrollLeft = this.crumbs.scrollWidth; });
    }

    async _renderRecent() {
      const show = this.boardId === HOME && this.api.recent;
      this.recentRow.hidden = true;
      if (!show) return;
      const ids = (await this.api.recent()).filter((id) => this.sums[id] && !this.sums[id].deleted).slice(0, 8);
      if (!ids.length) return;
      this.recentRow.replaceChildren(el('small', {}, 'Recent'),
        ...ids.map((id) => el('button', { class: 'yb-chip', onclick: () => this.open(id) },
          el('i', { class: 'yb-cdot', style: `background:${this.sums[id].color}` }), this.sums[id].title || 'Untitled')));
      this.recentRow.hidden = false;
    }

    // ---------- view (pan / zoom) ----------
    _loadView(id) {
      const def = { x: 0, y: 0, z: this.mode === 'panel' ? 0.7 : 1 };
      try { return { ...def, ...JSON.parse(localStorage.getItem(`yb-view:${this.mode}:${id}`) || '{}') }; } catch (e) { return def; }
    }
    _saveView() {
      clearTimeout(this._vt);
      this._vt = setTimeout(() => { try { localStorage.setItem(`yb-view:${this.mode}:${this.boardId}`, JSON.stringify(this.view)); } catch (e) { /* storage blocked */ } }, 300);
    }
    _applyView() {
      const { x, y, z } = this.view;
      this.layer.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
      this.vp.style.backgroundPosition = `${x}px ${y}px`;
      this.vp.style.backgroundSize = `${24 * z}px ${24 * z}px`;
      this.zoomLbl.textContent = Math.round(z * 100) + '%';
    }
    zoomBy(f, cx, cy) {
      const r = this.vp.getBoundingClientRect();
      if (cx == null) { cx = r.width / 2; cy = r.height / 2; }
      const z = clamp(this.view.z * f, 0.2, 2.5);
      this.view.x = cx - (cx - this.view.x) * (z / this.view.z);
      this.view.y = cy - (cy - this.view.y) * (z / this.view.z);
      this.view.z = z;
      this._applyView(); this._saveView();
    }
    _rectOf(it) {
      if (it.type === 'line' || it.type === 'ink') return { x: 0, y: 0, w: 0, h: 0 };
      const e = this.els.get(it.id);
      if (e && e.isConnected && this._inCol(it)) return this._layerRect(e);
      if (e && e.offsetWidth) return { x: it.x, y: it.y, w: e.offsetWidth, h: e.offsetHeight };
      return { x: it.x, y: it.y, ...YVN.estimateSize(it) };
    }
    /** Element box in board coordinates (works for cards inside columns and while dragging). */
    _layerRect(e) {
      const r = e.getBoundingClientRect(), v = this.vp.getBoundingClientRect(), z = this.view.z;
      return { x: (r.left - v.left - this.view.x) / z, y: (r.top - v.top - this.view.y) / z, w: r.width / z, h: r.height / z };
    }
    _inCol(it) { return !!(it && it.col && this._colIds && this._colIds.has(it.col)); }
    /** Free-floating cards (not lines, not cards stacked inside a column). */
    _cards() { return YVN.liveItems(this.board).filter((i) => i.type !== 'line' && i.type !== 'ink' && !this._inCol(i)); }
    fit() {
      const items = this._cards();
      const r = this.vp.getBoundingClientRect();
      if (!items.length) { this.view = { x: 0, y: 0, z: this.mode === 'panel' ? 0.7 : 1 }; this._applyView(); this._saveView(); return; }
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const it of items) { const b = this._rectOf(it); x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h); }
      const z = clamp(Math.min((r.width - 48) / (x2 - x1), (r.height - 48) / (y2 - y1), 1), 0.2, 1);
      this.view = { z, x: (r.width - (x2 - x1) * z) / 2 - x1 * z, y: Math.max(16, (r.height - (y2 - y1) * z) / 2) - y1 * z };
      this._applyView(); this._saveView();
    }
    _toBoard(clientX, clientY) {
      const r = this.vp.getBoundingClientRect();
      return { x: (clientX - r.left - this.view.x) / this.view.z, y: (clientY - r.top - this.view.y) / this.view.z };
    }
    _visible() {
      const r = this.vp.getBoundingClientRect();
      return { x: -this.view.x / this.view.z, y: -this.view.y / this.view.z, w: r.width / this.view.z, h: r.height / this.view.z };
    }
    focusItem(id, flash) {
      const it = this.board && this.board.items.find((i) => i.id === id && !i.deleted);
      if (!it) return;
      const b = this._rectOf(it), v = this._visible();
      const inside = b.x >= v.x && b.y >= v.y && b.x + b.w <= v.x + v.w && b.y + b.h <= v.y + v.h;
      if (!inside) {
        const r = this.vp.getBoundingClientRect();
        this.view.x = r.width / 2 - (b.x + b.w / 2) * this.view.z;
        this.view.y = Math.min(r.height / 2 - (b.y + b.h / 2) * this.view.z, 24 - b.y * this.view.z);
        this._applyView(); this._saveView();
      }
      this.sel = new Set([id]); this._paintSel();
      const e = this.els.get(id);
      if (e && flash !== false) { e.classList.remove('yb-flash'); void e.offsetWidth; e.classList.add('yb-flash'); }
    }

    // ---------- rendering ----------
    _renderItems() {
      const live = YVN.liveItems(this.board);
      this._colIds = new Set(live.filter((i) => i.type === 'column').map((i) => i.id));
      if (!this.svg) {
        this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.svg.setAttribute('class', 'yb-lines');
        this.lbls = el('div', { class: 'yb-llabels' });
      }
      if (this.layer.firstChild !== this.svg) this.layer.prepend(this.svg, this.lbls);
      const keep = new Set();
      const kids = new Map();
      for (const it of live) {
        if (it.type === 'line' || it.type === 'ink') { keep.add(it.id); continue; }
        keep.add(it.id);
        let e = this.els.get(it.id);
        const s = it.type === 'board' ? this.sums[it.boardId] || {} : {};
        const sig = [it.updatedAt, it.locked, it.collapsed, it.type === 'board' ? [s.title, s.color, s.itemCount] : '', it.image && it.image.editedAt, (it.comments || []).length].join('|');
        if (!e || (e._sig !== sig && this.editing !== it.id)) {
          const fresh = this._card(it);
          fresh._sig = sig;
          if (e) e.replaceWith(fresh); else this.layer.append(fresh);
          this.els.set(it.id, fresh); e = fresh;
        }
        e._item = it;
        if (this._inCol(it)) {
          if (!kids.has(it.col)) kids.set(it.col, []);
          kids.get(it.col).push(it);
          continue;
        }
        if (e.classList.contains('yb-dragging')) continue;
        e.classList.remove('yb-incol');
        if (e.parentElement !== this.layer) this.layer.append(e);
        e.style.left = it.x + 'px'; e.style.top = it.y + 'px';
        e.style.width = (it.w || YVN.CARD_W[it.type] || 240) + 'px';
      }
      // cards stacked inside columns, in column order
      for (const cid of this._colIds) {
        const ce = this.els.get(cid);
        const body = ce && ce.querySelector('.yb-colbody');
        if (!body) continue;
        const list = (kids.get(cid) || []).sort((a, b) => (a.ord ?? 1e9) - (b.ord ?? 1e9) || (a.createdAt || 0) - (b.createdAt || 0));
        for (const k of list) {
          const e = this.els.get(k.id);
          if (!e || e.classList.contains('yb-dragging')) continue;
          e.classList.add('yb-incol');
          e.style.left = ''; e.style.top = ''; e.style.width = '';
          body.appendChild(e);
        }
        body.classList.toggle('yb-colempty', !list.length);
        const cnt = ce.querySelector('.yb-colcount');
        if (cnt) cnt.textContent = `${list.length} ${list.length === 1 ? 'card' : 'cards'}`;
      }
      for (const [id, e] of this.els) if (!keep.has(id)) { e.remove(); this.els.delete(id); this.sel.delete(id); }
      for (const id of [...this.sel]) if (!keep.has(id)) this.sel.delete(id);
      this._paintSel();
      const msg = this.boardId === HOME
        ? 'This is Home. Click "Board" to create your first board, e.g. "DaVinci Color Grading".'
        : this.o.capture ? 'Click "Capture" to add the current video frame to this board, or "Summary" to write about the whole video.' : 'Double-click empty space to add a note, or add cards and boards from the toolbar.';
      this.empty.textContent = msg;
      this.empty.hidden = live.length > 0;
    }
    _paintSel() {
      for (const [id, e] of this.els) e.classList.toggle('yb-sel', this.sel.has(id));
      this._renderLines();
    }

    _card(it) {
      const c = el('div', { class: `yb-item yb-${it.type}`, dataset: { id: it.id } });
      if (it.color && it.type !== 'board') c.append(el('div', { class: 'yb-cbar', style: `background:${it.color}` }));
      if (it.type === 'note') {
        if (it.video) c.append(el('button', { class: 'yb-src', dataset: { act: 'video' }, title: 'Back to video: ' + it.video.title }, icon('play', 12), el('b', {}, 'Summary'), el('span', {}, it.video.title || '')));
        c.append(this._md(it.text, 'Double-click to type…'));
      } else if (it.type === 'shot' || it.type === 'image') {
        const img = el('img', { alt: it.text ? it.text.slice(0, 60) : 'Capture', draggable: 'false' });
        const wrap = el('div', { class: 'yb-imgwrap', style: it.image && it.image.w ? `aspect-ratio:${it.image.w}/${it.image.h}` : '' }, img);
        if (it.image && it.image.edits) wrap.append(el('span', { class: 'yb-edited', title: 'Annotated / cropped' }, '✎'));
        c.append(wrap);
        this._loadImg(it, img);
        // timestamp row, then the caption as a full-width block below it
        if (it.type === 'shot') {
          const foot = el('div', { class: 'yb-foot' });
          if (it.ts != null) foot.append(el('button', { class: 'yb-ts', dataset: { act: 'seek' }, title: it.video ? `Jump to this moment in ${it.video.title}` : 'Jump to this moment' }, YVN.fmtTime(it.ts)));
          if (!it.text) foot.append(el('span', { class: 'yb-ph yb-capph' }, 'Double-click to add a caption'));
          c.append(foot);
        }
        if (it.text) c.append(el('div', { class: 'yb-cap' }, this._md(it.text)));
      } else if (it.type === 'board') {
        const s = this.sums[it.boardId] || {};
        c.append(el('div', { class: 'yb-bicon', style: `background:${s.color || '#8b8d98'}` }, el('i'), el('i'), el('i'), el('i')),
          el('div', { class: 'yb-btitle' }, s.title || (s.id ? 'Untitled' : 'Syncing…')),
          el('div', { class: 'yb-bcount' }, s.itemCount != null ? `${s.itemCount} ${s.itemCount === 1 ? 'card' : 'cards'}` : ''));
      } else if (it.type === 'column') {
        if (it.collapsed) c.classList.add('yb-colcollapsed');
        c.append(el('button', { class: 'yb-colfold', dataset: { act: 'fold' }, title: it.collapsed ? 'Expand column' : 'Collapse column', 'aria-label': it.collapsed ? 'Expand column' : 'Collapse column' }, it.collapsed ? '+' : '−'));
        c.append(el('div', { class: 'yb-colhead', title: 'Double-click to rename; drag here to move the column' },
          el('span', { class: 'yb-coltitle' + (it.title ? '' : ' yb-ph') }, it.title || 'Untitled column'),
          el('small', { class: 'yb-colcount' }, '')),
        el('div', { class: 'yb-colbody' }));
      } else if (it.type === 'heading') {
        c.append(el('div', { class: 'yb-htext' + (it.text ? '' : ' yb-ph') }, it.text || 'Heading'));
      } else if (it.type === 'table') {
        c.append(this._tableEl(it.rows, false));
      } else if (it.type === 'sketch') {
        c.append(this._sketchSvg(it));
        if (!(it.strokes || []).length) c.append(el('div', { class: 'yb-skph yb-ph' }, 'Double-click to start drawing'));
      } else if (it.type === 'video') {
        const vid = ytId(it.url), vimeo = /vimeo\.com\/(?:video\/)?(\d+)/.exec(it.url || '');
        const wrap = el('div', { class: 'yb-imgwrap yb-vwrap', dataset: { act: 'play' } });
        if (it.file) wrap.append(el('div', { class: 'yb-vfile' }, icon('video', 34), el('span', {}, it.file.name)));
        else if (vid) wrap.append(el('img', { src: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`, alt: '', draggable: 'false' }));
        else wrap.append(el('div', { class: 'yb-vfile' }, icon('video', 34), el('span', {}, vimeo ? 'Vimeo' : it.url ? host(it.url) : 'Double-click to paste a video link')));
        if (it.url || it.file) wrap.append(el('span', { class: 'yb-playbadge' }, icon('play', 18)));
        c.append(wrap, el('div', { class: 'yb-linkbody' }, el('div', { class: 'yb-linktxt' }, el('b', {}, it.title || (it.file ? it.file.name : it.url ? host(it.url) : 'Video')), el('small', {}, it.file ? YVN.fmtSize(it.file.size) : host(it.url || '')))));
      } else if (it.type === 'map') {
        c.append(el('div', { class: 'yb-imgwrap yb-mapwrap', dataset: { act: 'play' } },
          el('div', { class: 'yb-vfile' }, icon('map', 34), el('span', {}, it.query ? 'Click to load the map' : 'Double-click to enter a place'))),
        el('div', { class: 'yb-linkbody' }, el('span', { class: 'yb-linkic' }, icon('map', 18)),
          el('div', { class: 'yb-linktxt' }, el('b', {}, it.query || 'No place set'), it.query && el('a', { href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(it.query)}`, target: '_blank', rel: 'noopener noreferrer', dataset: { act: 'open' } }, 'Open in Google Maps'))));
      } else if (it.type === 'audio') {
        const au = el('audio', { controls: true, preload: 'none' });
        this._loadMedia(it, au);
        c.append(el('div', { class: 'yb-audio' }, el('div', { class: 'yb-ahead' }, el('span', { class: 'yb-aic' }, icon('audio', 20)), el('div', { class: 'yb-linktxt' }, el('b', {}, it.file ? it.file.name : 'Audio'), el('small', {}, it.file ? YVN.fmtSize(it.file.size) : ''))), au));
      } else if (it.type === 'file') {
        c.append(el('div', { class: 'yb-linkbody' }, el('span', { class: 'yb-linkic yb-fileic' }, icon('file', 20)),
          el('div', { class: 'yb-linktxt' }, el('b', {}, it.file ? it.file.name : 'File'), el('small', {}, it.file ? `${YVN.fmtSize(it.file.size)} · double-click to open` : ''))));
      } else if (it.type === 'doc') {
        const plain = YVN.plainText(it.text || '').replace(/\s+/g, ' ').trim();
        c.append(el('div', { class: 'yb-docic' }, icon('doc', 26)),
          el('div', { class: 'yb-doctitle' + (it.title ? '' : ' yb-ph') }, it.title || 'Untitled document'),
          el('div', { class: 'yb-docprev' }, plain ? plain.slice(0, 120) + (plain.length > 120 ? '…' : '') : 'Double-click to open'));
      } else if (it.type === 'comment') {
        const thread = el('div', { class: 'yb-thread' });
        for (const cm of it.comments || []) thread.append(this._commentLine(cm));
        c.append(thread, el('div', { class: 'yb-cform' }, el('button', { class: 'yb-replybtn', dataset: { act: 'creply' } }, (it.comments || []).length ? 'Reply' : 'Write a comment…')));
      } else if (it.type === 'color') {
        c.append(el('div', { class: 'yb-swatch', style: `background:${it.hex || '#8b8d98'}` }),
          el('div', { class: 'yb-swfoot' },
            el('b', { class: it.name ? '' : 'yb-ph' }, it.name || 'Untitled color'),
            el('button', { class: 'yb-hex', dataset: { act: 'copyhex' }, title: 'Copy hex code' }, (it.hex || '').toUpperCase())));
      } else if (it.type === 'link') {
        const vid = ytId(it.url);
        if (vid) c.append(el('div', { class: 'yb-imgwrap yb-yt', title: 'Double-click to open the video' }, el('img', { src: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`, alt: '', draggable: 'false' }), el('span', { class: 'yb-playbadge' }, icon('play', 18))));
        c.append(el('div', { class: 'yb-linkbody' },
          !vid && el('span', { class: 'yb-linkic' }, icon('link', 18)),
          el('div', { class: 'yb-linktxt' }, el('a', { href: it.url || '#', target: '_blank', rel: 'noopener noreferrer', dataset: { act: 'open' } }, it.title || it.url || '(empty link)'), el('small', {}, host(it.url)))));
      }
      const nc = it.type === 'comment' ? 0 : (it.comments || []).length;
      if (nc) c.append(el('button', { class: 'yb-cbadge', title: `${nc} ${nc === 1 ? 'comment' : 'comments'}`, dataset: { act: 'comments' } }, icon('comment', 13), String(nc)));
      if (it.locked) { c.classList.add('yb-locked'); c.append(el('span', { class: 'yb-lockbadge', title: 'Position locked' }, icon('lock', 12))); }
      if (it.type !== 'board') c.append(el('div', { class: 'yb-rs', title: 'Drag to resize' }));
      return c;
    }
    _md(text, ph) {
      if (!text) return el('div', { class: 'yb-md yb-ph' }, ph || '');
      return el('div', { class: 'yb-md yvn-md', html: YVN.renderMarkdown(text) });
    }
    async _loadImg(it, img) {
      if (!it.image) return;
      const key = `${it.image.id}:${it.image.edits ? it.image.editedAt || 1 : 'o'}`;
      let url = this.imgCache.get(key);
      if (!url) {
        try { url = await this.api.getImage(this.boardId, it); } catch (e) { url = null; }
        if (url) this.imgCache.set(key, url);
      }
      if (url) img.src = url; else img.alt = 'Image not synced yet';
    }

    // ---------- interactions ----------
    _bind() {
      const vp = this.vp;
      vp.addEventListener('pointerdown', (e) => this._down(e));
      vp.addEventListener('dblclick', (e) => this._dbl(e));
      vp.addEventListener('input', () => this._renderLines());
      vp.addEventListener('click', (e) => this._click(e));
      vp.addEventListener('contextmenu', (e) => {
        const ink = e.target.closest('.yb-inkg');
        if (ink) {
          e.preventDefault(); this.sel = new Set([ink.dataset.id]); this._paintSel();
          const id = ink.dataset.id;
          return this._menuAt({ x: e.clientX, y: e.clientY }, [
            { colors: ['#f1f1f3', '#1d1d1f', ...YVN.BOARD_COLORS], pick: async (c) => { await this.m.patchItems(this.boardId, [{ id, color: c || '#8b8d98' }]); this.reload(); } },
            { sep: true }, { label: 'Delete drawing', danger: true, run: async () => { await this.m.deleteItems(this.boardId, [id]); this.reload(); } }]);
        }
        const ln = e.target.closest('.yb-line, .yb-llabel');
        if (ln) { e.preventDefault(); this.sel = new Set([ln.dataset.id]); this._paintSel(); return this._lineMenu(ln.dataset.id, { x: e.clientX, y: e.clientY }); }
        const c = e.target.closest('.yb-item');
        if (!c || e.target.closest('textarea,input')) return;
        e.preventDefault();
        if (!this.sel.has(c.dataset.id)) { this.sel = new Set([c.dataset.id]); this._paintSel(); }
        this._itemMenu(c.dataset.id, { x: e.clientX, y: e.clientY });
      });
      vp.addEventListener('wheel', (e) => {
        if (e.target.closest('textarea')) return;
        e.preventDefault();
        const r = vp.getBoundingClientRect();
        if (e.ctrlKey || e.metaKey) this.zoomBy(Math.exp(-e.deltaY * 0.0025), e.clientX - r.left, e.clientY - r.top);
        else {
          const k = e.deltaMode === 1 ? 16 : 1;
          this.view.x -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k;
          if (!e.shiftKey) this.view.y -= e.deltaY * k;
          this._applyView(); this._saveView();
        }
      }, { passive: false });
      vp.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
      vp.addEventListener('drop', (e) => {
        const files = [...(e.dataTransfer.files || [])];
        if (!files.length) return;
        e.preventDefault();
        this._addFiles(files, this._toBoard(e.clientX, e.clientY), 'auto');
      });
      this.root.addEventListener('paste', (e) => {
        if (this.editing || e.target.closest('input,textarea')) return;
        const files = [...(e.clipboardData.files || [])].filter((f) => /^image\//.test(f.type));
        if (files.length) { e.preventDefault(); this._addFiles(files); return; }
        const t = e.clipboardData.getData('text/plain').trim();
        if (/^https?:\/\/\S+$/.test(t)) { e.preventDefault(); this._addLink(t); }
        else if (t) { e.preventDefault(); this._addNote({ text: t, edit: false }); }
      });
      this.root.addEventListener('keydown', (e) => this._key(e));
      // no browser auto-scroll on middle click; middle drag pans the board instead
      vp.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
      vp.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
      // hold Space + left drag to pan (not in the YouTube panel, where Space plays/pauses the video)
      if (this.mode !== 'panel') {
        const typing = (t) => t && t.closest && t.closest('input, textarea, [contenteditable="true"]');
        window.addEventListener('keydown', (e) => {
          if (e.code !== 'Space' || e.repeat || typing(e.target) || !this.root.isConnected || document.querySelector('.yvne-root')) return;
          e.preventDefault();
          this._space = true; this.vp.classList.add('yb-spacepan');
        });
        window.addEventListener('keyup', (e) => { if (e.code === 'Space') { this._space = false; this.vp.classList.remove('yb-spacepan'); } });
        window.addEventListener('blur', () => { this._space = false; this.vp.classList.remove('yb-spacepan'); });
      }
      document.addEventListener('pointerdown', (e) => {
        if (!this.menu.hidden && !this.menu.contains(e.target)) this._closeMenu();
        if (this.flyout && !this.flyout.hidden && !this.flyout.contains(e.target) && !(e.target.closest && e.target.closest('.yb-moretool'))) this.flyout.hidden = true;
        if (!this.cpop.hidden && !this.cpop.contains(e.target) && !(e.target.closest && e.target.closest('.yvn-cmt, .yb-cbadge'))) {
          const cp = this._cp;
          this._closeCpop();
          // a new comment that was never written: drop its highlight
          if (cp && cp.isNew && cp.anchor && cp.anchor.isConnected && this._edit && !this._edit.comments.has(cp.cid)) YVN.unwrapEl(cp.anchor);
        }
      }, true);
    }

    _down(e) {
      if (e.button !== 0 && e.button !== 1) return;
      const t = e.target;
      if (t.closest('textarea, input, .yb-editbox, .yb-rt')) return;
      if (!this.menu.hidden) this._closeMenu();
      const card = t.closest('.yb-item');
      if (this.editing && (!card || card.dataset.id !== this.editing)) this.commitEdit();
      const start = { x: e.clientX, y: e.clientY };
      if (e.button === 1 || (e.button === 0 && this._space)) {
        e.preventDefault();
        this.gesture = { kind: 'pan', start, vx: this.view.x, vy: this.view.y, moved: false };
        this.vp.classList.add('yb-panning');
      } else if (e.button === 0 && this._draw) {
        e.preventDefault();
        const p0 = this._toBoard(e.clientX, e.clientY);
        this.gesture = this._draw.erase ? { kind: 'erase', start, gone: new Set() } : { kind: 'ink', start, pts: [[Math.round(p0.x), Math.round(p0.y)]] };
      } else if (e.button === 0 && this._lineMode) {
        e.preventDefault();
        this.gesture = { kind: 'line-new', start, from: this._pendingFrom || this._endAt(e, null) };
        this._pendingFrom = null;
      } else if (e.button === 0 && t.closest('.yb-hnd')) {
        const h = t.closest('.yb-hnd');
        this.gesture = { kind: 'line-end', start, id: h.dataset.line, end: h.dataset.end };
      } else if (t.closest('.yb-line, .yb-llabel, .yb-inkg')) {
        const id = t.closest('.yb-line, .yb-llabel, .yb-inkg').dataset.id;
        if (e.shiftKey || e.ctrlKey || e.metaKey) { this.sel.has(id) ? this.sel.delete(id) : this.sel.add(id); } else this.sel = new Set([id]);
        this._paintSel();
        return;
      }
      if (this.gesture && /^(line|pan|ink|erase)/.test(this.gesture.kind)) { /* handled by the window listeners below */ }
      else if (t.closest('[data-act], a, .yb-md input')) return;
      else if (card && e.button === 0) {
        const id = card.dataset.id;
        const cit = this.board.items.find((i) => i.id === id);
        if (t.classList.contains('yb-rs') && !(cit && cit.locked)) {
          this.gesture = { kind: 'resize', id, start, w: card.offsetWidth / 1, el: card };
        } else {
          if (e.shiftKey || e.ctrlKey || e.metaKey) { this.sel.has(id) ? this.sel.delete(id) : this.sel.add(id); }
          else if (!this.sel.has(id)) this.sel = new Set([id]);
          this._paintSel();
          const orig = new Map(), lines = [];
          for (const sid of this.sel) {
            const it = this.board.items.find((i) => i.id === sid);
            if (!it || it.deleted) continue;
            if (it.type === 'line') { lines.push(it); continue; }
            if (it.locked || it.type === 'ink') continue;
            const ce = this.els.get(sid);
            const inCol = this._inCol(it) && ce && ce.isConnected;
            const r = inCol ? this._layerRect(ce) : { x: it.x, y: it.y };
            orig.set(sid, { x: r.x, y: r.y, inCol, w: ce ? ce.offsetWidth : 0 });
          }
          // a card inside a selected column moves with the column
          for (const [sid] of orig) { const it = this.board.items.find((i) => i.id === sid); if (it && it.col && orig.has(it.col)) orig.delete(sid); }
          this.gesture = { kind: 'drag', id, start, orig, lines, moved: false, dup: e.altKey, ghosts: new Map() };
        }
      } else if (e.button === 0) {
        // empty canvas: drag = rectangle selection (Shift/Ctrl adds to the current selection)
        if (!(e.shiftKey || e.ctrlKey || e.metaKey)) { this.sel.clear(); this._paintSel(); }
        this.gesture = { kind: 'marquee', start, base: new Set(this.sel) };
      }
      // track on window (not pointer capture) so click/dblclick keep their natural targets
      const mv = (ev) => this._move(ev);
      const up = (ev) => {
        window.removeEventListener('pointermove', mv);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        this._up(ev);
      };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    }

    _move(e) {
      const gst = this.gesture;
      if (!gst) return;
      const dx = e.clientX - gst.start.x, dy = e.clientY - gst.start.y;
      if (gst.kind === 'pan') {
        if (Math.abs(dx) + Math.abs(dy) > 3) gst.moved = true;
        this.view.x = gst.vx + dx; this.view.y = gst.vy + dy; this._applyView();
      } else if (gst.kind === 'ink') {
        const q = this._toBoard(e.clientX, e.clientY), last = gst.pts[gst.pts.length - 1];
        if (Math.hypot(q.x - last[0], q.y - last[1]) >= 2 / this.view.z) { gst.pts.push([Math.round(q.x), Math.round(q.y)]); this._renderLines(); }
      } else if (gst.kind === 'erase') {
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const g = hit && hit.closest && hit.closest('.yb-inkg');
        if (g && !gst.gone.has(g.dataset.id)) { gst.gone.add(g.dataset.id); g.style.display = 'none'; }
      } else if (gst.kind === 'line-new' || gst.kind === 'line-end') {
        gst.pt = this._toBoard(e.clientX, e.clientY);
        gst.moved = gst.moved || Math.abs(dx) + Math.abs(dy) > 4;
        this._renderLines();
      } else if (gst.kind === 'drag') {
        if (!gst.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
        if (!gst.orig.size) return;
        if (!gst.moved) {
          gst.moved = true;
          for (const [id, o] of gst.orig) {
            let c = this.els.get(id);
            if (!c) continue;
            if (gst.dup) { // Alt+drag: move a copy, leave the original where it is
              c = c.cloneNode(true);
              c.classList.remove('yb-sel', 'yb-incol');
              c.style.left = o.x + 'px'; c.style.top = o.y + 'px';
              gst.ghosts.set(id, c);
            }
            if (o.inCol) { c.classList.remove('yb-incol'); c.style.width = o.w + 'px'; }
            c.classList.add('yb-dragging'); this.layer.append(c);
          }
        }
        for (const [id, o] of gst.orig) { const c = gst.dup ? gst.ghosts.get(id) : this.els.get(id); if (c) { c.style.left = o.x + dx / this.view.z + 'px'; c.style.top = o.y + dy / this.view.z + 'px'; } }
        if (gst.dup) { this._edgePan(e); return; }
        const under = document.elementFromPoint(e.clientX, e.clientY);
        const target = under && under.closest('.yb-board');
        const tid = target && !gst.orig.has(target.dataset.id) ? target : null;
        if (gst.drop !== tid) { if (gst.drop) gst.drop.classList.remove('yb-drop'); if (tid) tid.classList.add('yb-drop'); gst.drop = tid; }
        // drop into a column (columns cannot be nested)
        const draggingColumn = [...gst.orig.keys()].some((id) => (this.board.items.find((i) => i.id === id) || {}).type === 'column');
        const col = !tid && !draggingColumn && under ? under.closest('.yb-column') : null;
        this._colDropAt(gst, col && !gst.orig.has(col.dataset.id) ? col : null, e.clientY);
        this._edgePan(e);
        this._renderLines();
      } else if (gst.kind === 'resize') {
        gst.el.style.width = clamp(gst.w + dx / this.view.z, 120, 900) + 'px';
        this._renderLines();
      } else if (gst.kind === 'marquee') {
        const r = this.vp.getBoundingClientRect();
        const x1 = Math.min(gst.start.x, e.clientX), y1 = Math.min(gst.start.y, e.clientY);
        Object.assign(this.marquee.style, { left: x1 - r.left + 'px', top: y1 - r.top + 'px', width: Math.abs(dx) + 'px', height: Math.abs(dy) + 'px' });
        this.marquee.hidden = false;
        const a = this._toBoard(x1, y1), b = this._toBoard(Math.max(gst.start.x, e.clientX), Math.max(gst.start.y, e.clientY));
        this.sel = new Set(gst.base);
        for (const it of this._cards()) {
          const q = this._rectOf(it);
          if (q.x < b.x && q.x + q.w > a.x && q.y < b.y && q.y + q.h > a.y) this.sel.add(it.id);
        }
        this._paintSel();
      }
    }
    _edgePan(e) {
      const r = this.vp.getBoundingClientRect(), m = 28;
      const sx = e.clientX < r.left + m ? 8 : e.clientX > r.right - m ? -8 : 0;
      const sy = e.clientY < r.top + m ? 8 : e.clientY > r.bottom - m ? -8 : 0;
      if (!sx && !sy) return;
      const gst = this.gesture;
      this.view.x += sx; this.view.y += sy; gst.start.x += sx; gst.start.y += sy;
      this._applyView();
    }

    async _up(e) {
      const gst = this.gesture;
      this.gesture = null;
      this.vp.classList.remove('yb-panning');
      if (!gst) return;
      if (gst.kind === 'pan') { if (gst.moved) this._saveView(); return; }
      if (gst.kind === 'marquee') { this.marquee.hidden = true; return; }
      if (gst.kind === 'ink') {
        if (gst.pts.length < 2) { this._renderLines(); return; }
        await this.m.putItem(this.boardId, { type: 'ink', pts: gst.pts, color: this._draw.color, size: this._draw.size });
        return this.reload();
      }
      if (gst.kind === 'erase') {
        if (gst.gone.size) { await this.m.deleteItems(this.boardId, [...gst.gone]); return this.reload(); }
        return;
      }
      if (gst.kind === 'line-new') {
        this._lineMode = false; this.vp.classList.remove('yb-linemode');
        const to = this._endAt(e, gst.from.id);
        const far = Math.hypot(to.x - gst.from.x, to.y - gst.from.y) > 12;
        if ((!gst.from.id && !to.id && !far) || (gst.from.id && to.id === gst.from.id) || (!far && !to.id)) { this._renderLines(); return; }
        const it = await this.m.putItem(this.boardId, { type: 'line', from: gst.from, to, arrow: 'end', color: null, label: '' });
        await this.reload();
        this.sel = new Set([it.id]); this._paintSel();
        return;
      }
      if (gst.kind === 'line-end') {
        const ln = this.board.items.find((i) => i.id === gst.id);
        if (!gst.moved || !ln) { this._renderLines(); return; }
        const other = gst.end === 'from' ? ln.to : ln.from;
        const pt = this._endAt(e, other && other.id);
        await this.m.patchItems(this.boardId, [{ id: gst.id, [gst.end]: pt }]);
        return this.reload();
      }
      if (gst.kind === 'resize') {
        const w = Math.round(parseFloat(gst.el.style.width));
        await this.m.patchItems(this.boardId, [{ id: gst.id, w }]);
        return this.reload();
      }
      if (gst.kind === 'drag') {
        const ids = [...gst.orig.keys()];
        if (gst.dup && gst.moved) {
          const positions = {};
          for (const [id, g] of gst.ghosts) { positions[id] = { x: snap(parseFloat(g.style.left)), y: snap(parseFloat(g.style.top)) }; g.remove(); }
          return this._duplicate(ids, positions);
        }
        for (const id of ids) { const c = this.els.get(id); if (c) c.classList.remove('yb-dragging'); }
        if (!gst.moved) {
          const it = this.board.items.find((i) => i.id === gst.id);
          return; // boards open on double-click
        }
        const colDrop = gst.colDrop;
        this._colDropAt(gst, null);
        if (gst.drop) {
          const targetId = gst.drop.dataset.id;
          gst.drop.classList.remove('yb-drop');
          const tItem = this.board.items.find((i) => i.id === targetId);
          await this._moveInto(ids, tItem.boardId);
          return;
        }
        if (colDrop) {
          // new order inside the column: existing cards with the dragged ones inserted at the drop index
          const cid = colDrop.col.dataset.id;
          const existing = YVN.liveItems(this.board).filter((i) => i.col === cid && !gst.orig.has(i.id))
            .sort((a, b) => (a.ord ?? 1e9) - (b.ord ?? 1e9) || (a.createdAt || 0) - (b.createdAt || 0)).map((i) => i.id);
          const dragged = ids.slice().sort((a, b) => gst.orig.get(a).y - gst.orig.get(b).y);
          existing.splice(colDrop.index, 0, ...dragged);
          await this.m.patchItems(this.boardId, existing.map((id, i) => ({ id, col: cid, ord: i })));
          return this.reload();
        }
        const ddx = (e.clientX - gst.start.x) / this.view.z, ddy = (e.clientY - gst.start.y) / this.view.z;
        const patches = ids.map((id) => {
          const c = this.els.get(id), o = gst.orig.get(id);
          const pch = { id, x: snap(parseFloat(c.style.left)), y: snap(parseFloat(c.style.top)) };
          if (o.inCol) pch.col = null;
          return pch;
        });
        // free (unattached) line ends that were selected move along
        for (const ln of gst.lines || []) {
          const pch = { id: ln.id };
          if (ln.from && !ln.from.id) pch.from = { x: ln.from.x + ddx, y: ln.from.y + ddy };
          if (ln.to && !ln.to.id) pch.to = { x: ln.to.x + ddx, y: ln.to.y + ddy };
          if (pch.from || pch.to) patches.push(pch);
        }
        await this.m.patchItems(this.boardId, patches);
        return this.reload();
      }
    }

    async _moveInto(ids, targetBoardId) {
      const target = await this.api.getBoard(targetBoardId);
      const items = target ? YVN.liveItems(target).slice() : [];
      const positions = {};
      let after = items.filter((i) => i.type !== 'line' && !i.col).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).pop();
      const all = new Set(ids);
      for (const id of ids) {
        const it = this.board.items.find((i) => i.id === id);
        if (it && it.type === 'column') for (const k of YVN.liveItems(this.board)) if (k.col === id) all.add(k.id);
      }
      ids = [...all].filter((id) => (this.board.items.find((i) => i.id === id) || {}).type !== 'line');
      for (const id of ids) {
        const it = this.board.items.find((i) => i.id === id);
        if (!it) continue;
        if (it.col && all.has(it.col)) { positions[id] = { x: it.x, y: it.y }; continue; }
        const s = this._rectOf(it);
        const p = YVN.findSlot(items, s.w, s.h, { after, maxW: 1000 });
        positions[id] = { ...p, col: null };
        const placed = { ...it, ...p };
        items.push(placed); after = placed;
      }
      await this.m.moveItems(this.boardId, targetBoardId, ids, positions);
      this.sel.clear();
      this.toast(`Moved to "${this._title(targetBoardId)}"`);
      return this.reload();
    }

    _click(e) {
      const t = e.target;
      const card = t.closest('.yb-item');
      if (card && card.classList.contains('yb-editing')) {
        if (t.closest('a')) e.preventDefault();
        const cm = t.closest('.yb-rt .yvn-cmt');
        if (cm && this._edit && this._edit.ed) this._commentPop({ itemId: card.dataset.id, cid: cm.dataset.c, anchor: cm, editing: true });
        return;
      }
      const cmt = t.closest('.yvn-cmt');
      if (cmt && card) return this._commentPop({ itemId: card.dataset.id, cid: cmt.dataset.c, anchor: cmt, editing: false });
      const box = t.closest('.yb-md input[type=checkbox]');
      if (box && card) { e.preventDefault(); return this._toggleTask(card.dataset.id, +box.dataset.task); }
      const a = t.closest('a');
      if (a && card) {
        if (a.classList.contains('yvn-ts')) { e.preventDefault(); const it = card._item; return this._seek(it && it.video, +a.dataset.ts); }
        if (a.classList.contains('yvn-tag')) { e.preventDefault(); return this.toggleSearch(true, '#' + a.dataset.tag); }
        if (a.classList.contains('yvn-wikilink')) { e.preventDefault(); return this._wikilink(a.dataset.wikilink); }
        if (a.dataset.act === 'open') return; // real link
      }
      const act = t.closest('[data-act]');
      if (!act || !card) return;
      const it = card._item;
      switch (act.dataset.act) {
        case 'seek': return this._seek(it.video, it.ts);
        case 'video': return this._seek(it.video, 0);
        case 'creply': return this.startEdit(it.id, { mode: 'reply' });
        case 'fold': return this.m.patchItems(this.boardId, [{ id: it.id, collapsed: !it.collapsed }]).then(() => this.reload());
        case 'play': return this._play(it, card);
        case 'download': return this._openFile(it);
        case 'cedit': return this.startEdit(it.id, { mode: 'edit', cid: act.dataset.c });
        case 'copyhex': {
          const hex = (it.hex || '').toUpperCase();
          if (navigator.clipboard) navigator.clipboard.writeText(hex).then(() => this.toast('Copied ' + hex), () => this.toast(hex));
          return;
        }
        case 'comments': {
          const first = (it.comments || [])[0];
          if (!first) return;
          const span = card.querySelector(`.yvn-cmt[data-c="${first.id}"]`);
          return this._commentPop({ itemId: it.id, cid: first.id, anchor: span || act, editing: false });
        }
        case 'open': e.preventDefault(); return window.open(it.url, '_blank', 'noopener');
        case 'menu': {
          if (!this.sel.has(it.id)) { this.sel = new Set([it.id]); this._paintSel(); }
          return this._itemMenu(it.id, act);
        }
      }
    }
    _seek(video, ts) {
      if (ts == null) return;
      if (this.o.seek) this.o.seek(video || null, ts);
      else if (video) window.open(`https://www.youtube.com/watch?v=${video.id}&t=${Math.floor(ts)}s`, '_blank', 'noopener');
    }
    _wikilink(text) {
      const t = String(text || '').trim().toLowerCase();
      const hit = Object.values(this.sums).find((s) => !s.deleted && (s.title || '').trim().toLowerCase() === t);
      if (hit) this.open(hit.id); else this.toggleSearch(true, text);
    }
    async _toggleTask(id, n) {
      const it = this.board.items.find((i) => i.id === id);
      if (!it) return;
      await this.m.putItem(this.boardId, { id, text: YVN.toggleTask(it.text, n) });
      this.reload();
    }

    _dbl(e) {
      const t = e.target;
      if (t.closest('textarea, input, [data-act], .yb-rt')) return;
      const lineEl = t.closest('.yb-line, .yb-llabel');
      if (lineEl) return this._editLineLabel(lineEl.dataset.id);
      if (t.closest('.yb-colhead')) return this._renameColumn(t.closest('.yb-item')._item);
      const card = t.closest('.yb-item');
      if (card && card._item && card._item.type === 'column') return;
      if (!card) {
        const p = this._toBoard(e.clientX, e.clientY);
        return this._addNote({ x: snap(p.x - 20), y: snap(p.y - 20) });
      }
      const it = card._item;
      if (it.type === 'board') return this.open(it.boardId);
      if (it.type === 'note') return this.startEdit(it.id);
      if (it.type === 'shot' || it.type === 'image') {
        if (t.closest('.yb-imgwrap')) return this.openEditor(it.id);
        return this.startEdit(it.id);
      }
      if (it.type === 'link') return t.closest('.yb-yt') ? window.open(it.url, '_blank', 'noopener') : this.startEdit(it.id);
      if (it.type === 'color') return this.startEdit(it.id);
      if (it.type === 'comment') return this.startEdit(it.id, { mode: 'reply' });
      if (['heading', 'table', 'sketch', 'video', 'map', 'doc'].includes(it.type)) return this.startEdit(it.id);
      if (it.type === 'file') return this._openFile(it);
    }

    _key(e) {
      if (e.target.closest('textarea, input')) return;
      if (e.key === 'Escape' && this._draw) { this.setDraw(false); return; }
      if (e.key === 'Escape' && this._lineMode) { this._lineMode = false; this.vp.classList.remove('yb-linemode'); return; }
      if (e.key === 'Escape') { this._closeMenu(); this._closeCpop(); this.trashBox.hidden = true; this.toggleSearch(false); this.sel.clear(); this._paintSel(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel.size) { e.preventDefault(); this.deleteSelected(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); this.sel = new Set(YVN.liveItems(this.board).map((i) => i.id)); this._paintSel(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); this.toggleSearch(true); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }
      if (e.key === 'Enter' && this.sel.size === 1) {
        const it = this.board.items.find((i) => i.id === [...this.sel][0]);
        if (it && it.type === 'board') this.open(it.boardId);
        else if (it) this.startEdit(it.id);
        e.preventDefault();
      }
    }

    async deleteSelected() {
      let ids = [...this.sel];
      if (!ids.length) return;
      const live = YVN.liveItems(this.board);
      const all = new Set(ids);
      for (const id of ids) if ((live.find((i) => i.id === id) || {}).type === 'column') for (const k of live) if (k.col === id) all.add(k.id);
      for (const ln of live) if (ln.type === 'line' && ((ln.from && all.has(ln.from.id)) || (ln.to && all.has(ln.to.id)))) all.add(ln.id);
      ids = [...all];
      const boards = ids.map((id) => this.board.items.find((i) => i.id === id)).filter((i) => i && i.type === 'board');
      if (boards.length && !confirm(`Deleting ${boards.map((b) => '"' + this._title(b.boardId) + '"').join(', ')} also deletes every card inside. Continue?`)) return;
      await this.m.deleteItems(this.boardId, ids);
      this.sel.clear();
      this.reload();
    }

    // ---------- menus ----------
    _menuAt(anchor, entries, above) {
      this.menu.replaceChildren(...entries.map((m) => m.colors
        ? el('div', { class: 'yb-colors' }, ...m.colors.map((c) => el('button', { class: 'yb-swbtn' + (c ? '' : ' yb-nocolor'), title: c || 'No color', 'aria-label': c || 'No color', style: c ? `background:${c}` : '', onclick: () => { this._closeMenu(); m.pick(c); } })))
        : m.sep ? el('hr')
          : el('button', { class: 'yb-mi' + (m.danger ? ' yb-danger' : ''), role: 'menuitem', onclick: () => { this._closeMenu(); m.run(); } }, m.icon ? icon(m.icon, 16) : el('span', { class: 'yb-ic' }), m.label)));
      this.menu.hidden = false;
      const rr = this.root.getBoundingClientRect();
      const a = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
      const mw = this.menu.offsetWidth, mh = this.menu.offsetHeight;
      let x = a.left - rr.left, y = above ? a.top - rr.top - mh - 6 : a.bottom - rr.top + 4;
      x = clamp(x, 6, rr.width - mw - 6); y = clamp(y, 6, rr.height - mh - 6);
      this.menu.style.left = x + 'px'; this.menu.style.top = y + 'px';
    }
    _closeMenu() { this.menu.hidden = true; }

    _itemMenu(id, anchor) {
      const it = this.board.items.find((i) => i.id === id);
      if (!it) return;
      const multi = this.sel.size > 1;
      const ids = [...this.sel];
      const entries = [];
      const sel = ids.map((x) => this.board.items.find((i) => i.id === x)).filter(Boolean);
      const allLocked = sel.length && sel.every((x) => x.locked);
      const lockEntry = { label: allLocked ? 'Unlock Position' : 'Lock Position', icon: allLocked ? 'unlock' : 'lock', run: async () => { await this.m.patchItems(this.boardId, ids.map((x) => ({ id: x, locked: !allLocked }))); this.reload(); } };
      const colorEntry = {
        colors: [null, ...YVN.BOARD_COLORS],
        pick: async (c) => {
          if (!multi && it.type === 'board') await this.api.updateBoard(it.boardId, { color: c || '#8b8d98' });
          else await this.m.patchItems(this.boardId, ids.map((x) => ({ id: x, color: c })));
          this.reload();
        },
      };
      if (!multi && it.type === 'column') {
        // columns: only what's needed (rename by double-clicking the title, delete with the Delete key)
        return this._menuAt(anchor, [lockEntry, { label: 'Draw line from this card', icon: 'line', run: () => this._startLineFrom(it.id) }, colorEntry]);
      }
      if (!multi) {
        if (it.type === 'board') entries.push({ label: 'Open', icon: 'board', run: () => this.open(it.boardId) }, { label: 'Rename', icon: 'note', run: () => this._renameCard(it) });
        if (it.type === 'note' || it.type === 'shot' || it.type === 'image') entries.push({ label: it.type === 'note' ? 'Edit text' : 'Edit caption', icon: 'note', run: () => this.startEdit(it.id) });
        if (it.type === 'shot' || it.type === 'image') entries.push({ label: 'Open annotation editor', icon: 'image', run: () => this.openEditor(it.id) });
        if (it.type === 'shot' && it.ts != null) entries.push({ label: 'Jump to video at ' + YVN.fmtTime(it.ts), icon: 'play', run: () => this._seek(it.video, it.ts) });
        if (it.type === 'link') entries.push({ label: 'Open link', icon: 'link', run: () => window.open(it.url, '_blank', 'noopener') }, { label: 'Edit link', icon: 'note', run: () => this.startEdit(it.id) });
        if (it.type === 'color') entries.push({ label: 'Edit color', icon: 'swatch', run: () => this.startEdit(it.id) });
        if (this._inCol(it)) entries.push({ label: 'Take out of column', icon: 'column', run: async () => {
          const r = this._rectOf(it);
          await this.m.patchItems(this.boardId, [{ id: it.id, col: null, x: snap(r.x + r.w + 40), y: snap(r.y) }]);
          this.reload();
        } });
        if (it.type !== 'line') entries.push({ label: 'Draw line from this card', icon: 'line', run: () => this._startLineFrom(it.id) });
      }
      const boardsHere = YVN.liveItems(this.board).filter((x) => x.type === 'board' && !ids.includes(x.id));
      if (boardsHere.length) entries.push({ label: 'Move to board…', icon: 'board', run: () => this._menuAt(anchor, boardsHere.map((b) => ({ label: this._title(b.boardId), icon: 'board', run: () => this._moveInto(ids, b.boardId) }))) });
      if (this.boardId !== HOME) {
        const parent = (this.sums[this.boardId] || this.board).parentId || HOME;
        entries.push({ label: `Move up to "${this._title(parent)}"`, icon: 'home', run: () => this._moveInto(ids, parent) });
      }
      entries.push({ sep: true }, lockEntry, colorEntry);
      entries.push({ sep: true }, { label: multi ? `Delete ${ids.length} cards` : 'Delete', danger: true, run: () => this.deleteSelected() });
      this._menuAt(anchor, entries);
    }

    // ---------- inline editing ----------
    startEdit(id, opt) {
      const it = this.board.items.find((i) => i.id === id);
      const c = this.els.get(id);
      if (!it || !c) return;
      if (this.editing && this.editing !== id) this.commitEdit();
      this.editing = id;
      c.classList.add('yb-editing');
      if (it.type === 'link') {
        const inp = el('input', { class: 'yb-input', type: 'url', value: it.url || '', placeholder: 'Paste a link, e.g. a YouTube video' });
        const box = el('div', { class: 'yb-editbox' }, inp);
        c.querySelector('.yb-linkbody').replaceWith(box);
        const yt = c.querySelector('.yb-yt'); if (yt) yt.remove();
        this._edit = { it, get: () => inp.value.trim(), field: 'url' };
        inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); this.commitEdit(); } });
        inp.focus();
        return;
      }
      if (it.type === 'heading') {
        const inp = el('input', { class: 'yb-hinput', value: it.text || '', placeholder: 'Heading' });
        inp.value = it.text || '';
        c.querySelector('.yb-htext').replaceWith(inp);
        return this._patchEdit(it, c, inp, () => ({ text: inp.value.trim() }), (v) => !v.text);
      }
      if (it.type === 'video' || it.type === 'map') {
        const isMap = it.type === 'map';
        const inp = el('input', { class: 'yb-input', placeholder: isMap ? 'A place or address, e.g. Taipei 101' : 'Paste a YouTube or Vimeo link' });
        inp.value = isMap ? it.query || '' : it.url || '';
        const box = el('div', { class: 'yb-editbox' }, inp, !isMap && !it.file && el('button', { class: 'yb-btn', style: 'margin-top:6px', onclick: () => { this._edit.cancel = true; this.commitEdit(); this._pickFiles('video/*', 'video', it.id); } }, 'Or upload a video file…'));
        c.querySelector('.yb-linkbody').replaceWith(box);
        return this._patchEdit(it, c, inp, () => (isMap ? { query: inp.value.trim() } : { url: inp.value.trim() }), (v) => (isMap ? !v.query : !v.url && !it.file));
      }
      if (it.type === 'table') {
        const tbl = this._tableEl(it.rows, true);
        const old = c.querySelector('.yb-table');
        old.replaceWith(tbl);
        const read = () => [...tbl.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => td.textContent.replace(/\n/g, ' ').trim()));
        const redo = (rows) => { const n = this._tableEl(rows, true); tbl.replaceWith(n); return n; };
        let cur = tbl;
        const ops = el('div', { class: 'yb-tops' },
          ...[['+ Row', (r) => { r.push(r[0].map(() => '')); }], ['+ Column', (r) => { r.forEach((row) => row.push('')); }], ['− Row', (r) => { if (r.length > 1) r.pop(); }], ['− Column', (r) => { if (r[0].length > 1) r.forEach((row) => row.pop()); }]]
            .map(([label, fn]) => el('button', { class: 'yb-btn', onmousedown: (e) => e.preventDefault(), onclick: () => { const rows = readCur(); fn(rows); cur = redo2(rows); } }, label)),
          el('button', { class: 'yb-btn yb-btn-primary', onclick: () => this.commitEdit() }, 'Done'));
        const readCur = () => [...cur.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => td.textContent.replace(/\n/g, ' ').trim()));
        const redo2 = (rows) => { const n = this._tableEl(rows, true); cur.replaceWith(n); n.querySelector('[contenteditable]').focus(); return n; };
        c.append(ops);
        c.addEventListener('keydown', (e) => { if (this.editing === id) { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); this.commitEdit(); } } });
        void read; void redo;
        this._edit = { it, field: 'patch', get: () => ({ rows: readCur() }), empty: () => false };
        c.addEventListener('focusout', () => setTimeout(() => { if (this.editing === id && !c.contains(document.activeElement)) this.commitEdit(); }, 200));
        const first = cur.querySelector('[contenteditable]'); if (first) first.focus();
        return;
      }
      if (it.type === 'sketch') return this._sketchEdit(it, c);
      if (it.type === 'doc') return this._docEdit(it, c);
      if (it.type === 'comment') {
        const mode = (opt && opt.mode) || 'reply';
        const cur = mode === 'edit' ? (it.comments || []).find((x) => x.id === opt.cid) : null;
        const ta = el('textarea', { class: 'yb-cpop-ta yb-composer', rows: '2', placeholder: mode === 'edit' ? 'Edit comment…' : (it.comments || []).length ? 'Reply…' : 'Write a comment…' });
        ta.value = cur ? cur.text : '';
        const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; this._renderLines(); };
        ta.addEventListener('input', grow);
        const box = el('div', { class: 'yb-cform yb-editbox' }, ta,
          el('div', { class: 'yb-cpop-act' },
            mode === 'edit' && el('button', { class: 'yb-btn yb-danger', onclick: () => { ta.value = ''; this.commitEdit(); } }, 'Delete'),
            el('button', { class: 'yb-btn', onclick: () => { this._edit.cancel = true; this.commitEdit(); } }, 'Cancel'),
            el('button', { class: 'yb-btn yb-btn-primary', onclick: () => this.commitEdit() }, mode === 'edit' ? 'Save' : 'Post')));
        if (cur) {
          const line = c.querySelector(`.yb-cline[data-c="${cur.id}"] .yb-ctext`);
          if (line) line.replaceWith(box); else c.querySelector('.yb-cform').replaceWith(box);
          const f = c.querySelector('.yb-cform:not(.yb-editbox)'); if (f) f.hidden = true;
        } else c.querySelector('.yb-cform').replaceWith(box);
        ta.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Escape') { e.preventDefault(); this._edit.cancel = true; this.commitEdit(); }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.commitEdit(); }
        });
        box.addEventListener('focusout', () => setTimeout(() => { if (this.editing === id && !box.contains(document.activeElement)) this.commitEdit(); }, 200));
        this._edit = { it, get: () => ta.value.trim(), field: 'thread', mode, cid: cur && cur.id };
        grow(); ta.focus();
        return;
      }
      if (it.type === 'color') {
        const pick = el('input', { type: 'color', class: 'yb-swpick', 'aria-label': 'Pick a color' });
        pick.value = /^#[0-9a-f]{6}$/i.test(it.hex || '') ? it.hex : '#8b8d98';
        const hex = el('input', { class: 'yb-input', value: (it.hex || '').toUpperCase(), placeholder: '#RRGGBB', spellcheck: 'false' });
        const name = el('input', { class: 'yb-input', value: it.name || '', placeholder: 'Color name, e.g. skin highlight' });
        const sw = c.querySelector('.yb-swatch');
        pick.addEventListener('input', () => { hex.value = pick.value.toUpperCase(); sw.style.background = pick.value; });
        hex.addEventListener('input', () => { const v = hex.value.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) { const h = v[0] === '#' ? v : '#' + v; pick.value = h; sw.style.background = h; } });
        const box = el('div', { class: 'yb-editbox yb-swedit' }, el('div', { class: 'yb-swrow' }, pick, hex), name);
        c.querySelector('.yb-swfoot').replaceWith(box);
        for (const inp of [hex, name, pick]) inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); this.commitEdit(); } });
        box.addEventListener('focusout', () => setTimeout(() => { if (this.editing === id && !box.contains(document.activeElement)) this.commitEdit(); }, 200));
        this._edit = { it, get: () => ({ hex: pick.value, name: name.value.trim() }), field: 'swatch' };
        name.focus();
        return;
      }
      const comments = new Map((it.comments || []).map((cm) => [cm.id, { ...cm }]));
      const ed = new YVN.RichEditor(it.text || '', {
        placeholder: it.type === 'note' ? (it.video ? 'Key points and takeaways from the whole video…' : 'Start typing… (select text to format it)') : 'Caption…',
        onDone: () => this.commitEdit(),
        onComment: (cid, span, isNew) => this._commentPop({ itemId: id, cid, anchor: span, editing: true, isNew }),
      });
      if (it.type === 'note') c.querySelector('.yb-md').replaceWith(ed.el);
      else {
        ed.el.classList.add('yb-capta');
        const cap = c.querySelector('.yb-cap'), ph = c.querySelector('.yb-capph'), foot = c.querySelector('.yb-foot');
        if (ph) ph.remove();
        if (cap) cap.replaceWith(ed.el); else if (foot) foot.after(ed.el); else c.append(ed.el);
      }
      ed.el.addEventListener('blur', () => setTimeout(() => {
        const ae = document.activeElement;
        if (this.editing !== id || ed.el.contains(ae) || this.fmt.isBusy() || !this.cpop.hidden) return;
        this.commitEdit();
      }, 150));
      this.fmt.attach(ed);
      this._edit = { it, ed, comments, get: () => ed.getMarkdown(), field: 'text' };
      ed.focus();
    }

    async commitEdit() {
      const ed = this._edit;
      const id = this.editing;
      this.editing = null; this._edit = null;
      this.fmt.detach();
      this._closeCpop();
      if (!ed || !id) return;
      const c = this.els.get(id);
      if (c) c.classList.remove('yb-editing');
      const val = ed.get();
      const it = ed.it;
      if (ed.field === 'patch') {
        if (ed.cancel) { /* nothing */ }
        else if (this._fresh === id && ed.empty && ed.empty(val)) await this.m.deleteItems(this.boardId, [id]);
        else {
          const changed = Object.keys(val).some((k) => JSON.stringify(val[k]) !== JSON.stringify(it[k] === undefined ? (typeof val[k] === 'string' ? '' : null) : it[k]));
          if (changed) {
            if (val.url !== undefined && it.type === 'video' && val.url) { const vid = ytId(val.url); if (vid) val.title = await this._linkTitle(val.url); }
            await this.m.putItem(this.boardId, { id, ...val });
          }
        }
        this._fresh = null;
        if (this._docModal) { this.fmt.container = this.root; this.root.append(this.fmt.el); this._docModal.remove(); this._docModal = null; }
        if (c) c._sig = null;
        return this.reload();
      }
      if (ed.field === 'thread') {
        let list = (it.comments || []).map((x) => ({ ...x }));
        if (!ed.cancel) {
          const now = Date.now();
          if (ed.mode === 'edit') {
            list = val ? list.map((x) => (x.id === ed.cid ? { ...x, text: val, updatedAt: now } : x)) : list.filter((x) => x.id !== ed.cid);
          } else if (val) {
            list.push({ id: YVN.uid('c_'), text: val, createdAt: now, updatedAt: now, author: await this._me() });
          }
        }
        if (!list.length) await this.m.deleteItems(this.boardId, [id]); // an empty thread disappears
        else if (JSON.stringify(list) !== JSON.stringify(it.comments || [])) await this.m.putItem(this.boardId, { id, comments: list });
        this._fresh = null;
        if (c) c._sig = null;
        return this.reload();
      }
      if (ed.field === 'swatch') {
        if (val.hex !== it.hex || val.name !== (it.name || '')) await this.m.putItem(this.boardId, { id, hex: val.hex, name: val.name });
        this._fresh = null;
        if (c) c._sig = null;
        return this.reload();
      }
      if (it.type === 'note' && !val.trim() && this._fresh === id) {
        await this.m.deleteItems(this.boardId, [id]);
      } else if (it.type === 'link' && !val) {
        if (this._fresh === id) await this.m.deleteItems(this.boardId, [id]);
      } else if (ed.field === 'url') {
        if (val !== (it.url || '')) {
          const url = /^https?:\/\//.test(val) ? val : 'https://' + val;
          await this.m.putItem(this.boardId, { id, url, title: await this._linkTitle(url) });
        }
      } else {
        const comments = [...ed.comments.values()].filter((cm) => cm.text && val.includes(`{#${cm.id}}`));
        if (val !== (it.text || '') || JSON.stringify(comments) !== JSON.stringify(it.comments || [])) {
          await this.m.putItem(this.boardId, { id, text: val, comments });
        }
      }
      this._fresh = null;
      if (c) c._sig = null; // force re-render of this card
      await this.reload();
    }

    // ---------- comments (anchored to selected text) ----------
    _closeCpop() { this.cpop.hidden = true; this._cp = null; }
    _commentPop(o) {
      const editing = !!(o.editing && this._edit && this._edit.ed);
      const item = editing ? this._edit.it : this.board.items.find((i) => i.id === o.itemId);
      if (!item) return;
      const map = editing ? this._edit.comments : new Map((item.comments || []).map((cm) => [cm.id, { ...cm }]));
      const cm = map.get(o.cid) || { id: o.cid, text: '', createdAt: Date.now() };
      this._cp = o;
      const quote = o.anchor && o.anchor.classList && o.anchor.classList.contains('yvn-cmt') ? o.anchor.textContent : '';
      const close = (refocus) => { this._closeCpop(); if (editing && refocus && this._edit) this._edit.ed.focus(false); };
      const persist = async (nextMap, text) => {
        const patch = { id: item.id, comments: [...nextMap.values()] };
        if (text != null) patch.text = text;
        await this.m.putItem(this.boardId, patch);
        this.reload();
      };
      const unmark = () => {
        if (editing) { if (o.anchor && o.anchor.isConnected && o.anchor.classList.contains('yvn-cmt')) YVN.unwrapEl(o.anchor); return null; }
        return (item.text || '').replace(new RegExp(`\\[([^\\]]+)\\]\\{#${o.cid}\\}`), '$1');
      };
      const showEdit = () => {
        const ta = el('textarea', { class: 'yb-cpop-ta', rows: '3', placeholder: 'Write a comment… (Ctrl+Enter to save)' });
        ta.value = cm.text || '';
        const save = async () => {
          const v = ta.value.trim();
          if (!v) { if (o.isNew) unmark(); close(true); return; }
          map.set(cm.id, { ...cm, text: v, updatedAt: Date.now() });
          close(true);
          if (!editing) await persist(map);
        };
        const cancel = () => { if (o.isNew && !cm.text) unmark(); close(true); };
        ta.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
        });
        this.cpop.replaceChildren(
          ...[quote && el('blockquote', {}, quote), ta,
            el('div', { class: 'yb-cpop-act' }, el('button', { class: 'yb-btn', onclick: cancel }, 'Cancel'), el('button', { class: 'yb-btn yb-btn-primary', onclick: save }, 'Save'))].filter(Boolean));
        this._placePop(o.anchor);
        ta.focus();
      };
      const showRead = () => {
        const d = new Date(cm.updatedAt || cm.createdAt || Date.now());
        this.cpop.replaceChildren(
          ...[quote && el('blockquote', {}, quote),
            el('p', { class: 'yb-cpop-text' }, cm.text || '(empty comment)'),
            el('small', {}, `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`),
            el('div', { class: 'yb-cpop-act' },
              el('button', { class: 'yb-btn yb-danger', onclick: async () => {
                map.delete(cm.id);
                const text = unmark();
                close(true);
                if (!editing) await persist(map, text);
              } }, 'Delete'),
              el('button', { class: 'yb-btn', onclick: () => showEdit() }, 'Edit'),
              el('button', { class: 'yb-btn', onclick: () => close(true) }, 'Close'))].filter(Boolean));
        this._placePop(o.anchor);
      };
      this.cpop.hidden = false;
      if (o.isNew || !cm.text) showEdit(); else showRead();
    }
    _placePop(anchor) {
      const rr = this.root.getBoundingClientRect();
      const a = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: rr.left + 20, bottom: rr.top + 60, top: rr.top + 60 };
      const w = this.cpop.offsetWidth, h = this.cpop.offsetHeight;
      const x = clamp(a.left - rr.left, 6, rr.width - w - 6);
      let y = a.bottom - rr.top + 8;
      if (y + h > rr.height - 6) y = Math.max(6, a.top - rr.top - h - 8);
      this.cpop.style.left = x + 'px'; this.cpop.style.top = y + 'px';
    }

    // ---------- undo / redo (board level; text editing has the browser's own undo) ----------
    async _snap(ids) {
      const out = {};
      for (const id of ids) {
        const b = await this.api.getBoard(id);
        out[id] = new Map(((b && b.items) || []).map((i) => [i.id, JSON.stringify(i)]));
      }
      return out;
    }
    async _pushHistory(ids, before) {
      const after = await this._snap(ids);
      const entry = [];
      const norm = (j) => { if (!j) return null; const o = JSON.parse(j); delete o.updatedAt; return JSON.stringify(o); };
      for (const id of ids) {
        const A = before[id], B = after[id];
        const changed = [...new Set([...A.keys(), ...B.keys()])].filter((k) => norm(A.get(k)) !== norm(B.get(k)));
        if (!changed.length) continue;
        entry.push({
          boardId: id,
          before: changed.map((k) => (A.get(k) ? JSON.parse(A.get(k)) : { id: k })),
          after: changed.map((k) => (B.get(k) ? JSON.parse(B.get(k)) : { id: k })),
        });
      }
      if (!entry.length) return;
      this.history.push(entry);
      if (this.history.length > 100) this.history.shift();
      this.future = [];
    }
    async undo() {
      if (this.editing) await this.commitEdit();
      const entry = this.history.pop();
      if (!entry) return this.toast('Nothing to undo');
      for (const e of entry) await this.api.restoreItems(e.boardId, e.before);
      this.future.push(entry);
      this.toast('Undone');
      this.reload();
    }
    async redo() {
      if (this.editing) await this.commitEdit();
      const entry = this.future.pop();
      if (!entry) return this.toast('Nothing to redo');
      for (const e of entry) await this.api.restoreItems(e.boardId, e.after);
      this.history.push(entry);
      this.toast('Redone');
      this.reload();
    }

    // ---------- trash ----------
    async openTrash() {
      this._closeMenu();
      const list = await this.api.trash();
      const label = { note: 'Note', shot: 'Capture', image: 'Image', board: 'Board', link: 'Link', column: 'Column', line: 'Line', color: 'Color', comment: 'Comment', heading: 'Heading', table: 'Table', sketch: 'Sketch', video: 'Video', map: 'Map', audio: 'Audio', file: 'File', doc: 'Document', ink: 'Draw' };
      const rows = list.map((t) => {
        const it = t.item;
        const text = String(it.type === 'board' ? t.boardRefTitle || '' : YVN.itemText(it)).replace(/\s+/g, ' ');
        const d = new Date(t.deletedAt);
        return el('li', { class: 'yb-trow' },
          el('div', {},
            el('small', {}, `${label[it.type] || ''} · from "${t.boardTitle || 'Home'}" · ${d.getMonth() + 1}/${d.getDate()}`),
            el('span', {}, text ? (text.length > 80 ? text.slice(0, 80) + '…' : text) : '(no text)')),
          el('button', { class: 'yb-btn', onclick: async () => {
            await this.api.restoreFromTrash(t.boardId, it.id);
            this.toast('Restored to "' + (t.boardTitle || 'Home') + '」');
            this.reload(); this.openTrash();
          } }, 'Restore'),
          el('button', { class: 'yb-btn yb-danger', onclick: async () => { await this.api.purgeTrash([{ boardId: t.boardId, itemId: it.id }]); this.openTrash(); } }, 'Delete forever'));
      });
      this.trashBox.replaceChildren(
        el('div', { class: 'yb-srow yb-thead' },
          el('b', { class: 'yb-ttl' }, 'Trash'),
          el('small', { class: 'yb-tnote' }, 'Deleted cards are kept for 30 days'),
          list.length > 0 && el('button', { class: 'yb-btn yb-danger', onclick: async () => {
            if (!confirm(`Permanently delete ${list.length} cards in the trash? This can't be undone.`)) return;
            await this.api.purgeTrash(list.map((t) => ({ boardId: t.boardId, itemId: t.item.id })));
            this.openTrash();
          } }, 'Empty'),
          el('button', { class: 'yb-hbtn', 'aria-label': 'Close trash', onclick: () => { this.trashBox.hidden = true; } }, '✕')),
        el('ul', { class: 'yb-sres' }, rows.length ? rows : el('li', { class: 'yb-snone' }, 'Trash is empty')));
      this.trashBox.hidden = false;
    }

    async _linkTitle(url) {
      const vid = ytId(url);
      if (!vid) return host(url);
      try {
        const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + vid)}`);
        if (r.ok) return (await r.json()).title || url;
      } catch (e) { /* CORS / offline */ }
      return 'YouTube video';
    }

    _renameInline(span, boardId) {
      const inp = el('input', { class: 'yb-input yb-rename', value: this._title(boardId) });
      span.replaceWith(inp);
      inp.focus(); inp.select();
      let done = false;
      const finish = async (save) => {
        if (done) return; done = true;
        const v = inp.value.trim();
        if (save && v && v !== this._title(boardId)) await this.api.updateBoard(boardId, { title: v });
        this.reload();
      };
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
      inp.addEventListener('blur', () => finish(true));
      inp.addEventListener('pointerdown', (e) => e.stopPropagation());
    }
    _renameCard(it) {
      const c = this.els.get(it.id);
      const t = c && c.querySelector('.yb-btitle');
      if (t) { const s = el('span'); t.replaceChildren(s); this._renameInline(s, it.boardId); }
    }

    // ---------- creating cards ----------
    _after() {
      return this._cards().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).pop() || null;
    }
    /** Press a toolbar button and drag it onto the board to create the card where it is dropped. */
    _dragTool(btn, act) {
      if (['line', 'draw', 'upload', 'upload_image', 'audio'].includes(act)) return; // these start a mode or a file picker
      btn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const sx = e.clientX, sy = e.clientY;
        let ghost = null;
        const mv = (ev) => {
          if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
          if (!ghost) {
            ghost = el('div', { class: 'yb-toolghost' }, btn.querySelector('.yb-ic').cloneNode(true), el('span', {}, btn.textContent));
            this.root.append(ghost);
            if (this.flyout) this.flyout.hidden = true;
          }
          const rr = this.root.getBoundingClientRect();
          ghost.style.left = ev.clientX - rr.left - 20 + 'px'; ghost.style.top = ev.clientY - rr.top - 16 + 'px';
          const r = this.vp.getBoundingClientRect();
          ghost.classList.toggle('yb-over', ev.clientX > r.left && ev.clientX < r.right && ev.clientY > r.top && ev.clientY < r.bottom);
        };
        const up = (ev) => {
          window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
          if (!ghost) return;
          ghost.remove();
          this._toolDragged = true;
          setTimeout(() => { this._toolDragged = false; }, 0);
          const r = this.vp.getBoundingClientRect();
          if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return;
          const pt = this._toBoard(ev.clientX, ev.clientY);
          this._dropAt = { x: snap(pt.x - 20), y: snap(pt.y - 16) };
          this.tool(act).finally(() => { this._dropAt = null; });
        };
        window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
      });
    }

    _slot(w, h, at) {
      if (at) return at;
      if (this._dropAt) { const d = this._dropAt; this._dropAt = null; return d; }
      const v = this._visible();
      const items = this._cards();
      const after = this._after();
      const maxW = Math.max(w + 20, Math.min(v.w - 40, 1400));
      const left = items.length ? Math.min(...items.map((i) => i.x)) : snap(v.x + 30);
      const top = items.length ? Math.min(...items.map((i) => i.y)) : snap(v.y + 30);
      return YVN.findSlot(items, w, h, { after, maxW, left, top, sizeOf: (i) => this._rectOf(i) });
    }

    async tool(act) {
      if (this.editing) await this.commitEdit();
      if (act === 'shot') return this.captureShot();
      if (act === 'summary') {
        const video = this.o.currentVideo && (await this.o.currentVideo());
        if (!video) return this.toast('Open a YouTube video first');
        return this._addNote({ video, color: '#f5a524' });
      }
      if (act === 'note') return this._addNote({});
      if (act === 'todo') return this._addNote({ text: '**To-do**\n- [ ] ', w: 240 });
      if (act === 'board') return this._addBoard();
      if (act === 'link') return this._addLink('');
      if (act === 'column') return this._addColumn();
      if (act === 'color') return this._addColor();
      if (act === 'comment') return this._addComment();
      if (act === 'heading') return this._addSimple({ type: 'heading', text: '' });
      if (act === 'table') return this._addSimple({ type: 'table', rows: [['', '', ''], ['', '', ''], ['', '', '']] });
      if (act === 'sketch') return this._addSimple({ type: 'sketch', strokes: [], sh: 225 });
      if (act === 'video') return this._addSimple({ type: 'video', url: '' });
      if (act === 'map') return this._addSimple({ type: 'map', query: '' });
      if (act === 'doc') return this._addSimple({ type: 'doc', title: '', text: '' });
      if (act === 'audio') return this._pickFiles('audio/*', 'audio');
      if (act === 'upload_image') return this._pickFiles('image/*', 'image');
      if (act === 'draw') return this.setDraw(!this._draw);
      if (act === 'line') {
        this._lineMode = true; this.vp.classList.add('yb-linemode');
        this.toast('Drag from a card (or empty space) to another card to connect them. Esc to cancel');
        return;
      }
      if (act === 'upload') return this._pickFiles('', 'auto');
    }

    async _addNote(o) {
      const w = o.w || YVN.CARD_W.note;
      const p = this._slot(w, 120, o.x != null ? { x: o.x, y: o.y } : null);
      const it = await this.m.putItem(this.boardId, { type: 'note', text: o.text || '', video: o.video, color: o.color, w, ...p });
      await this.reload();
      this.focusItem(it.id, false);
      if (o.edit !== false) { this._fresh = it.id; this.startEdit(it.id); }
      return it;
    }
    async _addBoard() {
      const p = this._slot(YVN.CARD_W.board, 120);
      const { item } = await this.m.createBoard(this.boardId, { ...p, title: 'New Board', color: YVN.BOARD_COLORS[Math.floor(Math.random() * 8)] });
      await this.reload();
      this.focusItem(item.id, false);
      this._renameCard(item);
    }
    async _addLink(url) {
      const p = this._slot(YVN.CARD_W.link, url ? 200 : 64);
      const it = await this.m.putItem(this.boardId, { type: 'link', url, title: url ? await this._linkTitle(url) : '', w: YVN.CARD_W.link, ...p });
      await this.reload();
      this.focusItem(it.id, false);
      if (!url) { this._fresh = it.id; this.startEdit(it.id); }
    }

    /** Add a captured frame { dataURL, w, h, ts, video } as a screenshot card next to the previous one. */
    async addShot(cap) {
      if (!cap || !cap.dataURL) return null;
      const w = YVN.CARD_W.shot;
      const h = Math.round(w * cap.h / cap.w) + 34;
      const p = this._slot(w, h);
      const it = await this.m.putItem(this.boardId, {
        type: 'shot', ts: cap.ts, video: cap.video || null, text: '', w,
        image: { id: YVN.uid('img_'), w: cap.w, h: cap.h, edits: null, fileId: null, editedFileId: null, editedAt: null }, ...p,
      }, cap.dataURL);
      await this.reload();
      this.focusItem(it.id);
      return it;
    }
    async captureShot() {
      if (!this.o.capture) return;
      try {
        const cap = await this.o.capture();
        if (cap) await this.addShot(cap);
      } catch (e) { this.toast(e.message || String(e)); }
    }

    _pickFiles(accept, kind, replaceId) {
      this._fileKind = kind; this._fileReplace = replaceId || null;
      this.fileInput.accept = accept || '';
      this.fileInput.click();
    }
    async _addFiles(files, at, kind) {
      let pos = at ? { x: snap(at.x), y: snap(at.y) } : null;
      const replaceId = this._fileReplace; this._fileReplace = null; this._fileKind = null;
      for (const f of files) {
        const isImg = /^image\//.test(f.type) && kind !== 'auto-file';
        if (!isImg) {
          if (f.size > 25 * 1024 * 1024) { this.toast(`"${f.name}" is over 25 MB and can't be uploaded`); continue; }
          const type = /^audio\//.test(f.type) ? 'audio' : /^video\//.test(f.type) ? 'video' : 'file';
          const dataURL = await YVN.blobToDataURL(f);
          const file = { id: YVN.uid('f_'), name: f.name, mime: f.type || 'application/octet-stream', size: f.size, fileId: null };
          const w = YVN.CARD_W[type];
          let it;
          if (replaceId) it = await this.m.putItem(this.boardId, { id: replaceId, file, url: '' }, dataURL);
          else it = await this.m.putItem(this.boardId, { type, file, w, ...(pos || this._slot(w, YVN.estimateSize({ type, w }).h)) }, dataURL);
          pos = null;
          await this.reload();
          this.focusItem(it.id);
          continue;
        }
        const dataURL = await YVN.blobToDataURL(f);
        const im = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = dataURL; });
        if (!im) continue;
        // re-encode large pictures as WebP to keep Drive light
        let out = dataURL, w = im.naturalWidth, h = im.naturalHeight;
        const scale = Math.min(1, 2400 / Math.max(w, h));
        if (scale < 1 || !/webp/.test(f.type)) {
          const c = document.createElement('canvas');
          c.width = Math.round(w * scale); c.height = Math.round(h * scale);
          c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
          out = c.toDataURL('image/webp', 0.9); w = c.width; h = c.height;
        }
        const cw = YVN.CARD_W.image;
        const p = pos || this._slot(cw, Math.round(cw * h / w));
        const it = await this.m.putItem(this.boardId, {
          type: 'image', text: '', w: cw, ...p,
          image: { id: YVN.uid('img_'), w, h, edits: null, fileId: null, editedFileId: null, editedAt: null },
        }, out);
        pos = null;
        await this.reload();
        this.focusItem(it.id);
      }
    }

    // ---------- image editor ----------
    openEditor(itemId) {
      const shots = YVN.liveItems(this.board).filter((i) => i.image).sort((a, b) => a.y - b.y || a.x - b.x);
      const idx = Math.max(0, shots.findIndex((i) => i.id === itemId));
      const boardId = this.boardId;
      YVN.Editor.open({
        index: idx,
        images: shots.map((it) => ({
          id: it.id, ts: it.type === 'shot' ? it.ts : null, edits: it.image.edits, video: it.video,
          load: () => this.api.getImage(boardId, it, 'orig'),
        })),
        onSeek: (ts, image) => this._seek(image && image.video, ts),
        onSave: async (image, { edits, blob }) => {
          await this.api.saveImageEdit(boardId, image.id, edits, blob);
          if (this.boardId === boardId) this.reload();
        },
      });
    }

    // ---------- columns ----------
    async _addColumn() {
      const p = this._slot(YVN.CARD_W.column, 200);
      const it = await this.m.putItem(this.boardId, { type: 'column', title: '', w: YVN.CARD_W.column, ...p });
      await this.reload();
      this.focusItem(it.id, false);
      this._renameColumn(it);
    }
    _renameColumn(it) {
      const c = it && this.els.get(it.id);
      const t = c && c.querySelector('.yb-coltitle');
      if (!t) return;
      const inp = el('input', { class: 'yb-input yb-rename', value: it.title || '', placeholder: 'Column title' });
      t.replaceWith(inp);
      inp.focus(); inp.select();
      let done = false;
      const finish = async (save) => {
        if (done) return; done = true;
        const v = inp.value.trim();
        if (save && v !== (it.title || '')) await this.m.patchItems(this.boardId, [{ id: it.id, title: v }]);
        c._sig = null;
        this.reload();
      };
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
      inp.addEventListener('blur', () => finish(true));
      inp.addEventListener('pointerdown', (e) => e.stopPropagation());
    }
    /** Show where dragged cards will land inside a column. */
    _colDropAt(gst, col, clientY) {
      if (!this.colIns) this.colIns = el('div', { class: 'yb-colins' });
      if (gst.colDrop && gst.colDrop.col !== col) gst.colDrop.col.classList.remove('yb-coldrop');
      if (!col) { gst.colDrop = null; this.colIns.remove(); return; }
      const body = col.querySelector('.yb-colbody');
      const kids = [...body.children].filter((k) => k.classList.contains('yb-item') && !k.classList.contains('yb-dragging'));
      let index = kids.findIndex((k) => { const r = k.getBoundingClientRect(); return clientY < r.top + r.height / 2; });
      if (index < 0) index = kids.length;
      if (kids[index]) body.insertBefore(this.colIns, kids[index]); else body.appendChild(this.colIns);
      col.classList.add('yb-coldrop');
      gst.colDrop = { col, index };
    }

    // ---------- simple editors shared by heading / video / map ----------
    async _addSimple(o) {
      const w = YVN.CARD_W[o.type] || 260;
      const p = this._slot(w, YVN.estimateSize({ ...o, w }).h);
      const it = await this.m.putItem(this.boardId, { ...o, w, ...p });
      await this.reload();
      this.focusItem(it.id, false);
      this._fresh = it.id;
      this.startEdit(it.id);
    }
    _patchEdit(it, c, inp, get, empty) {
      const id = it.id;
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); this.commitEdit(); } });
      inp.addEventListener('blur', () => setTimeout(() => { if (this.editing === id && !c.contains(document.activeElement)) this.commitEdit(); }, 200));
      inp.addEventListener('pointerdown', (e) => e.stopPropagation());
      this._edit = { it, field: 'patch', get, empty };
      inp.focus(); inp.select && inp.select();
    }

    // ---------- table ----------
    _tableEl(rows, editable) {
      rows = rows && rows.length ? rows : [['', '', ''], ['', '', ''], ['', '', '']];
      const t = el('table', { class: 'yb-table' });
      rows.forEach((row, i) => {
        const tr = el('tr');
        for (const cell of row) {
          const td = el(i === 0 ? 'th' : 'td', editable ? { contenteditable: 'plaintext-only', spellcheck: 'false' } : {}, cell);
          if (editable) td.addEventListener('pointerdown', (e) => e.stopPropagation());
          tr.append(td);
        }
        t.append(tr);
      });
      return t;
    }

    // ---------- sketch card ----------
    _sketchSvg(it, editing) {
      const NS = 'http://www.w3.org/2000/svg';
      const sh = it.sh || 225;
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', `0 0 300 ${sh}`);
      svg.setAttribute('class', 'yb-sksvg' + (editing ? ' yb-skedit' : ''));
      for (const st of it.strokes || []) svg.append(this._skPath(st));
      return svg;
    }
    _skPath(st) {
      const pth = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pth.setAttribute('d', st.pts.map((q, i) => (i ? 'L' : 'M') + q[0] + ',' + q[1]).join(' '));
      pth.setAttribute('style', `stroke:${st.color};stroke-width:${st.size}px`);
      return pth;
    }
    _sketchEdit(it, c) {
      const id = it.id;
      const strokes = (it.strokes || []).map((x) => ({ ...x }));
      const fg = (getComputedStyle(this.root).getPropertyValue('--yb-fg') || '').trim();
      const dark = this.root.classList.contains('yb-dark') || !!this.root.closest('.yb-dark') || /^#(f|e)/i.test(fg);
      const state = { color: dark ? '#f1f1f3' : '#1d1d1f', size: 3, erase: false };
      const old = c.querySelector('.yb-sksvg'); const ph = c.querySelector('.yb-skph'); if (ph) ph.remove();
      const svg = this._sketchSvg({ ...it, strokes }, true);
      old.replaceWith(svg);
      const redraw = () => { svg.replaceChildren(...strokes.map((x) => this._skPath(x))); };
      const toLocal = (e) => { const r = svg.getBoundingClientRect(); return [Math.round((e.clientX - r.left) / r.width * 300 * 10) / 10, Math.round((e.clientY - r.top) / r.height * (it.sh || 225) * 10) / 10]; };
      let cur = null;
      svg.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); e.preventDefault();
        svg.setPointerCapture(e.pointerId);
        const p0 = toLocal(e);
        if (state.erase) { cur = { erase: true }; eraseAt(p0); return; }
        cur = { color: state.color, size: state.size, pts: [p0] };
        strokes.push(cur); svg.append(this._skPath(cur));
      });
      const eraseAt = (q) => {
        const n = strokes.length;
        for (let i = strokes.length - 1; i >= 0; i--) if (strokes[i].pts.some((pp) => Math.hypot(pp[0] - q[0], pp[1] - q[1]) < 8)) strokes.splice(i, 1);
        if (strokes.length !== n) redraw();
      };
      svg.addEventListener('pointermove', (e) => {
        if (!cur) return;
        const q = toLocal(e);
        if (cur.erase) return eraseAt(q);
        const l = cur.pts[cur.pts.length - 1];
        if (Math.hypot(q[0] - l[0], q[1] - l[1]) < 1.5) return;
        cur.pts.push(q);
        svg.lastChild.setAttribute('d', cur.pts.map((pp, i) => (i ? 'L' : 'M') + pp[0] + ',' + pp[1]).join(' '));
      });
      const end = () => { if (cur && !cur.erase && cur.pts.length < 2) { cur.pts.push([cur.pts[0][0] + 0.5, cur.pts[0][1]]); redraw(); } cur = null; };
      svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
      const colors = [dark ? '#f1f1f3' : '#1d1d1f', dark ? '#1d1d1f' : '#ffffff', '#e5484d', '#f5a524', '#30a46c', '#3e63dd', '#8e4ec6'];
      const bar = el('div', { class: 'yb-skbar' },
        ...colors.map((col) => el('button', { class: 'yb-swbtn' + (col === state.color ? ' on' : ''), style: `background:${col}`, 'aria-label': col, onclick: (e) => { state.color = col; state.erase = false; bar.querySelectorAll('.yb-swbtn, .yb-skerase').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); } })),
        el('select', { class: 'yb-sksize', 'aria-label': 'Brush size', onchange: (e) => { state.size = +e.target.value; } }, el('option', { value: '2' }, 'S'), el('option', { value: '3', selected: true }, 'M'), el('option', { value: '6' }, 'L')),
        el('button', { class: 'yb-btn yb-skerase', onclick: (e) => { state.erase = !state.erase; e.currentTarget.classList.toggle('on', state.erase); } }, 'Eraser'),
        el('button', { class: 'yb-btn', onclick: () => { strokes.length = 0; redraw(); } }, 'Clear'),
        el('button', { class: 'yb-btn yb-btn-primary', onclick: () => this.commitEdit() }, 'Done'));
      bar.addEventListener('pointerdown', (e) => e.stopPropagation());
      c.append(bar);
      this._edit = { it, field: 'patch', get: () => ({ strokes }), empty: (v) => !v.strokes.length };
      this._docOutside = null;
    }

    // ---------- document (full-screen editor) ----------
    _docEdit(it, c) {
      const title = el('input', { class: 'yb-doctitle-in', placeholder: 'Document title' });
      title.value = it.title || '';
      const ed = new YVN.RichEditor(it.text || '', { placeholder: 'Start writing… (select text to format it)', onDone: () => this.commitEdit() });
      ed.el.classList.add('yb-docbody');
      const close = el('button', { class: 'yb-btn yb-btn-primary', onclick: () => this.commitEdit() }, 'Done');
      const modal = el('div', { class: 'yb-docmodal' }, el('div', { class: 'yb-docpage' }, el('div', { class: 'yb-docbar' }, el('span', { class: 'yb-ph' }, 'Document'), el('span', { class: 'yb-grow' }), close), title, ed.el));
      modal.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (e.target === modal) this.commitEdit(); });
      modal.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); this.commitEdit(); } });
      this.root.append(modal);
      this._docModal = modal;
      this.fmt.container = modal;
      modal.append(this.fmt.el);
      this.fmt.attach(ed);
      this._edit = { it, field: 'patch', get: () => ({ title: title.value.trim(), text: ed.getMarkdown() }), empty: (v) => !v.title && !v.text };
      if (it.title) ed.focus(); else title.focus();
    }

    // ---------- media ----------
    async _loadMedia(it, mediaEl) {
      if (!it.file) return;
      try { const url = await this.api.getImage(this.boardId, it); if (url) mediaEl.src = url; } catch (e) { /* not synced yet */ }
    }
    async _play(it, card) {
      const wrap = card.querySelector('.yb-vwrap, .yb-mapwrap');
      if (!wrap) return;
      if (it.type === 'map') {
        if (!it.query) return this.startEdit(it.id);
        wrap.replaceChildren(el('iframe', { src: `https://maps.google.com/maps?q=${encodeURIComponent(it.query)}&z=14&output=embed`, loading: 'lazy', referrerpolicy: 'no-referrer-when-downgrade', title: it.query }));
        return;
      }
      if (it.file) {
        const v = el('video', { controls: true, autoplay: true });
        wrap.replaceChildren(v);
        return this._loadMedia(it, v);
      }
      const vid = ytId(it.url), vimeo = /vimeo\.com\/(?:video\/)?(\d+)/.exec(it.url || '');
      const src = vid ? `https://www.youtube-nocookie.com/embed/${vid}?autoplay=1&rel=0` : vimeo ? `https://player.vimeo.com/video/${vimeo[1]}?autoplay=1` : null;
      if (!src) { if (it.url) window.open(it.url, '_blank', 'noopener'); else this.startEdit(it.id); return; }
      wrap.replaceChildren(el('iframe', { src, allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowfullscreen: true, title: it.title || 'Video' }));
    }
    async _openFile(it) {
      if (!it.file) return;
      const url = await this.api.getImage(this.boardId, it);
      if (!url) return this.toast('This file has not synced to this device yet');
      const a = el('a', { href: url, download: it.file.name, target: '_blank', rel: 'noopener' });
      document.body.append(a); a.click(); a.remove();
    }

    // ---------- draw on the board ----------
    _buildDrawBar() {
      const colors = ['#f1f1f3', '#1d1d1f', '#e5484d', '#f5a524', '#30a46c', '#3e63dd', '#8e4ec6'];
      const bar = el('div', { class: 'yb-drawbar', hidden: true });
      const pick = (fn) => (e) => { fn(); bar.querySelectorAll('.on').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); };
      bar.append(el('b', {}, 'Draw'),
        ...colors.map((col, i) => el('button', { class: 'yb-swbtn' + (i === 4 ? ' on' : ''), style: `background:${col}`, 'aria-label': col, onclick: pick(() => { this._draw.color = col; this._draw.erase = false; }) })),
        el('select', { class: 'yb-sksize', 'aria-label': 'Brush size', onchange: (e) => { this._draw.size = +e.target.value; } }, el('option', { value: '2' }, 'S'), el('option', { value: '4', selected: true }, 'M'), el('option', { value: '8' }, 'L')),
        el('button', { class: 'yb-btn', onclick: pick(() => { this._draw.erase = true; }) }, 'Eraser'),
        el('button', { class: 'yb-btn yb-btn-primary', onclick: () => this.setDraw(false) }, 'Done'));
      bar.addEventListener('pointerdown', (e) => e.stopPropagation());
      return bar;
    }
    setDraw(on) {
      this._draw = on ? { color: this._draw ? this._draw.color : '#30a46c', size: 4, erase: false } : null;
      this.drawBar.hidden = !on;
      this.vp.classList.toggle('yb-drawmode', !!on);
      if (on) this.toast('Draw on the board. Press Esc or "Done" to finish');
    }

    /** Copy cards (Alt+drag). Columns bring their cards; pictures and files get their own copy of the file. */
    async _duplicate(ids, positions) {
      const live = YVN.liveItems(this.board);
      const before = await this._snap([this.boardId]);
      const newIds = [];
      let skipped = 0;
      const copyOne = async (it, extra) => {
        if (it.type === 'board') { skipped++; return null; }
        const copy = JSON.parse(JSON.stringify(it));
        for (const k of ['id', 'createdAt', 'updatedAt', 'deleted', 'removedFiles', 'purged', 'moved', 'locked']) delete copy[k];
        Object.assign(copy, extra);
        let data = null;
        const media = it.image ? 'image' : it.file ? 'file' : null;
        if (media) {
          data = await this.api.getImage(this.boardId, it, 'orig');
          if (!data) { skipped++; return null; }
          copy[media] = { ...copy[media], id: YVN.uid(media === 'image' ? 'img_' : 'f_'), fileId: null, editedFileId: null };
          if (media === 'image') { copy.image.edits = null; copy.image.editedAt = null; }
        }
        const saved = await this.api.putItem(this.boardId, copy, data);
        return saved;
      };
      for (const id of ids) {
        const it = live.find((i) => i.id === id);
        if (!it) continue;
        const pos = positions[id] || { x: it.x + 30, y: it.y + 30 };
        const saved = await copyOne(it, { ...pos, col: null, ord: null });
        if (!saved) continue;
        newIds.push(saved.id);
        if (it.type === 'column') {
          for (const k of live.filter((i) => i.col === it.id)) await copyOne(k, { col: saved.id, ord: k.ord });
        }
      }
      await this._pushHistory([this.boardId], before);
      if (skipped) this.toast(skipped === 1 ? 'One card could not be duplicated (boards and unsynced files are skipped)' : `${skipped} cards could not be duplicated (boards and unsynced files are skipped)`);
      await this.reload();
      this.sel = new Set(newIds); this._paintSel();
    }

    // ---------- comment threads ----------
    async _addComment() {
      const p = this._slot(YVN.CARD_W.comment, 120);
      const it = await this.m.putItem(this.boardId, { type: 'comment', comments: [], w: YVN.CARD_W.comment, ...p });
      await this.reload();
      this.focusItem(it.id, false);
      this._fresh = it.id;
      this.startEdit(it.id, { mode: 'reply' });
    }
    /** Who is writing: Google account name/photo when signed in, otherwise "我". */
    async _me() {
      if (this._meCache) return this._meCache;
      let me = null;
      try { me = this.api.me ? await this.api.me() : null; } catch (e) { me = null; }
      this._meCache = me && me.name ? { name: me.name, photo: me.photo || '' } : { name: 'Me', photo: '' };
      return this._meCache;
    }
    _commentLine(cm) {
      const a = cm.author || { name: 'Me' };
      const initial = (a.name || 'Me').trim().slice(0, 1).toUpperCase();
      const av = el('div', { class: 'yb-avatar', 'aria-hidden': 'true' }, initial);
      if (a.photo) {
        const img = el('img', { src: a.photo, alt: '', referrerpolicy: 'no-referrer', draggable: 'false' });
        img.onerror = () => img.remove();
        av.append(img);
      }
      return el('div', { class: 'yb-cline', dataset: { c: cm.id } }, av,
        el('div', { class: 'yb-cdetails' },
          el('div', { class: 'yb-chead' },
            el('b', {}, a.name || 'Me'),
            el('small', { title: new Date(cm.createdAt || Date.now()).toLocaleString() }, YVN.friendlyTime(cm.updatedAt && cm.updatedAt !== cm.createdAt ? cm.updatedAt : cm.createdAt) + (cm.updatedAt && cm.updatedAt !== cm.createdAt ? ' (edited)' : '')),
            el('button', { class: 'yb-cedit', dataset: { act: 'cedit', c: cm.id } }, 'Edit')),
          el('div', { class: 'yb-ctext yvn-md', html: YVN.renderMarkdown(cm.text || '') })));
    }

    // ---------- color swatches ----------
    async _addColor() {
      const palette = ['#e5484d', '#f76b15', '#f5a524', '#30a46c', '#12a594', '#3e63dd', '#8e4ec6', '#d6409f'];
      const p = this._slot(YVN.CARD_W.color, 160);
      const it = await this.m.putItem(this.boardId, { type: 'color', hex: palette[Math.floor(Math.random() * palette.length)], name: '', w: YVN.CARD_W.color, ...p });
      await this.reload();
      this.focusItem(it.id, false);
      this._fresh = it.id;
      this.startEdit(it.id);
    }

    // ---------- lines ----------
    /** Line end under the pointer: attached to a card (not `exceptId`) or a free point. */
    _endAt(e, exceptId) {
      const pt = this._toBoard(e.clientX, e.clientY);
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const card = hit && hit.closest && hit.closest('.yb-item');
      if (card && this.layer.contains(card) && card.dataset.id !== exceptId && !card.classList.contains('yb-dragging')) {
        const r = this._layerRect(card);
        return { id: card.dataset.id, x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) };
      }
      return { x: Math.round(pt.x), y: Math.round(pt.y) };
    }
    _startLineFrom(id) {
      const c = this.els.get(id);
      if (!c) return;
      this._lineMode = true; this.vp.classList.add('yb-linemode');
      const r = this._layerRect(c);
      this._pendingFrom = { id, x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) };
      this.toast('Click or drag to another card to connect. Esc to cancel');
    }
    /** Resolve a stored end ({id?, x, y}) to a point or a card box. */
    _endBox(end) {
      if (!end) return { x: 0, y: 0 };
      if (end.id) {
        const c = this.els.get(end.id);
        if (c && c.isConnected) {
          if (c.getClientRects().length) return { rect: this._layerRect(c) };
          const col = c.closest('.yb-column');
          if (col) return { rect: this._layerRect(col) };
        }
      }
      return { x: end.x, y: end.y };
    }
    _clip(box, toward) {
      if (!box.rect) return { x: box.x, y: box.y };
      const r = box.rect, cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      const dx = toward.x - cx, dy = toward.y - cy;
      if (!dx && !dy) return { x: cx, y: cy };
      const pad = 6;
      const t = Math.min(dx ? (r.w / 2 + pad) / Math.abs(dx) : Infinity, dy ? (r.h / 2 + pad) / Math.abs(dy) : Infinity);
      return { x: cx + dx * Math.min(t, 1), y: cy + dy * Math.min(t, 1) };
    }
    _center(box) { return box.rect ? { x: box.rect.x + box.rect.w / 2, y: box.rect.y + box.rect.h / 2 } : { x: box.x, y: box.y }; }
    _renderLines() {
      if (!this.svg || !this.board) return;
      const NS = 'http://www.w3.org/2000/svg';
      const mk = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
      this.svg.replaceChildren();
      this.lbls.replaceChildren();
      const gst = this.gesture;
      const arrow = (g, tip, from, color) => {
        const ang = Math.atan2(tip.y - from.y, tip.x - from.x), L = 13, W = 6.5;
        const bx = tip.x - Math.cos(ang) * L, by = tip.y - Math.sin(ang) * L;
        const px = -Math.sin(ang) * W, py = Math.cos(ang) * W;
        g.append(mk('path', { d: `M${tip.x},${tip.y} L${bx + px},${by + py} L${bx - px},${by - py} Z`, class: 'yb-arrow', style: `fill:${color}` }));
      };
      const draw = (ln, A, B, selected, preview) => {
        const pa = this._clip(A, this._center(B)), pb = this._clip(B, this._center(A));
        const color = ln.color || 'var(--yb-linec)';
        const g = mk('g', { class: 'yb-line' + (selected ? ' yb-lsel' : '') + (preview ? ' yb-lprev' : ''), 'data-id': ln.id || '' });
        const d = `M${pa.x},${pa.y} L${pb.x},${pb.y}`;
        if (!preview) g.append(mk('path', { d, class: 'yb-hit' }));
        g.append(mk('path', { d, class: 'yb-vis', style: `stroke:${color}` }));
        if (ln.arrow === 'end' || ln.arrow === 'both') arrow(g, pb, pa, color);
        if (ln.arrow === 'both') arrow(g, pa, pb, color);
        if (selected && !preview) {
          g.append(mk('circle', { cx: pa.x, cy: pa.y, r: 6, class: 'yb-hnd', 'data-line': ln.id, 'data-end': 'from' }));
          g.append(mk('circle', { cx: pb.x, cy: pb.y, r: 6, class: 'yb-hnd', 'data-line': ln.id, 'data-end': 'to' }));
        }
        this.svg.append(g);
        if (ln.label && !preview) {
          this.lbls.append(el('div', { class: 'yb-llabel' + (selected ? ' yb-lsel' : ''), dataset: { id: ln.id }, style: `left:${(pa.x + pb.x) / 2}px;top:${(pa.y + pb.y) / 2}px` }, ln.label));
        }
      };
      for (const ln of YVN.liveItems(this.board)) {
        if (ln.type !== 'line') continue;
        let A = this._endBox(ln.from), B = this._endBox(ln.to);
        if (gst && gst.kind === 'line-end' && gst.id === ln.id && gst.pt) { if (gst.end === 'from') A = gst.pt; else B = gst.pt; }
        draw(ln, A, B, this.sel.has(ln.id));
      }
      const inkPath = (pts) => pts.map((q, i) => (i ? 'L' : 'M') + q[0] + ',' + q[1]).join(' ');
      for (const ink of YVN.liveItems(this.board)) {
        if (ink.type !== 'ink' || !ink.pts || ink.pts.length < 2) continue;
        const g = mk('g', { class: 'yb-inkg' + (this.sel.has(ink.id) ? ' yb-lsel' : ''), 'data-id': ink.id });
        const d = inkPath(ink.pts);
        g.append(mk('path', { d, class: 'yb-hit', style: `stroke-width:${(ink.size || 3) + 12}px` }), mk('path', { d, class: 'yb-inkp', style: `stroke:${ink.color || 'var(--yb-fg)'};stroke-width:${ink.size || 3}px` }));
        this.svg.append(g);
      }
      if (gst && gst.kind === 'ink' && gst.pts.length > 1) {
        const g = mk('g', { class: 'yb-inkg' });
        g.append(mk('path', { d: inkPath(gst.pts), class: 'yb-inkp', style: `stroke:${this._draw.color};stroke-width:${this._draw.size}px` }));
        this.svg.append(g);
      }
      if (gst && gst.kind === 'line-new' && gst.pt) draw({ arrow: 'end' }, this._endBox(gst.from), gst.pt, false, true);
    }
    _lineMenu(id, anchor) {
      const ln = this.board.items.find((i) => i.id === id);
      if (!ln) return;
      const set = async (patch) => { await this.m.patchItems(this.boardId, [{ id, ...patch }]); this.reload(); };
      this._menuAt(anchor, [
        { label: ln.label ? 'Edit text' : 'Add label', icon: 'note', run: () => this._editLineLabel(id) },
        { label: 'Arrow →', icon: 'line', run: () => set({ arrow: 'end' }) },
        { label: 'Two-way arrow ↔', icon: 'line', run: () => set({ arrow: 'both' }) },
        { label: 'No arrow —', icon: 'line', run: () => set({ arrow: 'none' }) },
        { label: 'Reverse direction', icon: 'redo', run: () => set({ from: ln.to, to: ln.from }) },
        { colors: [null, ...YVN.BOARD_COLORS], pick: (c) => set({ color: c }) },
        { sep: true },
        { label: 'Delete line', danger: true, run: async () => { await this.m.deleteItems(this.boardId, [id]); this.sel.delete(id); this.reload(); } },
      ]);
    }
    _editLineLabel(id) {
      const ln = this.board.items.find((i) => i.id === id);
      if (!ln) return;
      const A = this._endBox(ln.from), B = this._endBox(ln.to);
      const pa = this._clip(A, this._center(B)), pb = this._clip(B, this._center(A));
      const inp = el('input', { class: 'yb-input yb-lblinput', value: ln.label || '', placeholder: 'Line label', style: `left:${(pa.x + pb.x) / 2}px;top:${(pa.y + pb.y) / 2}px` });
      this.layer.append(inp);
      inp.focus(); inp.select();
      let done = false;
      const finish = async (save) => {
        if (done) return; done = true;
        inp.remove();
        const v = inp.value.trim();
        if (save && v !== (ln.label || '')) { await this.m.patchItems(this.boardId, [{ id, label: v }]); this.reload(); }
      };
      inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
      inp.addEventListener('blur', () => finish(true));
      inp.addEventListener('pointerdown', (e) => e.stopPropagation());
    }

    destroy() { if (this._unsub) this._unsub(); }
  }

  YVN.BoardView = BoardView;
  YVN.boardIcon = icon;
  YVN.el = el;
})(typeof self !== 'undefined' ? self : globalThis);
