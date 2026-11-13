/* YT-Vision-Notes — core: schema, helpers, merge logic.
 * Classic script (no modules) so it loads in content scripts, service workers and web pages alike. */
(function (g) {
  'use strict';
  const YVN = (g.YVN = g.YVN || {});

  YVN.SCHEMA_VERSION = 1;
  YVN.ROOT_FOLDER = 'YT-Vision-Notes';

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
})(typeof self !== 'undefined' ? self : globalThis);
