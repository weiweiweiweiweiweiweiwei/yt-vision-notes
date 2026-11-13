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
      this.crumbs = el('nav', { class: 'yb-crumbs', 'aria-label': 'Board 路徑' });
      this.zoomLbl = el('button', { class: 'yb-hbtn yb-zoom', title: '符合全部（Ctrl+滾輪縮放）', onclick: () => this.fit() }, '100%');
      this.head = el('header', { class: 'yb-head' }, this.crumbs, el('span', { class: 'yb-grow' }),
        el('button', { class: 'yb-hbtn', title: '搜尋全部筆記', 'aria-label': '搜尋', onclick: () => this.toggleSearch(true) }, icon('search')),
        this.mode !== 'panel' && el('button', { class: 'yb-hbtn', title: '縮小', 'aria-label': '縮小', onclick: () => this.zoomBy(1 / 1.2) }, icon('minus', 16)),
        this.zoomLbl,
        this.mode !== 'panel' && el('button', { class: 'yb-hbtn', title: '放大', 'aria-label': '放大', onclick: () => this.zoomBy(1.2) }, icon('plus', 16)),
        ...(this.o.headerExtras || []));
      this.recentRow = el('div', { class: 'yb-recent', hidden: true });
      this.layer = el('div', { class: 'yb-layer' });
      this.marquee = el('div', { class: 'yb-marquee', hidden: true });
      this.empty = el('div', { class: 'yb-empty', hidden: true });
      this.vp = el('div', { class: 'yb-vp', tabindex: '0' }, this.layer, this.marquee, this.empty);
      this.menu = el('div', { class: 'yb-menu', hidden: true, role: 'menu' });
      this.searchBox = this._buildSearch();
      this.toastEl = el('div', { class: 'yb-toast', role: 'status', hidden: true });
      this.fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: (e) => { this._addFiles([...e.target.files]); e.target.value = ''; } });

      const tools = [
        this.o.capture && ['shot', 'camera', '截圖', '擷取目前影片畫面，直接放進這個 Board（Alt+S）'],
        this.o.capture && ['summary', 'summary', '總結', '針對整部影片的總結筆記（不含截圖）'],
        ['note', 'note', '筆記', '文字筆記（也可以雙擊空白處）'],
        ['board', 'board', 'Board', '新增子 Board'],
        ['todo', 'todo', '待辦', '待辦清單'],
        ['link', 'link', '連結', '網址或 YouTube 影片'],
        ['upload', 'image', '圖片', '上傳圖片（也可以貼上或拖曳）'],
      ].filter(Boolean);
      const btn = ([act, ic, label, title]) => el('button', { class: 'yb-tool' + (act === 'shot' ? ' yb-primary' : ''), title, dataset: { tool: act }, onclick: () => this.tool(act) }, icon(ic, 20), el('span', {}, label));
      let toolbar;
      if (this.mode === 'panel') {
        const main = tools.filter((t) => ['shot', 'summary', 'board'].includes(t[0]));
        const rest = tools.filter((t) => !['shot', 'summary', 'board'].includes(t[0]));
        toolbar = el('div', { class: 'yb-bar' }, main.map(btn),
          el('button', { class: 'yb-tool', title: '更多', onclick: (e) => this._menuAt(e.currentTarget, rest.map(([act, ic, label]) => ({ label, icon: ic, run: () => this.tool(act) })), true) }, icon('more', 20), el('span', {}, '更多')));
        r.append(this.head, this.recentRow, el('div', { class: 'yb-body' }, this.vp), toolbar);
      } else {
        toolbar = el('div', { class: 'yb-tools' }, tools.map(btn));
        r.append(this.head, this.recentRow, el('div', { class: 'yb-body' }, toolbar, this.vp));
      }
      r.append(this.menu, this.searchBox, this.toastEl, this.fileInput);
      this._bind();
    }

    _buildSearch() {
      this.sInput = el('input', { type: 'search', placeholder: '搜尋所有 Board 的筆記、#標籤、影片標題…', 'aria-label': '搜尋' });
      this.sList = el('ul', { class: 'yb-sres' });
      let t;
      this.sInput.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => this._runSearch(), 150); });
      this.sInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') this.toggleSearch(false);
        if (e.key === 'Enter') { const f = this.sList.querySelector('li'); if (f) f.click(); }
      });
      return el('div', { class: 'yb-search', hidden: true },
        el('div', { class: 'yb-srow' }, this.sInput, el('button', { class: 'yb-hbtn', 'aria-label': '關閉搜尋', onclick: () => this.toggleSearch(false) }, '✕')),
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
      if (!res.length) { this.sList.append(el('li', { class: 'yb-snone' }, '找不到符合的筆記')); return; }
      const label = { note: '筆記', shot: '截圖', image: '圖片', board: 'Board', link: '連結' };
      for (const r of res) {
        const text = (r.text || '').replace(/\s+/g, ' ');
        this.sList.append(el('li', { tabindex: '0', onclick: () => { this.toggleSearch(false); this.open(r.type === 'board' && !r.itemId ? r.boardId : r.boardId, r.itemId); } },
          el('small', {}, `${r.boardTitle || '首頁'} · ${label[r.type] || ''}${r.ts != null ? ' · ' + YVN.fmtTime(r.ts) : ''}`),
          el('span', {}, text.length > 90 ? text.slice(0, 90) + '…' : text || '（無文字）')));
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
    _title(id) { return id === HOME ? '首頁' : (this.sums[id] && this.sums[id].title) || (this.board && this.board.id === id && this.board.title) || '未命名'; }

    _renderCrumbs() {
      const chain = this._chain();
      this.crumbs.replaceChildren();
      chain.forEach((id, i) => {
        const last = i === chain.length - 1;
        if (i) this.crumbs.append(el('span', { class: 'yb-sep', 'aria-hidden': 'true' }, '›'));
        const b = el('button', { class: 'yb-crumb' + (last ? ' yb-cur' : ''), title: last && id !== HOME ? '雙擊重新命名' : this._title(id) },
          id === HOME ? icon('home', 16) : el('i', { class: 'yb-cdot', style: `background:${(this.sums[id] || this.board || {}).color || '#8b8d98'}` }),
          el('span', {}, id === HOME ? '首頁' : this._title(id)));
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
      this.recentRow.replaceChildren(el('small', {}, '最近使用'),
        ...ids.map((id) => el('button', { class: 'yb-chip', onclick: () => this.open(id) },
          el('i', { class: 'yb-cdot', style: `background:${this.sums[id].color}` }), this.sums[id].title || '未命名')));
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
      const e = this.els.get(it.id);
      if (e && e.offsetWidth) return { x: it.x, y: it.y, w: e.offsetWidth, h: e.offsetHeight };
      return { x: it.x, y: it.y, ...YVN.estimateSize(it) };
    }
    fit() {
      const items = YVN.liveItems(this.board);
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
      const keep = new Set();
      for (const it of live) {
        keep.add(it.id);
        let e = this.els.get(it.id);
        const s = it.type === 'board' ? this.sums[it.boardId] || {} : {};
        const sig = [it.updatedAt, it.type === 'board' ? [s.title, s.color, s.itemCount] : '', it.image && it.image.editedAt].join('|');
        if (!e || (e._sig !== sig && this.editing !== it.id)) {
          const fresh = this._card(it);
          fresh._sig = sig;
          if (e) e.replaceWith(fresh); else this.layer.append(fresh);
          this.els.set(it.id, fresh); e = fresh;
        }
        e._item = it;
        if (!e.classList.contains('yb-dragging')) { e.style.left = it.x + 'px'; e.style.top = it.y + 'px'; }
        e.style.width = (it.w || YVN.CARD_W[it.type] || 240) + 'px';
      }
      for (const [id, e] of this.els) if (!keep.has(id)) { e.remove(); this.els.delete(id); this.sel.delete(id); }
      this._paintSel();
      const msg = this.boardId === HOME
        ? '這裡是首頁。按「Board」建立第一個 Board，例如「DaVinci 調色」。'
        : this.o.capture ? '按「截圖」把目前影片畫面放進這個 Board，或按「總結」寫整部影片的心得。' : '雙擊空白處新增筆記，或從工具列新增卡片、Board。';
      this.empty.textContent = msg;
      this.empty.hidden = live.length > 0;
    }
    _paintSel() { for (const [id, e] of this.els) e.classList.toggle('yb-sel', this.sel.has(id)); }

    _card(it) {
      const c = el('div', { class: `yb-item yb-${it.type}`, dataset: { id: it.id } });
      if (it.color && it.type !== 'board') c.append(el('div', { class: 'yb-cbar', style: `background:${it.color}` }));
      if (it.type === 'note') {
        if (it.video) c.append(el('button', { class: 'yb-src', dataset: { act: 'video' }, title: '回到影片：' + it.video.title }, icon('play', 12), el('b', {}, '總結'), el('span', {}, it.video.title || '')));
        c.append(this._md(it.text, '雙擊輸入文字…'));
      } else if (it.type === 'shot' || it.type === 'image') {
        const img = el('img', { alt: it.text ? it.text.slice(0, 60) : '截圖', draggable: 'false' });
        const wrap = el('div', { class: 'yb-imgwrap', style: it.image && it.image.w ? `aspect-ratio:${it.image.w}/${it.image.h}` : '' }, img);
        if (it.image && it.image.edits) wrap.append(el('span', { class: 'yb-edited', title: '已標註／裁切' }, '✎'));
        c.append(wrap);
        this._loadImg(it, img);
        const foot = el('div', { class: 'yb-foot' });
        if (it.type === 'shot' && it.ts != null) foot.append(el('button', { class: 'yb-ts', dataset: { act: 'seek' }, title: it.video ? `跳到 ${it.video.title} 的這個時間點` : '跳到這個時間點' }, YVN.fmtTime(it.ts)));
        if (it.text) foot.append(this._md(it.text));
        else foot.append(el('span', { class: 'yb-ph yb-capph' }, '雙擊加說明'));
        c.append(foot);
      } else if (it.type === 'board') {
        const s = this.sums[it.boardId] || {};
        c.append(el('div', { class: 'yb-bicon', style: `background:${s.color || '#8b8d98'}` }, el('i'), el('i'), el('i'), el('i')),
          el('div', { class: 'yb-btitle' }, s.title || (s.id ? '未命名' : '同步中…')),
          el('div', { class: 'yb-bcount' }, s.itemCount != null ? `${s.itemCount} 張卡片` : ''));
      } else if (it.type === 'link') {
        const vid = ytId(it.url);
        if (vid) c.append(el('div', { class: 'yb-imgwrap yb-yt', title: '雙擊開啟影片' }, el('img', { src: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`, alt: '', draggable: 'false' }), el('span', { class: 'yb-playbadge' }, icon('play', 18))));
        c.append(el('div', { class: 'yb-linkbody' },
          !vid && el('span', { class: 'yb-linkic' }, icon('link', 18)),
          el('div', { class: 'yb-linktxt' }, el('a', { href: it.url || '#', target: '_blank', rel: 'noopener noreferrer', dataset: { act: 'open' } }, it.title || it.url || '（空白連結）'), el('small', {}, host(it.url)))));
      }
      c.append(el('button', { class: 'yb-more', title: '選單', 'aria-label': '卡片選單', dataset: { act: 'menu' } }, icon('more', 16)));
      if (it.type !== 'board') c.append(el('div', { class: 'yb-rs', title: '拖曳調整寬度' }));
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
      if (url) img.src = url; else img.alt = '圖片尚未同步';
    }

    // ---------- interactions ----------
    _bind() {
      const vp = this.vp;
      vp.addEventListener('pointerdown', (e) => this._down(e));
      vp.addEventListener('dblclick', (e) => this._dbl(e));
      vp.addEventListener('click', (e) => this._click(e));
      vp.addEventListener('contextmenu', (e) => {
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
        const files = [...(e.dataTransfer.files || [])].filter((f) => /^image\//.test(f.type));
        if (!files.length) return;
        e.preventDefault();
        this._addFiles(files, this._toBoard(e.clientX, e.clientY));
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
      document.addEventListener('pointerdown', (e) => { if (!this.menu.hidden && !this.menu.contains(e.target)) this._closeMenu(); }, true);
    }

    _down(e) {
      if (e.button !== 0 && e.button !== 1) return;
      const t = e.target;
      if (t.closest('textarea, input, .yb-editbox')) return;
      if (!this.menu.hidden) this._closeMenu();
      const card = t.closest('.yb-item');
      if (this.editing && (!card || card.dataset.id !== this.editing)) this.commitEdit();
      if (t.closest('[data-act], a, .yb-md input')) return;
      const start = { x: e.clientX, y: e.clientY };
      if (card && e.button === 0) {
        const id = card.dataset.id;
        if (t.classList.contains('yb-rs')) {
          this.gesture = { kind: 'resize', id, start, w: card.offsetWidth / 1, el: card };
        } else {
          if (e.shiftKey || e.ctrlKey || e.metaKey) { this.sel.has(id) ? this.sel.delete(id) : this.sel.add(id); }
          else if (!this.sel.has(id)) this.sel = new Set([id]);
          this._paintSel();
          const orig = new Map();
          for (const sid of this.sel) { const it = this.board.items.find((i) => i.id === sid); if (it) orig.set(sid, { x: it.x, y: it.y }); }
          this.gesture = { kind: 'drag', id, start, orig, moved: false };
        }
      } else if (e.shiftKey && e.button === 0) {
        this.gesture = { kind: 'marquee', start, base: new Set(this.sel) };
      } else {
        if (!e.shiftKey) { this.sel.clear(); this._paintSel(); }
        this.gesture = { kind: 'pan', start, vx: this.view.x, vy: this.view.y, moved: false };
        this.vp.classList.add('yb-panning');
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
      } else if (gst.kind === 'drag') {
        if (!gst.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
        if (!gst.moved) { gst.moved = true; for (const id of gst.orig.keys()) { const c = this.els.get(id); if (c) { c.classList.add('yb-dragging'); this.layer.append(c); } } }
        for (const [id, o] of gst.orig) { const c = this.els.get(id); if (c) { c.style.left = o.x + dx / this.view.z + 'px'; c.style.top = o.y + dy / this.view.z + 'px'; } }
        const under = document.elementFromPoint(e.clientX, e.clientY);
        const target = under && under.closest('.yb-board');
        const tid = target && !gst.orig.has(target.dataset.id) ? target : null;
        if (gst.drop !== tid) { if (gst.drop) gst.drop.classList.remove('yb-drop'); if (tid) tid.classList.add('yb-drop'); gst.drop = tid; }
        this._edgePan(e);
      } else if (gst.kind === 'resize') {
        gst.el.style.width = clamp(gst.w + dx / this.view.z, 120, 900) + 'px';
      } else if (gst.kind === 'marquee') {
        const r = this.vp.getBoundingClientRect();
        const x1 = Math.min(gst.start.x, e.clientX), y1 = Math.min(gst.start.y, e.clientY);
        Object.assign(this.marquee.style, { left: x1 - r.left + 'px', top: y1 - r.top + 'px', width: Math.abs(dx) + 'px', height: Math.abs(dy) + 'px' });
        this.marquee.hidden = false;
        const a = this._toBoard(x1, y1), b = this._toBoard(Math.max(gst.start.x, e.clientX), Math.max(gst.start.y, e.clientY));
        this.sel = new Set(gst.base);
        for (const it of YVN.liveItems(this.board)) {
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
      if (gst.kind === 'resize') {
        const w = Math.round(parseFloat(gst.el.style.width));
        await this.api.patchItems(this.boardId, [{ id: gst.id, w }]);
        return this.reload();
      }
      if (gst.kind === 'drag') {
        const ids = [...gst.orig.keys()];
        for (const id of ids) { const c = this.els.get(id); if (c) c.classList.remove('yb-dragging'); }
        if (!gst.moved) {
          const it = this.board.items.find((i) => i.id === gst.id);
          if (it && it.type === 'board' && !(e.shiftKey || e.ctrlKey || e.metaKey)) this.open(it.boardId);
          return;
        }
        if (gst.drop) {
          const targetId = gst.drop.dataset.id;
          gst.drop.classList.remove('yb-drop');
          const tItem = this.board.items.find((i) => i.id === targetId);
          await this._moveInto(ids, tItem.boardId);
          return;
        }
        const patches = ids.map((id) => { const c = this.els.get(id); return { id, x: snap(parseFloat(c.style.left)), y: snap(parseFloat(c.style.top)) }; });
        await this.api.patchItems(this.boardId, patches);
        return this.reload();
      }
    }

    async _moveInto(ids, targetBoardId) {
      const target = await this.api.getBoard(targetBoardId);
      const items = target ? YVN.liveItems(target).slice() : [];
      const positions = {};
      let after = items.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).pop();
      for (const id of ids) {
        const it = this.board.items.find((i) => i.id === id);
        if (!it) continue;
        const s = this._rectOf(it);
        const p = YVN.findSlot(items, s.w, s.h, { after, maxW: 1000 });
        positions[id] = p;
        const placed = { ...it, ...p };
        items.push(placed); after = placed;
      }
      await this.api.moveItems(this.boardId, targetBoardId, ids, positions);
      this.sel.clear();
      this.toast(`已移到「${this._title(targetBoardId)}」`);
      return this.reload();
    }

    _click(e) {
      const t = e.target;
      const card = t.closest('.yb-item');
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
      await this.api.putItem(this.boardId, { id, text: YVN.toggleTask(it.text, n) });
      this.reload();
    }

    _dbl(e) {
      const t = e.target;
      if (t.closest('textarea, input, [data-act]')) return;
      const card = t.closest('.yb-item');
      if (!card) {
        const p = this._toBoard(e.clientX, e.clientY);
        return this._addNote({ x: snap(p.x - 20), y: snap(p.y - 20) });
      }
      const it = card._item;
      if (it.type === 'note') return this.startEdit(it.id);
      if (it.type === 'shot' || it.type === 'image') {
        if (t.closest('.yb-imgwrap')) return this.openEditor(it.id);
        return this.startEdit(it.id);
      }
      if (it.type === 'link') return t.closest('.yb-yt') ? window.open(it.url, '_blank', 'noopener') : this.startEdit(it.id);
    }

    _key(e) {
      if (e.target.closest('textarea, input')) return;
      if (e.key === 'Escape') { this._closeMenu(); this.toggleSearch(false); this.sel.clear(); this._paintSel(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel.size) { e.preventDefault(); this.deleteSelected(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); this.sel = new Set(YVN.liveItems(this.board).map((i) => i.id)); this._paintSel(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); this.toggleSearch(true); return; }
      if (e.key === 'Enter' && this.sel.size === 1) {
        const it = this.board.items.find((i) => i.id === [...this.sel][0]);
        if (it && it.type === 'board') this.open(it.boardId);
        else if (it) this.startEdit(it.id);
        e.preventDefault();
      }
    }

    async deleteSelected() {
      const ids = [...this.sel];
      if (!ids.length) return;
      const boards = ids.map((id) => this.board.items.find((i) => i.id === id)).filter((i) => i && i.type === 'board');
      if (boards.length && !confirm(`刪除 ${boards.map((b) => '「' + this._title(b.boardId) + '」').join('、')} 會一併刪除裡面所有卡片，確定嗎？`)) return;
      await this.api.deleteItems(this.boardId, ids);
      this.sel.clear();
      this.reload();
    }

    // ---------- menus ----------
    _menuAt(anchor, entries, above) {
      this.menu.replaceChildren(...entries.map((m) => m.colors
        ? el('div', { class: 'yb-colors' }, ...m.colors.map((c) => el('button', { class: 'yb-color' + (c ? '' : ' yb-nocolor'), title: c || '無顏色', 'aria-label': c || '無顏色', style: c ? `background:${c}` : '', onclick: () => { this._closeMenu(); m.pick(c); } })))
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
      if (!multi) {
        if (it.type === 'board') entries.push({ label: '開啟', icon: 'board', run: () => this.open(it.boardId) }, { label: '重新命名', icon: 'note', run: () => this._renameCard(it) });
        if (it.type === 'note' || it.type === 'shot' || it.type === 'image') entries.push({ label: it.type === 'note' ? '編輯文字' : '編輯說明', icon: 'note', run: () => this.startEdit(it.id) });
        if (it.type === 'shot' || it.type === 'image') entries.push({ label: '開啟標註編輯器', icon: 'image', run: () => this.openEditor(it.id) });
        if (it.type === 'shot' && it.ts != null) entries.push({ label: '跳到影片 ' + YVN.fmtTime(it.ts), icon: 'play', run: () => this._seek(it.video, it.ts) });
        if (it.type === 'link') entries.push({ label: '開啟連結', icon: 'link', run: () => window.open(it.url, '_blank', 'noopener') }, { label: '編輯網址', icon: 'note', run: () => this.startEdit(it.id) });
      }
      const boardsHere = YVN.liveItems(this.board).filter((x) => x.type === 'board' && !ids.includes(x.id));
      if (boardsHere.length) entries.push({ label: '移到 Board…', icon: 'board', run: () => this._menuAt(anchor, boardsHere.map((b) => ({ label: this._title(b.boardId), icon: 'board', run: () => this._moveInto(ids, b.boardId) }))) });
      if (this.boardId !== HOME) {
        const parent = (this.sums[this.boardId] || this.board).parentId || HOME;
        entries.push({ label: `移到上一層（${this._title(parent)}）`, icon: 'home', run: () => this._moveInto(ids, parent) });
      }
      entries.push({
        colors: [null, ...YVN.BOARD_COLORS],
        pick: async (c) => {
          if (!multi && it.type === 'board') await this.api.updateBoard(it.boardId, { color: c || '#8b8d98' });
          else await this.api.patchItems(this.boardId, ids.map((x) => ({ id: x, color: c })));
          this.reload();
        },
      });
      entries.push({ sep: true }, { label: multi ? `刪除 ${ids.length} 張卡片` : '刪除', danger: true, run: () => this.deleteSelected() });
      this._menuAt(anchor, entries);
    }

    // ---------- inline editing ----------
    startEdit(id) {
      const it = this.board.items.find((i) => i.id === id);
      const c = this.els.get(id);
      if (!it || !c) return;
      if (this.editing && this.editing !== id) this.commitEdit();
      this.editing = id;
      c.classList.add('yb-editing');
      if (it.type === 'link') {
        const inp = el('input', { class: 'yb-input', type: 'url', value: it.url || '', placeholder: '貼上網址，例如 YouTube 影片連結' });
        const box = el('div', { class: 'yb-editbox' }, inp);
        c.querySelector('.yb-linkbody').replaceWith(box);
        const yt = c.querySelector('.yb-yt'); if (yt) yt.remove();
        this._edit = { it, get: () => inp.value.trim(), field: 'url' };
        inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); this.commitEdit(); } });
        inp.focus();
        return;
      }
      const ta = el('textarea', { class: 'yb-ta', rows: '2', placeholder: it.type === 'note' ? (it.video ? '整部影片的重點、結論…' : '輸入筆記（支援 Markdown、#標籤、[[連結]]）') : '截圖說明…' });
      ta.value = it.text || '';
      const grow = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
      ta.addEventListener('input', grow);
      ta.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); this.commitEdit(); }
      });
      ta.addEventListener('blur', () => setTimeout(() => { if (this.editing === id && document.activeElement !== ta) this.commitEdit(); }, 120));
      const target = it.type === 'note' ? c.querySelector('.yb-md') : c.querySelector('.yb-foot .yb-md, .yb-foot .yb-capph');
      if (target) target.replaceWith(ta); else c.append(ta);
      this._edit = { it, get: () => ta.value, field: 'text' };
      grow(); ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    }

    async commitEdit() {
      const ed = this._edit;
      const id = this.editing;
      this.editing = null; this._edit = null;
      if (!ed || !id) return;
      const c = this.els.get(id);
      if (c) c.classList.remove('yb-editing');
      const val = ed.get();
      const it = ed.it;
      if (it.type === 'note' && !val.trim() && this._fresh === id) {
        await this.api.deleteItems(this.boardId, [id]);
      } else if (it.type === 'link' && !val) {
        if (this._fresh === id) await this.api.deleteItems(this.boardId, [id]);
      } else if (val !== (it[ed.field] || '')) {
        const patch = { id, [ed.field]: val };
        if (ed.field === 'url') { patch.url = /^https?:\/\//.test(val) ? val : 'https://' + val; patch.title = await this._linkTitle(patch.url); }
        await this.api.putItem(this.boardId, patch);
      }
      this._fresh = null;
      if (c) c._sig = null; // force re-render of this card
      await this.reload();
    }

    async _linkTitle(url) {
      const vid = ytId(url);
      if (!vid) return host(url);
      try {
        const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + vid)}`);
        if (r.ok) return (await r.json()).title || url;
      } catch (e) { /* CORS / offline */ }
      return 'YouTube 影片';
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
      return YVN.liveItems(this.board).slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).pop() || null;
    }
    _slot(w, h, at) {
      if (at) return at;
      const v = this._visible();
      const items = YVN.liveItems(this.board);
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
        if (!video) return this.toast('請先開啟一部 YouTube 影片');
        return this._addNote({ video, color: '#f5a524' });
      }
      if (act === 'note') return this._addNote({});
      if (act === 'todo') return this._addNote({ text: '**待辦**\n- [ ] ', w: 240 });
      if (act === 'board') return this._addBoard();
      if (act === 'link') return this._addLink('');
      if (act === 'upload') return this.fileInput.click();
    }

    async _addNote(o) {
      const w = o.w || YVN.CARD_W.note;
      const p = this._slot(w, 120, o.x != null ? { x: o.x, y: o.y } : null);
      const it = await this.api.putItem(this.boardId, { type: 'note', text: o.text || '', video: o.video, color: o.color, w, ...p });
      await this.reload();
      this.focusItem(it.id, false);
      if (o.edit !== false) { this._fresh = it.id; this.startEdit(it.id); }
      return it;
    }
    async _addBoard() {
      const p = this._slot(YVN.CARD_W.board, 120);
      const { item } = await this.api.createBoard(this.boardId, { ...p, title: '新 Board', color: YVN.BOARD_COLORS[Math.floor(Math.random() * 8)] });
      await this.reload();
      this.focusItem(item.id, false);
      this._renameCard(item);
    }
    async _addLink(url) {
      const p = this._slot(YVN.CARD_W.link, url ? 200 : 64);
      const it = await this.api.putItem(this.boardId, { type: 'link', url, title: url ? await this._linkTitle(url) : '', w: YVN.CARD_W.link, ...p });
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
      const it = await this.api.putItem(this.boardId, {
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

    async _addFiles(files, at) {
      let pos = at ? { x: snap(at.x), y: snap(at.y) } : null;
      for (const f of files) {
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
        const it = await this.api.putItem(this.boardId, {
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

    destroy() { if (this._unsub) this._unsub(); }
  }

  YVN.BoardView = BoardView;
  YVN.boardIcon = icon;
  YVN.el = el;
})(typeof self !== 'undefined' ? self : globalThis);
