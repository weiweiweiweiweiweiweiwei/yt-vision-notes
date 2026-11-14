/* YT-Vision-Notes — core: schema, helpers, merge logic.
 * Classic script (no modules) so it loads in content scripts, service workers and web pages alike. */
(function (g) {
  'use strict';
  const YVN = (g.YVN = g.YVN || {});

  YVN.SCHEMA_VERSION = 2;
  YVN.HOME = 'home';
  YVN.ROOT_FOLDER = 'YT-Vision-Notes';

  // v1 categories — only used to migrate old data into boards
  YVN.DEFAULT_CATEGORIES = [
    { id: 'cat_davinci', name: 'DaVinci 調色', color: '#e5484d', updatedAt: 0 },
    { id: 'cat_english', name: '英文學習', color: '#3e63dd', updatedAt: 0 },
    { id: 'cat_art', name: '繪畫藝術', color: '#30a46c', updatedAt: 0 },
  ];

  YVN.uid = (prefix) =>
    (prefix || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  YVN.fmtTime = (sec) => {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
  };

  YVN.fmtDate = (ms) => {
    const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  YVN.escapeHtml = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  YVN.normTag = (t) => String(t || '').trim().replace(/^#+/, '').replace(/\s+/g, '');

  /** Extract inline #tags from note text ("# heading" with a space is not a tag). */
  YVN.extractTags = (text) => {
    const out = [];
    const re = /(^|[\s(（])#([\p{L}\p{N}_\-]+)/gu;
    let m;
    while ((m = re.exec(text || ''))) out.push(m[2]);
    return out;
  };

  YVN.uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));

  // Trusted Types safe innerHTML (YouTube enforces Trusted Types).
  let ttPolicy = null;
  try {
    if (g.trustedTypes && g.trustedTypes.createPolicy) {
      ttPolicy = g.trustedTypes.createPolicy('yvn-html', { createHTML: (s) => s });
    }
  } catch (e) { /* policy unavailable — fall back to plain strings */ }
  YVN.setHTML = (el, html) => {
    el.innerHTML = ttPolicy ? ttPolicy.createHTML(html) : html;
    return el;
  };

  YVN.blobToDataURL = (blob) =>
    new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
  YVN.dataURLToBlob = async (dataURL) => (await fetch(dataURL)).blob();

  // ---------- schema factories ----------
  YVN.emptyIndex = () => ({
    schemaVersion: YVN.SCHEMA_VERSION,
    updatedAt: 0,
    categories: YVN.DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    tags: {},
    videos: {},
  });

  YVN.emptyVideo = (videoId) => ({
    schemaVersion: YVN.SCHEMA_VERSION,
    videoId,
    title: '',
    channel: '',
    url: `https://www.youtube.com/watch?v=${videoId}`,
    duration: 0,
    categoryId: null,
    metaUpdatedAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    deleted: false,
    notes: [],
  });

  YVN.liveNotes = (video) => (video.notes || []).filter((n) => !n.deleted).sort((a, b) => a.ts - b.ts || a.createdAt - b.createdAt);

  /** Summary stored in index.json for fast library loading. */
  YVN.summarize = (video) => {
    const notes = YVN.liveNotes(video);
    return {
      videoId: video.videoId,
      title: video.title,
      channel: video.channel,
      categoryId: video.categoryId || null,
      noteCount: notes.length,
      imageCount: notes.reduce((n, x) => n + (x.images || []).length, 0),
      tags: YVN.uniq(notes.flatMap((n) => n.tags || [])),
      createdAt: video.createdAt,
      updatedAt: video.updatedAt,
      deleted: !!video.deleted,
    };
  };

  // ---------- merge (last-write-wins per record, tombstones kept) ----------
  YVN.mergeCategories = (a, b) => {
    const map = new Map();
    for (const c of [...(a || []), ...(b || [])]) {
      const prev = map.get(c.id);
      if (!prev || (c.updatedAt || 0) > (prev.updatedAt || 0)) map.set(c.id, c);
    }
    return [...map.values()];
  };

  function mergeNote(win, lose) {
    // keep Drive file ids that only the losing side knows about
    const li = new Map((lose.images || []).map((i) => [i.id, i]));
    for (const img of win.images || []) {
      const o = li.get(img.id);
      if (!o) continue;
      if (!img.fileId && o.fileId) img.fileId = o.fileId;
      if (!img.editedFileId && o.editedFileId) img.editedFileId = o.editedFileId;
    }
    return win;
  }

  YVN.mergeVideo = (local, remote) => {
    if (!local) return remote;
    if (!remote) return local;
    const out = { ...local };
    if ((remote.metaUpdatedAt || 0) > (local.metaUpdatedAt || 0)) {
      for (const k of ['title', 'channel', 'url', 'duration', 'categoryId', 'metaUpdatedAt', 'deleted']) out[k] = remote[k];
    }
    out.createdAt = Math.min(local.createdAt || Infinity, remote.createdAt || Infinity);
    const map = new Map();
    for (const n of local.notes || []) map.set(n.id, n);
    for (const n of remote.notes || []) {
      const p = map.get(n.id);
      if (!p) map.set(n.id, n);
      else map.set(n.id, (n.updatedAt || 0) > (p.updatedAt || 0) ? mergeNote(n, p) : mergeNote(p, n));
    }
    out.notes = [...map.values()];
    out.updatedAt = Math.max(local.updatedAt || 0, remote.updatedAt || 0);
    return out;
  };

  // =====================================================================================
  // v2: boards (Milanote-style whiteboards). Every board is one JSON doc on Drive.
  //   board = { id, title, color, parentId, createdAt, updatedAt, metaUpdatedAt, deleted, items: [item] }
  //   item  = { id, type, x, y, w, color, createdAt, updatedAt, deleted, ...type fields }
  //     note  : text, video?            (video set → "總結筆記" for a whole video)
  //     shot  : text (caption), ts, video, image {id,w,h,fileId,editedFileId,edits,editedAt}
  //     image : text, image             (pasted / uploaded picture, no timestamp)
  //     board : boardId                 (link card to a child board)
  //     link  : url, title
  //   video = { id, title, channel }
  // =====================================================================================
  YVN.BOARD_COLORS = ['#e5484d', '#f76b15', '#f5a524', '#30a46c', '#12a594', '#3e63dd', '#8e4ec6', '#d6409f', '#8b8d98'];
  YVN.CARD_W = { note: 260, shot: 240, image: 240, board: 120, link: 240, column: 300, color: 160, comment: 280, todo: 300, heading: 420, table: 380, sketch: 300, video: 360, map: 320, file: 260, audio: 300, doc: 240 };

  YVN.emptyBoard = (id, title, parentId) => {
    const now = Date.now();
    return {
      schemaVersion: YVN.SCHEMA_VERSION, id, title: title || '', color: YVN.BOARD_COLORS[5],
      parentId: parentId || null, createdAt: now, updatedAt: now, metaUpdatedAt: id === YVN.HOME ? 0 : now,
      deleted: false, items: [],
    };
  };
  YVN.liveItems = (b) => ((b && b.items) || []).filter((i) => !i.deleted);

  YVN.summarizeBoard = (b) => ({
    id: b.id, title: b.title, color: b.color, parentId: b.parentId || null,
    itemCount: YVN.liveItems(b).length, createdAt: b.createdAt, updatedAt: b.updatedAt, deleted: !!b.deleted,
  });

  /** Markdown → readable plain text (for search results, trash, previews). */
  YVN.plainText = (md) => String(md || '')
    .replace(/\[([^\]]+)\]\{#c_[\w-]+\}/g, '$1')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/^#{1,6}\s+/gm, '').replace(/^>\s?/gm, '')
    .replace(/->|<-|\*\*|~~|\+\+|==|`/g, '').replace(/(^|\s)\*(\S)/g, '$1$2').replace(/(\S)\*(\s|$)/g, '$1$2');
  YVN.fmtSize = (n) => (!n ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  YVN.friendlyTime = (ms) => {
    const d = Date.now() - (ms || 0), m = Math.floor(d / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} h ago`;
    const days = Math.floor(h / 24);
    if (days < 7) return `${days} d ago`;
    const t = new Date(ms);
    return `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()}`;
  };
  YVN.itemText = (it) => [YVN.plainText(it.text), it.type === 'comment' ? (it.comments || []).map((c) => c.text).join(' ') : '', it.rows ? it.rows.flat().join(' ') : '', it.todos ? it.todos.map((t) => t.text).join(' ') : '', it.file && it.file.name, it.query, it.title, it.url, it.video && it.video.title, it.name, it.hex, it.label].filter(Boolean).join(' ');

  function mergeItem(win, lose) {
    const fa = win.file, fb = lose.file;
    if (fa && fb && fa.id === fb.id && !fa.fileId && fb.fileId) fa.fileId = fb.fileId;
    const a = win.image, b = lose.image;
    if (a && b && a.id === b.id) {
      if (!a.fileId && b.fileId) a.fileId = b.fileId;
      if (!a.editedFileId && b.editedFileId && a.editedAt === b.editedAt) a.editedFileId = b.editedFileId;
    }
    if (lose.removedFiles && lose.removedFiles.length) win.removedFiles = YVN.uniq([...(win.removedFiles || []), ...lose.removedFiles]);
    return win;
  }

  /** LWW per item; board meta (title/color/parent/deleted) LWW by metaUpdatedAt. */
  YVN.mergeBoard = (local, remote) => {
    if (!local) return remote;
    if (!remote) return local;
    const out = { ...local };
    if ((remote.metaUpdatedAt || 0) > (local.metaUpdatedAt || 0)) {
      for (const k of ['title', 'color', 'parentId', 'deleted', 'metaUpdatedAt']) out[k] = remote[k];
    }
    out.createdAt = Math.min(local.createdAt || Infinity, remote.createdAt || Infinity);
    const map = new Map();
    for (const it of local.items || []) map.set(it.id, it);
    for (const it of remote.items || []) {
      const p = map.get(it.id);
      if (!p) map.set(it.id, it);
      else map.set(it.id, (it.updatedAt || 0) > (p.updatedAt || 0) ? mergeItem({ ...it }, p) : mergeItem({ ...p }, it));
    }
    out.items = [...map.values()];
    out.updatedAt = Math.max(local.updatedAt || 0, remote.updatedAt || 0);
    return out;
  };

  // ---------- layout helpers (shared by the canvas UI and data-only callers) ----------
  /** Rough card size when the DOM is not available. */
  YVN.estimateSize = (it) => {
    const w = it.w || YVN.CARD_W[it.type] || 240;
    let h;
    if (it.type === 'shot' || it.type === 'image') {
      const im = it.image || {};
      h = Math.round(w * ((im.h || 9) / (im.w || 16))) + (it.type === 'shot' || it.text ? 34 : 0) + (it.text ? Math.ceil(it.text.length / 18) * 20 : 0);
    } else if (it.type === 'board') h = 120;
    else if (it.type === 'line') return { w: 0, h: 0 };
    else if (it.type === 'column') h = 300;
    else if (it.type === 'color') h = 160;
    else if (it.type === 'comment') h = 60 + (it.comments || []).length * 70;
    else if (it.type === 'heading') h = 56;
    else if (it.type === 'todo') h = 40 + Math.max(1, (it.todos || []).length) * 34 + (it.title ? 36 : 0);
    else if (it.type === 'table') h = 40 + ((it.rows || []).length || 3) * 34;
    else if (it.type === 'sketch') h = Math.round(w * (it.sh || 225) / 300);
    else if (it.type === 'video' || it.type === 'map') h = Math.round(w * 9 / 16) + 40;
    else if (it.type === 'file' || it.type === 'audio') h = it.type === 'audio' ? 110 : 64;
    else if (it.type === 'doc') h = 150;
    else if (it.type === 'ink') return { w: 0, h: 0 };
    else if (it.type === 'link') h = /youtu/.test(it.url || '') ? Math.round(w * 9 / 16) + 56 : 64;
    else h = 48 + Math.max(1, (it.text || '').split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / (w / 15))), 0)) * 22 + (it.video ? 26 : 0);
    return { w, h: Math.max(h, it.h || 0) };
  };

  /**
   * Find a free spot for a w×h card: right of `after`, else below it, else first free slot scanning rows.
   * sizeOf(item) → {w,h} (DOM measured when available). maxW limits how far right cards are placed.
   */
  YVN.findSlot = (items, w, h, opts) => {
    opts = opts || {};
    const gap = 20, sizeOf = opts.sizeOf || YVN.estimateSize;
    // lines have no box and cards inside a column are positioned by the column
    const rects = items.filter((i) => !i.deleted && i.type !== 'line' && i.type !== 'ink' && !i.col && i.x != null).map((i) => ({ x: i.x, y: i.y, ...sizeOf(i) }));
    const free = (x, y) => rects.every((r) => x + w + gap / 2 <= r.x || x >= r.x + r.w + gap / 2 || y + h + gap / 2 <= r.y || y >= r.y + r.h + gap / 2);
    const left = opts.left != null ? opts.left : 40, top = opts.top != null ? opts.top : 40;
    const maxW = opts.maxW || 1200;
    const a = opts.after && opts.after.type !== 'line' && opts.after.type !== 'ink' && !opts.after.col ? opts.after : null;
    if (a) {
      const s = sizeOf(a);
      const cands = [[a.x + s.w + gap, a.y], [left, a.y + s.h + gap], [a.x, a.y + s.h + gap]];
      for (const [x, y] of cands) if (x + w <= left + maxW && free(x, y)) return { x, y };
    }
    for (let y = top; y < top + 20000; y += gap) {
      for (let x = left; x + w <= left + Math.max(maxW, w); x += gap) if (free(x, y)) return { x, y };
    }
    return { x: left, y: top };
  };
})(typeof self !== 'undefined' ? self : globalThis);
