/* YT-Vision-Notes — YouTube content script: player toggle button + in-page note workspace. */
(() => {
  'use strict';
  if (window.__yvnLoaded) return;
  window.__yvnLoaded = true;
  const YVN = self.YVN;

  // ---------- tiny DOM helper (no innerHTML → Trusted Types friendly) ----------
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k in n && k !== 'list') n[k] = v;
      else n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(c));
    return n;
  }

  async function send(type, data) {
    try {
      const r = await chrome.runtime.sendMessage({ type, ...(data || {}) });
      if (!r || !r.ok) throw new Error((r && r.error) || '擴充功能沒有回應');
      return r;
    } catch (e) {
      if (/context invalidated/i.test(e.message)) toast('擴充功能已更新，請重新整理此頁面');
      throw e;
    }
  }

  // ---------- state ----------
  const newDraft = () => ({ editingId: null, ts: null, images: [], tags: [] });
  const S = {
    on: false, videoId: null, video: null, categories: [], tags: {}, status: {},
    draft: newDraft(), pendingCat: undefined, thumbCache: new Map(),
  };
  const ui = {};

  const videoEl = () => document.querySelector('video.html5-main-video');
  const currentVideoId = () => (location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null);
  const text = (sel) => { const n = document.querySelector(sel); return n ? n.textContent.trim() : ''; };
  function videoMeta() {
    const v = videoEl();
    return {
      videoId: S.videoId,
      title: text('ytd-watch-metadata h1') || document.title.replace(/ - YouTube$/, '').replace(/^\(\d+\)\s*/, ''),
      channel: text('ytd-watch-metadata ytd-channel-name a') || text('#owner #channel-name a'),
      duration: v && isFinite(v.duration) ? Math.round(v.duration) : 0,
    };
  }
  function seek(ts) {
    const v = videoEl();
    if (!v) return;
    v.currentTime = ts;
    v.play().catch(() => {});
  }

  let toastTimer;
  function toast(msg) {
    if (!ui.toast) return;
    ui.toast.textContent = msg; ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 2600);
  }

  // ---------- capture ----------
  function captureFrame() {
    const v = videoEl();
    if (!v || !v.videoWidth) { toast('找不到影片畫面'); return null; }
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    try {
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height); // raw frame: no overlay, progress bar or controls
      const dataURL = c.toDataURL('image/webp', 0.92);
      return { id: YVN.uid('img_'), ts: Math.floor(v.currentTime), w: c.width, h: c.height, orig: dataURL, edited: null, edits: null, isNew: true };
    } catch (e) {
      toast('此影片受保護，無法擷取畫面'); // DRM / tainted canvas
      return null;
    }
  }
  function addCapture() {
    const img = captureFrame();
    if (!img) return false;
    S.draft.images.push(img);
    renderStrip();
    ui.capture.classList.remove('yvn-flash'); void ui.capture.offsetWidth; ui.capture.classList.add('yvn-flash');
    ui.strip.scrollLeft = ui.strip.scrollWidth;
    return true;
  }

  function grabCaption() {
    const segs = [...document.querySelectorAll('#movie_player .ytp-caption-segment')].map((n) => n.textContent.trim()).filter(Boolean);
    if (!segs.length) return toast('目前畫面沒有字幕（請先開啟 CC 字幕）');
    const v = videoEl();
    insertText(`> ${segs.join(' ')} [${YVN.fmtTime(v ? v.currentTime : 0)}]\n`);
  }
  function insertText(t) {
    const ta = ui.text, a = ta.selectionStart, b = ta.selectionEnd;
    const before = ta.value.slice(0, a);
    const pre = before && !before.endsWith('\n') && t.startsWith('>') ? '\n' : '';
    ta.value = before + pre + t + ta.value.slice(b);
    ta.selectionStart = ta.selectionEnd = a + pre.length + t.length;
    ta.focus();
  }

  // ---------- editor bridges ----------
  function openDraftEditor(index) {
    YVN.Editor.open({
      index,
      images: S.draft.images.map((d) => ({
        id: d.id, ts: d.ts, edits: d.edits,
        load: async () => d.orig || (d.orig = (await send('getImage', { videoId: S.videoId, noteId: S.draft.editingId, imageId: d.id, which: 'orig' })).dataURL),
      })),
      onSeek: seek,
      onSave: async (image, { edits, blob }) => {
        const d = S.draft.images.find((x) => x.id === image.id);
        d.edits = edits; d.edited = blob ? await YVN.blobToDataURL(blob) : null; d.editDirty = true;
        renderStrip();
      },
    });
  }
  function openNoteEditor(note, index) {
    YVN.Editor.open({
      index,
      images: note.images.map((i) => ({
        id: i.id, ts: i.ts, edits: i.edits,
        load: async () => (await send('getImage', { videoId: S.videoId, noteId: note.id, imageId: i.id, which: 'orig' })).dataURL,
      })),
      onSeek: seek,
      onSave: async (image, { edits, blob }) => {
        const r = await send('saveImageEdit', {
          videoId: S.videoId, noteId: note.id, imageId: image.id, edits, edited: blob ? await YVN.blobToDataURL(blob) : null,
        });
        S.video = r.video; renderNotes();
      },
    });
  }

  // ---------- draft: image strip ----------
  let dragFrom = -1;
  function renderStrip() {
    const d = S.draft;
    ui.strip.replaceChildren(
      ...d.images.map((img, i) => {
        const im = el('img', { alt: `截圖 ${YVN.fmtTime(img.ts)}`, draggable: false });
        const src = img.edited || img.orig;
        if (src) im.src = src; else loadThumb(im, { id: d.editingId }, img);
        return el('div', {
          class: 'yvn-thumb', draggable: true, title: '點擊放大 / 標註，拖曳可排序',
          onclick: () => openDraftEditor(i),
          ondragstart: (e) => { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; },
          ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('yvn-over'); },
          ondragleave: (e) => e.currentTarget.classList.remove('yvn-over'),
          ondrop: (e) => {
            e.preventDefault();
            if (dragFrom < 0 || dragFrom === i) return renderStrip();
            const [m] = d.images.splice(dragFrom, 1);
            d.images.splice(i, 0, m); dragFrom = -1; renderStrip();
          },
        },
          im,
          el('span', { class: 'yvn-badge' }, `${i + 1} · ${YVN.fmtTime(img.ts)}`),
          el('button', { class: 'yvn-x', title: '刪除這張', 'aria-label': '刪除這張截圖', onclick: (e) => { e.stopPropagation(); d.images.splice(i, 1); renderStrip(); } }, '×'));
      }),
    );
    ui.strip.hidden = !d.images.length;
    ui.stripHint.hidden = !!d.images.length;
  }

  // ---------- draft: tags ----------
  function renderTags() {
    ui.chips.replaceChildren(...S.draft.tags.map((t, i) =>
      el('span', { class: 'yvn-chip' }, '#' + t, el('button', { 'aria-label': `移除標籤 ${t}`, onclick: () => { S.draft.tags.splice(i, 1); renderTags(); } }, '×'))));
  }
  function addTag(raw) {
    const t = YVN.normTag(raw);
    if (t && !S.draft.tags.includes(t)) S.draft.tags.push(t);
    ui.tagInput.value = ''; renderTags(); renderSuggest();
  }
  let sugIdx = -1;
  function renderSuggest() {
    const q = YVN.normTag(ui.tagInput.value).toLowerCase();
    const focused = document.activeElement === ui.tagInput;
    const list = !focused ? [] : Object.entries(S.tags)
      .filter(([t]) => !S.draft.tags.includes(t) && (!q || t.toLowerCase().includes(q)))
      .sort((a, b) => b[1] - a[1]).slice(0, 8);
    sugIdx = Math.min(sugIdx, list.length - 1);
    ui.suggest.replaceChildren(...list.map(([t, n], i) =>
      el('li', { class: i === sugIdx ? 'on' : '', onmousedown: (e) => { e.preventDefault(); addTag(t); } }, '#' + t, el('small', {}, String(n)))));
    ui.suggest.hidden = !list.length;
    ui.suggest._list = list.map((x) => x[0]);
  }
  function onTagKey(e) {
    const list = ui.suggest._list || [];
    if (e.key === 'ArrowDown' && list.length) { e.preventDefault(); sugIdx = (sugIdx + 1) % list.length; renderSuggest(); }
    else if (e.key === 'ArrowUp' && list.length) { e.preventDefault(); sugIdx = (sugIdx - 1 + list.length) % list.length; renderSuggest(); }
    else if (e.key === 'Enter' || e.key === ' ' || e.key === ',' || e.key === 'Tab') {
      if (e.isComposing) return;
      const v = sugIdx >= 0 && list[sugIdx] ? list[sugIdx] : ui.tagInput.value;
      if (!YVN.normTag(v)) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveNote(); return; }
      e.preventDefault(); sugIdx = -1; addTag(v);
    } else if (e.key === 'Backspace' && !ui.tagInput.value && S.draft.tags.length) { S.draft.tags.pop(); renderTags(); }
    else if (e.key === 'Escape') { ui.tagInput.blur(); }
  }

  // ---------- save ----------
  let saving = false;
  async function saveNote() {
    if (saving || !S.videoId) return;
    const d = S.draft;
    if (ui.tagInput.value.trim()) addTag(ui.tagInput.value);
    const body = ui.text.value.trim();
    if (!d.images.length && !d.editingId) addCapture(); // "按送出就幫我截當下畫面"
    if (!body && !d.images.length) return toast('請先輸入筆記或點 [+] 擷取畫面');
    saving = true; ui.save.disabled = true; ui.save.textContent = '儲存中…';
    try {
      const v = videoEl();
      const meta = videoMeta();
      if (S.pendingCat !== undefined) meta.categoryId = S.pendingCat;
      const r = await send('saveNote', {
        meta,
        note: {
          id: d.editingId || undefined, text: body, tags: d.tags,
          ts: d.editingId ? d.ts : d.images.length ? Math.min(...d.images.map((i) => i.ts)) : Math.floor(v ? v.currentTime : 0),
        },
        images: d.images.map((i) => ({
          id: i.id, ts: i.ts, w: i.w, h: i.h, edits: i.edits,
          orig: i.isNew ? i.orig : null,
          edited: i.edits && (i.isNew || i.editDirty) ? i.edited : null,
        })),
      });
      S.video = r.video; S.tags = r.tags || S.tags; S.pendingCat = undefined;
      S.draft = newDraft(); ui.text.value = '';
      renderAll();
      toast(S.status.signedIn ? '已儲存，背景同步至 Google Drive' : '已儲存在本機（尚未登入 Google，請點右上角擴充功能圖示登入）');
    } catch (e) { toast('儲存失敗：' + e.message); }
    saving = false; ui.save.disabled = false; renderDraftMode();
  }

  function editNote(note) {
    S.draft = {
      editingId: note.id, ts: note.ts, tags: [...(note.tags || [])],
      images: note.images.map((i) => ({ id: i.id, ts: i.ts, w: i.w, h: i.h, edits: i.edits, orig: null, edited: null, isNew: false })),
    };
    ui.text.value = note.text || '';
    renderStrip(); renderTags(); renderDraftMode();
    ui.panel.scrollTop = 0; ui.text.focus();
  }
  function renderDraftMode() {
    const editing = !!S.draft.editingId;
    ui.save.textContent = editing ? '更新筆記' : '儲存筆記';
    ui.cancel.hidden = !editing;
    ui.draft.classList.toggle('yvn-editing', editing);
  }

  // ---------- saved notes ----------
  async function loadThumb(imgEl, note, img) {
    const key = `${img.id}:${img.editedAt || 0}`;
    let p = S.thumbCache.get(key);
    if (!p) {
      p = send('getImage', { videoId: S.videoId, noteId: note.id, imageId: img.id }).then((r) => r.dataURL).catch(() => null);
      S.thumbCache.set(key, p);
    }
    const url = await p;
    if (url) imgEl.src = url; else imgEl.alt = '（圖片尚未同步）';
  }

  function renderNotes() {
    const notes = S.video ? YVN.liveNotes(S.video) : [];
    ui.count.textContent = `本片筆記 · ${notes.length}`;
    if (!notes.length) {
      ui.notes.replaceChildren(el('p', { class: 'yvn-empty' }, '這部影片還沒有筆記。暫停在重點畫面，點上方的 [+] 擷取，寫下幾句話再按「儲存筆記」。'));
      return;
    }
    ui.notes.replaceChildren(...notes.map((n) => {
      const body = el('div', { class: 'yvn-md' });
      YVN.setHTML(body, YVN.renderMarkdown(n.text));
      return el('article', { class: 'yvn-note' },
        el('header', {},
          el('button', { class: 'yvn-tsbtn', title: '跳到此時間點', onclick: () => seek(n.ts) }, YVN.fmtTime(n.ts)),
          el('span', { class: 'yvn-grow' }),
          el('button', { class: 'yvn-icon', title: '編輯', 'aria-label': '編輯筆記', onclick: () => editNote(n) }, '✎'),
          el('button', {
            class: 'yvn-icon', title: '刪除', 'aria-label': '刪除筆記',
            onclick: async () => { if (confirm('確定刪除這則筆記與其截圖？')) { S.video = (await send('deleteNote', { videoId: S.videoId, noteId: n.id })).video; renderNotes(); } },
          }, '🗑')),
        n.images.length ? el('div', { class: 'yvn-strip yvn-saved' }, n.images.map((img, i) => {
          const im = el('img', { alt: `截圖 ${YVN.fmtTime(img.ts)}`, loading: 'lazy' });
          loadThumb(im, n, img);
          return el('div', { class: 'yvn-thumb', onclick: () => openNoteEditor(n, i) }, im,
            el('button', { class: 'yvn-badge', title: '跳到此時間點', onclick: (e) => { e.stopPropagation(); seek(img.ts); } }, YVN.fmtTime(img.ts)));
        })) : null,
        n.text ? body : null,
        n.tags && n.tags.length ? el('div', { class: 'yvn-tagrow' }, n.tags.map((t) => el('a', { class: 'yvn-tag', href: '#', 'data-tag': t }, '#' + t))) : null);
    }));
  }

  // ---------- categories ----------
  function renderCategory() {
    const cur = S.pendingCat !== undefined ? S.pendingCat : S.video ? S.video.categoryId : null;
    ui.cat.replaceChildren(
      el('option', { value: '' }, '未分類'),
      ...S.categories.map((c) => el('option', { value: c.id, selected: c.id === cur }, c.name)));
    ui.cat.value = cur || '';
    const c = S.categories.find((x) => x.id === cur);
    ui.catDot.style.background = c ? c.color : 'transparent';
  }
  async function onCategoryChange() {
    const categoryId = ui.cat.value || null;
    const r = await send('setCategory', { videoId: S.videoId, categoryId });
    if (r.video) S.video = r.video; else S.pendingCat = categoryId;
    renderCategory();
  }
  function renderCatManager() {
    const row = (c) => {
      const color = el('input', { type: 'color', value: c.color, title: '代表色' });
      const name = el('input', { type: 'text', value: c.name, placeholder: '分類名稱', maxLength: 30 });
      const commit = async () => {
        if (!name.value.trim()) return;
        S.categories = (await send('upsertCategory', { category: { id: c.id, name: name.value.trim(), color: color.value } })).categories;
        renderCategory();
      };
      color.addEventListener('change', commit); name.addEventListener('change', commit);
      return el('div', { class: 'yvn-catrow' }, color, name, el('button', {
        class: 'yvn-icon', title: '刪除分類', 'aria-label': '刪除分類',
        onclick: async () => {
          if (!confirm(`刪除分類「${c.name}」？（影片與筆記不會被刪除）`)) return;
          S.categories = (await send('deleteCategory', { id: c.id })).categories;
          renderCategory(); renderCatManager();
        },
      }, '🗑'));
    };
    const newName = el('input', { type: 'text', placeholder: '新增分類…', maxLength: 30 });
    const newColor = el('input', { type: 'color', value: '#f5a524' });
    const add = async () => {
      if (!newName.value.trim()) return;
      const r = await send('upsertCategory', { category: { name: newName.value.trim(), color: newColor.value } });
      S.categories = r.categories; renderCategory(); renderCatManager();
    };
    newName.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    ui.catMgr.replaceChildren(...S.categories.map(row), el('div', { class: 'yvn-catrow' }, newColor, newName, el('button', { class: 'yvn-btn', onclick: add }, '新增')));
  }

  function renderStatus() {
    const s = S.status;
    ui.sync.className = 'yvn-sync ' + (s.syncing ? 'busy' : s.error ? 'err' : s.signedIn ? 'ok' : 'off');
    ui.sync.title = s.syncing ? '同步中…' : s.error ? '同步失敗：' + s.error : s.signedIn ? `已連線 Google Drive${s.lastSync ? '，上次同步 ' + YVN.fmtDate(s.lastSync) : ''}（點擊立即同步）` : '尚未登入 Google（點擊登入）';
  }
  function renderAll() { renderCategory(); renderStrip(); renderTags(); renderNotes(); renderStatus(); renderDraftMode(); }

  // ---------- panel ----------
  function buildPanel() {
    ui.toast = el('div', { class: 'yvn-toast', hidden: true, role: 'status' });
    ui.cat = el('select', { class: 'yvn-cat', title: '影片主分類', 'aria-label': '影片主分類', onchange: onCategoryChange });
    ui.catDot = el('span', { class: 'yvn-dot' });
    ui.catMgr = el('div', { class: 'yvn-catmgr', hidden: true });
    ui.sync = el('button', {
      class: 'yvn-sync', 'aria-label': '同步狀態',
      onclick: async () => {
        try { S.status = (await send(S.status.signedIn ? 'syncNow' : 'signIn')).status; }
        catch (e) { toast('登入失敗：' + e.message + '（請確認 manifest.json 的 OAuth client_id）'); }
        renderStatus();
      },
    });
    ui.capture = el('button', { class: 'yvn-capture', title: '擷取目前影片畫面 (Alt+S)', onclick: addCapture }, el('b', {}, '+'), el('span', {}, '擷取畫面'));
    ui.strip = el('div', { class: 'yvn-strip', hidden: true });
    ui.stripHint = el('p', { class: 'yvn-hint' }, '先暫停在想記錄的畫面，再點 [+]。同一主題可連續擷取多張。');
    ui.text = el('textarea', {
      class: 'yvn-text', rows: 5, placeholder: '寫下重點…（支援 Markdown、#標籤、[[雙向連結]]，Ctrl+Enter 儲存）',
      onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveNote(); } },
    });
    ui.chips = el('span', { class: 'yvn-chips' });
    ui.tagInput = el('input', {
      class: 'yvn-taginput', type: 'text', placeholder: '#標籤（空白或 Enter 新增）', 'aria-label': '標籤',
      oninput: () => { sugIdx = -1; renderSuggest(); }, onfocus: renderSuggest, onblur: () => setTimeout(renderSuggest, 100), onkeydown: onTagKey,
    });
    ui.suggest = el('ul', { class: 'yvn-suggest', hidden: true });
    ui.save = el('button', { class: 'yvn-btn yvn-primary', onclick: saveNote }, '儲存筆記');
    ui.cancel = el('button', { class: 'yvn-btn', hidden: true, onclick: () => { S.draft = newDraft(); ui.text.value = ''; renderStrip(); renderTags(); renderDraftMode(); } }, '取消編輯');
    ui.count = el('h3', {}, '本片筆記');
    ui.notes = el('div', { class: 'yvn-notes' });
    ui.draft = el('section', { class: 'yvn-draft' },
      el('div', { class: 'yvn-row' },
        ui.capture,
        el('button', { class: 'yvn-btn', title: '把目前畫面上的 CC 字幕插入為引用', onclick: grabCaption }, '❝ CC 字幕'),
        el('button', { class: 'yvn-btn', title: '插入目前時間戳', onclick: () => { const v = videoEl(); insertText(`[${YVN.fmtTime(v ? v.currentTime : 0)}] `); } }, '⏱ 時間')),
      ui.stripHint, ui.strip, ui.text,
      el('div', { class: 'yvn-tagbox' }, ui.chips, ui.tagInput, ui.suggest),
      el('div', { class: 'yvn-row yvn-end' }, ui.cancel, ui.save));

    ui.panel = el('div', { id: 'yvn-panel' },
      el('header', { class: 'yvn-head' },
        el('strong', {}, 'Vision Notes'),
        ui.catDot, ui.cat,
        el('button', { class: 'yvn-icon', title: '管理分類', 'aria-label': '管理分類', onclick: () => { ui.catMgr.hidden = !ui.catMgr.hidden; if (!ui.catMgr.hidden) renderCatManager(); } }, '⚙'),
        el('span', { class: 'yvn-grow' }),
        el('button', {
          class: 'yvn-icon', title: '開啟知識庫網站', 'aria-label': '開啟知識庫網站',
          onclick: () => (S.status.webUrl ? window.open(`${S.status.webUrl.replace(/#.*$/, '')}#/video/${S.videoId}`, '_blank', 'noopener') : toast('請先在擴充功能圖示的彈出視窗設定知識庫網址')),
        }, '↗'),
        ui.sync,
        el('button', { class: 'yvn-icon', title: '關閉筆記模式', 'aria-label': '關閉筆記模式', onclick: () => setOn(false) }, '✕')),
      ui.catMgr, ui.draft,
      el('section', { class: 'yvn-list' }, ui.count, ui.notes),
      ui.toast);

    // keep YouTube hotkeys (k, j, f, space…) from firing while typing in the panel
    for (const t of ['keydown', 'keyup', 'keypress']) ui.panel.addEventListener(t, (e) => e.stopPropagation());
    ui.panel.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (!a || !ui.panel.contains(a)) return;
      if (a.classList.contains('yvn-ts')) { e.preventDefault(); seek(+a.dataset.ts); }
      else if (a.classList.contains('yvn-tag') || a.classList.contains('yvn-wikilink')) {
        e.preventDefault();
        const hash = a.dataset.tag ? `#/tag/${encodeURIComponent(a.dataset.tag)}` : `#/search/${encodeURIComponent(a.dataset.wikilink)}`;
        if (S.status.webUrl) window.open(S.status.webUrl.replace(/#.*$/, '') + hash, '_blank', 'noopener');
        else toast('設定知識庫網址後，點標籤可跨影片檢視');
      }
    });
  }

  function mountPanel() {
    const secondary = document.querySelector('ytd-watch-flexy #secondary');
    if (!secondary) return;
    if (!ui.panel) buildPanel();
    if (ui.panel.parentElement !== secondary) { secondary.prepend(ui.panel); renderAll(); }
  }

  function mountButton() {
    const bar = document.querySelector('#movie_player .ytp-right-controls');
    if (!bar || bar.querySelector('.yvn-toggle')) return;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36'); svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('fill', 'currentColor');
    // note page with a "+" badge
    path.setAttribute('d', 'M11 9h10l5 5v13a1 1 0 0 1-1 1H11a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zm1 2v15h12V15h-4v-4h-8zm2 7h3v-3h2v3h3v2h-3v3h-2v-3h-3v-2z');
    svg.appendChild(path);
    const btn = el('button', { class: 'ytp-button yvn-toggle', title: '截圖筆記模式 (Vision Notes)', 'aria-label': '截圖筆記模式', 'aria-pressed': String(S.on), onclick: () => setOn(!S.on) });
    btn.appendChild(svg);
    bar.prepend(btn);
  }

  function setOn(on) {
    S.on = on;
    document.documentElement.classList.toggle('yvn-on', on && !!S.videoId);
    const b = document.querySelector('.yvn-toggle');
    if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
    chrome.storage.local.set({ panelOn: on }).catch(() => {});
    if (on) { mountPanel(); loadVideo(true); }
    window.dispatchEvent(new Event('resize')); // let the player re-measure
  }

  async function loadVideo(force) {
    const id = currentVideoId();
    if (!force && id === S.videoId) return;
    const changed = id !== S.videoId;
    S.videoId = id;
    document.documentElement.classList.toggle('yvn-on', S.on && !!id);
    if (changed) { S.draft = newDraft(); S.video = null; S.pendingCat = undefined; S.thumbCache.clear(); if (ui.text) ui.text.value = ''; }
    if (!id || !S.on) return;
    try {
      const r = await send('getState', { videoId: id });
      if (id !== S.videoId) return;
      S.video = r.video; S.categories = r.categories; S.tags = r.tags; S.status = r.status;
      if (ui.panel) renderAll();
    } catch (e) { console.warn('[YVN]', e); }
  }

  // ---------- boot ----------
  function tick() {
    mountButton();
    if (currentVideoId() !== S.videoId) loadVideo();
    if (S.on && S.videoId) mountPanel();
  }
  document.addEventListener('yt-navigate-finish', tick);
  setInterval(tick, 1000);

  document.addEventListener('keydown', (e) => {
    if (S.on && S.videoId && e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyS') { e.preventDefault(); e.stopPropagation(); addCapture(); }
  }, true);

  function connect() {
    try {
      const port = chrome.runtime.connect({ name: 'yvn' });
      port.onMessage.addListener((m) => {
        if (m.type === 'status') { S.status = m.status; if (ui.panel) renderStatus(); }
        if (m.type === 'changed' && S.on) { S.thumbCache.clear(); loadVideo(true); }
      });
      port.onDisconnect.addListener(() => setTimeout(() => { if (chrome.runtime && chrome.runtime.id) connect(); }, 2000));
    } catch (e) { /* extension reloaded */ }
  }
  connect();

  chrome.storage.local.get('panelOn').then((r) => { S.on = !!r.panelOn; tick(); if (S.on) setOn(true); });
})();
