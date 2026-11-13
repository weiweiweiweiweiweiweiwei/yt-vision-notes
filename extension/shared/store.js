/* YT-Vision-Notes — local IndexedDB cache + delta sync with Google Drive.
 * Used by the extension service worker and by the web app (each has its own IndexedDB; Drive is the shared truth).
 *
 * Object stores
 *   kv     : { k, v }                     categories, drive id cache, flags
 *   videos : video JSON + _dirty/_syncedAt (key: videoId)
 *   blobs  : { key: "<imageId>:orig|edit", videoId, blob, dirty, editedAt }
 */
(function (g) {
  'use strict';
  const YVN = (g.YVN = g.YVN || {});

  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('tx aborted')); });
  const strip = (v) => { const o = {}; for (const k in v) if (k[0] !== '_') o[k] = v[k]; return o; };

  class Store {
    constructor(name) {
      this.name = name || 'yvn';
      this.db = null;
      this.listeners = new Set();
      this._syncing = null;
      this._again = false;
    }

    onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    _emit(what) { for (const fn of this.listeners) { try { fn(what); } catch (e) { console.error(e); } } }

    async open() {
      if (this.db) return this.db;
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('kv', { keyPath: 'k' });
        db.createObjectStore('videos', { keyPath: 'videoId' });
        db.createObjectStore('blobs', { keyPath: 'key' }).createIndex('videoId', 'videoId');
      };
      this.db = await req(r);
      return this.db;
    }

    async _os(store, mode) { return (await this.open()).transaction(store, mode || 'readonly').objectStore(store); }
    async kvGet(k) { const r = await req((await this._os('kv')).get(k)); return r ? r.v : undefined; }
    async kvSet(k, v) { const os = await this._os('kv', 'readwrite'); os.put({ k, v }); return done(os.transaction); }
    async kvDel(k) { const os = await this._os('kv', 'readwrite'); os.delete(k); return done(os.transaction); }

    /** Persisted cache object for YVN.Drive (path → file id). */
    driveCache() {
      return {
        get: (k) => this.kvGet('drive:' + k),
        set: (k, v) => this.kvSet('drive:' + k, v),
        del: (k) => this.kvDel('drive:' + k),
      };
    }

    // ---------- categories ----------
    async getCategories(includeDeleted) {
      const list = (await this.kvGet('categories')) || YVN.DEFAULT_CATEGORIES.map((c) => ({ ...c }));
      return includeDeleted ? list : list.filter((c) => !c.deleted);
    }
    async upsertCategory(cat) {
      const list = await this.getCategories(true);
      const now = Date.now();
      const i = list.findIndex((c) => c.id === cat.id);
      const rec = { id: cat.id || YVN.uid('cat_'), name: cat.name, color: cat.color || '#8b8d98', updatedAt: now, deleted: false };
      if (i >= 0) list[i] = rec; else list.push(rec);
      await this.kvSet('categories', list);
      await this.kvSet('catsDirty', true);
      this._emit('categories');
      return rec;
    }
    async deleteCategory(id) {
      const list = await this.getCategories(true);
      const c = list.find((x) => x.id === id);
      if (!c) return;
      c.deleted = true; c.updatedAt = Date.now();
      await this.kvSet('categories', list);
      await this.kvSet('catsDirty', true);
      this._emit('categories');
    }

    // ---------- videos ----------
    async listVideos(includeDeleted) {
      const all = await req((await this._os('videos')).getAll());
      return includeDeleted ? all : all.filter((v) => !v.deleted);
    }
    async getVideo(id) { return (await req((await this._os('videos')).get(id))) || null; }

    /** Atomic read-modify-write. fn(video|null) returns the video to store (or null to skip). */
    async _update(videoId, fn) {
      const db = await this.open();
      const tx = db.transaction('videos', 'readwrite');
      const os = tx.objectStore('videos');
      const cur = (await req(os.get(videoId))) || null;
      const next = fn(cur);
      if (next) os.put(next);
      await done(tx);
      return next;
    }

    async _mutate(videoId, fn) {
      const v = await this._update(videoId, (cur) => {
        const v = cur || YVN.emptyVideo(videoId);
        if (fn(v) === false) return null;
        v.updatedAt = Date.now();
        v._dirty = true;
        return v;
      });
      this._emit('video:' + videoId);
      return v;
    }

    async _putBlob(imageId, which, videoId, blob, dirty, editedAt) {
      const os = await this._os('blobs', 'readwrite');
      os.put({ key: `${imageId}:${which}`, videoId, blob, dirty: !!dirty, editedAt: editedAt || 0 });
      return done(os.transaction);
    }
    async _getBlob(imageId, which) { return req((await this._os('blobs')).get(`${imageId}:${which}`)); }
    async _delBlob(imageId) {
      const os = await this._os('blobs', 'readwrite');
      os.delete(`${imageId}:orig`); os.delete(`${imageId}:edit`);
      return done(os.transaction);
    }

    /**
     * Create or update a note.
     * @param meta  { videoId, title, channel, duration, categoryId }
     * @param n     { id?, ts, text, tags[], images:[{id, ts, w, h, edits}] }
     * @param blobs { "<imageId>:orig": Blob, "<imageId>:edit": Blob }  (only new / changed ones)
     */
    async upsertNote(meta, n, blobs) {
      blobs = blobs || {};
      const now = Date.now();
      const noteId = n.id || YVN.uid('n_');
      for (const key of Object.keys(blobs)) {
        const [imageId, which] = key.split(':');
        await this._putBlob(imageId, which, meta.videoId, blobs[key], true, now);
      }
      let removed = [];
      const v = await this._mutate(meta.videoId, (v) => {
        if (v.deleted) { v.deleted = false; v.metaUpdatedAt = now; }
        for (const k of ['title', 'channel', 'duration']) {
          if (meta[k] && meta[k] !== v[k]) { v[k] = meta[k]; v.metaUpdatedAt = now; }
        }
        if (meta.categoryId !== undefined && meta.categoryId !== v.categoryId) { v.categoryId = meta.categoryId; v.metaUpdatedAt = now; }
        let note = v.notes.find((x) => x.id === noteId);
        const prev = new Map(((note && note.images) || []).map((i) => [i.id, i]));
        const images = (n.images || []).map((i) => {
          const p = prev.get(i.id) || {};
          prev.delete(i.id);
          return {
            id: i.id, ts: i.ts || 0, w: i.w || 0, h: i.h || 0,
            fileId: p.fileId || null, editedFileId: p.editedFileId || null,
            edits: i.edits || null,
            editedAt: i.edits ? (blobs[i.id + ':edit'] ? now : p.editedAt || now) : null,
          };
        });
        removed = [...prev.values()];
        const tags = YVN.uniq([...(n.tags || []), ...YVN.extractTags(n.text)].map(YVN.normTag));
        if (!note) { note = { id: noteId, createdAt: now }; v.notes.push(note); }
        Object.assign(note, {
          ts: n.ts != null ? n.ts : images[0] ? images[0].ts : 0,
          text: n.text || '', tags, images, updatedAt: now, deleted: false,
          removedFiles: [...(note.removedFiles || []), ...removed.flatMap((i) => [i.fileId, i.editedFileId]).filter(Boolean)],
        });
      });
      for (const i of removed) await this._delBlob(i.id);
      return { video: v, noteId };
    }

    async deleteNote(videoId, noteId) {
      return this._mutate(videoId, (v) => {
        const n = v.notes.find((x) => x.id === noteId);
        if (!n) return false;
        n.deleted = true; n.updatedAt = Date.now();
      });
    }

    async setVideoMeta(videoId, patch) {
      return this._mutate(videoId, (v) => { Object.assign(v, patch); v.metaUpdatedAt = Date.now(); });
    }
    async deleteVideo(videoId) {
      return this._mutate(videoId, (v) => {
        const now = Date.now();
        v.deleted = true; v.metaUpdatedAt = now;
        for (const n of v.notes) if (!n.deleted) { n.deleted = true; n.updatedAt = now; }
      });
    }

    /** Save annotation state + rendered WebP for one image (blob null & edits null = revert to original). */
    async saveImageEdit(videoId, noteId, imageId, edits, blob) {
      const now = Date.now();
      if (blob) await this._putBlob(imageId, 'edit', videoId, blob, true, now);
      return this._mutate(videoId, (v) => {
        const n = v.notes.find((x) => x.id === noteId);
        const img = n && n.images.find((i) => i.id === imageId);
        if (!img) return false;
        img.edits = edits || null;
        img.editedAt = edits ? now : null;
        n.updatedAt = now;
      });
    }

    /** Local-first image fetch; falls back to Drive and caches the result. which: 'orig' | 'edit' | undefined(auto) */
    async getImageBlob(videoId, img, which, drive) {
      which = which || (img.edits ? 'edit' : 'orig');
      const rec = await this._getBlob(img.id, which);
      const stale = rec && which === 'edit' && !rec.dirty && img.editedAt && rec.editedAt && rec.editedAt < img.editedAt;
      if (rec && !stale) return rec.blob;
      const fid = which === 'edit' ? img.editedFileId : img.fileId;
      if (fid && drive) {
        try {
          const blob = await drive.download(fid);
          await this._putBlob(img.id, which, videoId, blob, false, img.editedAt || 0);
          return blob;
        } catch (e) { console.warn('[YVN] image download failed', e); }
      }
      if (rec) return rec.blob;
      if (which === 'edit') return this.getImageBlob(videoId, img, 'orig', drive);
      return null;
    }

    async allTags() {
      const counts = {};
      for (const v of await this.listVideos())
        for (const n of YVN.liveNotes(v)) for (const t of n.tags || []) counts[t] = (counts[t] || 0) + 1;
      return counts;
    }

    async buildIndex() {
      const videos = {};
      for (const v of await this.listVideos(true)) videos[v.videoId] = YVN.summarize(v);
      return {
        schemaVersion: YVN.SCHEMA_VERSION,
        updatedAt: Date.now(),
        categories: await this.getCategories(true),
        tags: await this.allTags(),
        videos,
      };
    }

    // ---------- sync ----------
    /** Serialised: concurrent calls coalesce into one extra run. */
    sync(drive) {
      if (this._syncing) { this._again = true; return this._syncing; }
      this._syncing = (async () => {
        let result;
        try {
          do { this._again = false; result = await this._syncOnce(drive); } while (this._again);
        } finally { this._syncing = null; }
        return result;
      })();
      return this._syncing;
    }

    async _syncOnce(drive) {
      const layout = await drive.layout();
      const remoteIndex = await drive.readJSON('index.json', layout.root);
      let pulled = 0, pushed = 0;

      // 1) categories (LWW per category)
      if (remoteIndex && remoteIndex.categories) {
        const local = await this.getCategories(true);
        const merged = YVN.mergeCategories(local, remoteIndex.categories);
        if (JSON.stringify(merged) !== JSON.stringify(local)) { await this.kvSet('categories', merged); this._emit('categories'); }
      }

      // 2) pull videos whose remote stamp differs from what we last synced
      const remoteVideos = (remoteIndex && remoteIndex.videos) || {};
      for (const id of Object.keys(remoteVideos)) {
        const lv = await this.getVideo(id);
        if (lv && lv._syncedAt === remoteVideos[id].updatedAt) continue;
        const rv = await drive.readJSON(`${id}.json`, layout.videos);
        if (!rv) continue;
        await this._update(id, (cur) => {
          if (!cur) return { ...rv, _dirty: false, _syncedAt: rv.updatedAt };
          const m = YVN.mergeVideo(cur, rv);
          m._dirty = !!cur._dirty;
          m._syncedAt = cur._dirty ? cur._syncedAt : rv.updatedAt;
          return m;
        });
        pulled++;
        this._emit('video:' + id);
      }

      // 3) push dirty videos (images first so the JSON always references uploaded files)
      for (const v of await this.listVideos(true)) {
        if (!v._dirty && remoteVideos[v.videoId]) continue;
        const folder = await drive.ensureFolder(v.videoId, layout.images);
        const cleaned = [];
        for (const n of v.notes) {
          for (const fid of n.removedFiles || []) await drive.trash(fid);
          n.removedFiles = [];
          if (n.deleted) {
            if (!n.purged) {
              for (const img of n.images || []) {
                if (img.fileId) await drive.trash(img.fileId);
                if (img.editedFileId) await drive.trash(img.editedFileId);
                await this._delBlob(img.id);
              }
              n.images = []; n.purged = true;
            }
            continue;
          }
          for (const img of n.images || []) {
            const o = await this._getBlob(img.id, 'orig');
            if (o && (o.dirty || !img.fileId)) {
              img.fileId = await drive.upload(`${img.id}.webp`, folder, o.blob, img.fileId);
              cleaned.push([img.id, 'orig', o]);
            }
            if (img.edits) {
              const e = await this._getBlob(img.id, 'edit');
              if (e && (e.dirty || !img.editedFileId)) {
                img.editedFileId = await drive.upload(`${img.id}.edit.webp`, folder, e.blob, img.editedFileId);
                cleaned.push([img.id, 'edit', e]);
              }
            }
          }
        }
        await drive.writeJSON(`${v.videoId}.json`, layout.videos, strip(v));
        for (const [imageId, which, rec] of cleaned) {
          const now = await this._getBlob(imageId, which);
          if (now && now.editedAt === rec.editedAt) await this._putBlob(imageId, which, v.videoId, rec.blob, false, rec.editedAt);
        }
        // write back file ids; keep _dirty if the user changed the video while we were uploading
        const snapshot = v;
        await this._update(v.videoId, (cur) => {
          if (!cur) return null;
          if (cur.updatedAt === snapshot.updatedAt) return { ...snapshot, _dirty: false, _syncedAt: snapshot.updatedAt };
          const m = YVN.mergeVideo(cur, snapshot);
          m._dirty = true; m._syncedAt = cur._syncedAt;
          this._again = true;
          return m;
        });
        pushed++;
      }

      // 4) index.json
      const index = await this.buildIndex();
      const cmp = (i) => JSON.stringify(i ? [i.categories, i.videos, i.tags] : null);
      if (pushed || cmp(index) !== cmp(remoteIndex)) await drive.writeJSON('index.json', layout.root, index);
      await this.kvSet('catsDirty', false);
      await this.kvSet('lastSync', Date.now());
      this._emit('sync');
      return { pulled, pushed };
    }
  }

  YVN.Store = Store;
})(typeof self !== 'undefined' ? self : globalThis);
