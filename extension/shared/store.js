/* YT-Vision-Notes — local IndexedDB cache + delta sync with Google Drive (schema v2: boards).
 * Used by the extension service worker and by the web app (each has its own IndexedDB; Drive is the shared truth).
 *
 * Object stores
 *   kv     : { k, v }                     drive id cache, flags, recent boards
 *   boards : board JSON + _dirty/_syncedAt (key: id)
 *   videos : v1 data (only read to migrate old notes into boards)
 *   blobs  : { key: "<imageId>:orig|edit", blob, dirty, editedAt }
 *
 * Drive layout: /YT-Vision-Notes/index.json, /boards/{boardId}.json, /images/{imageId}.webp|.edit.webp
 * (v1 files in /videos and /images/{videoId}/ are left untouched as a backup.)
 */
(function (g) {
  'use strict';
  const YVN = (g.YVN = g.YVN || {});

  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = (tx) => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('tx aborted')); });
  const strip = (v) => { const o = {}; for (const k in v) if (k[0] !== '_') o[k] = v[k]; return o; };
  const ITEM_KEYS = ['x', 'y', 'w', 'color', 'text', 'title', 'url', 'ts', 'video', 'image', 'boardId', 'comments', 'col', 'ord', 'from', 'to', 'arrow', 'label', 'hex', 'name', 'rows', 'strokes', 'sh', 'pts', 'size', 'query', 'file', 'collapsed', 'locked', 'h', 'bend'];
  const TRASH_MS = 30 * 24 * 3600 * 1000; // deleted cards keep their images this long (restorable from the trash)

  class Store {
    constructor(name) {
      this.name = name || 'yvn';
      this.db = null;
      this.listeners = new Set();
      this._syncing = null;
      this._again = false;
      this._migrated = null;
    }

    onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    _emit(what) { for (const fn of this.listeners) { try { fn(what); } catch (e) { console.error(e); } } }

    async open() {
      if (this.db) return this.db;
      const r = indexedDB.open(this.name, 2);
      r.onupgradeneeded = (ev) => {
        const db = r.result;
        if (ev.oldVersion < 1) {
          db.createObjectStore('kv', { keyPath: 'k' });
          db.createObjectStore('videos', { keyPath: 'videoId' });
          db.createObjectStore('blobs', { keyPath: 'key' }).createIndex('videoId', 'videoId');
        }
        if (ev.oldVersion < 2) db.createObjectStore('boards', { keyPath: 'id' });
      };
      this.db = await req(r);
      return this.db;
    }
    /** Open + one-time local migration of v1 data. Call once at startup before reading. */
    init() {
      if (!this._migrated) this._migrated = this.open().then(() => this._migrateLocal()).catch((e) => console.error('[YVN] migrate', e));
      return this._migrated;
    }

    async _os(store, mode) { return (await this.open()).transaction(store, mode || 'readonly').objectStore(store); }
    async kvGet(k) { const r = await req((await this._os('kv')).get(k)); return r ? r.v : undefined; }
    async kvSet(k, v) { const os = await this._os('kv', 'readwrite'); os.put({ k, v }); return done(os.transaction); }
    async kvDel(k) { const os = await this._os('kv', 'readwrite'); os.delete(k); return done(os.transaction); }

    driveCache() {
      return {
        get: (k) => this.kvGet('drive:' + k),
        set: (k, v) => this.kvSet('drive:' + k, v),
        del: (k) => this.kvDel('drive:' + k),
      };
    }

    // ---------- boards ----------
    async listBoards(includeDeleted) {
      const all = await req((await this._os('boards')).getAll());
      return includeDeleted ? all : all.filter((b) => !b.deleted);
    }
    async summaries() {
      const out = {};
      for (const b of await this.listBoards(true)) out[b.id] = YVN.summarizeBoard(b);
      if (!out[YVN.HOME]) out[YVN.HOME] = YVN.summarizeBoard(YVN.emptyBoard(YVN.HOME, 'Home'));
      return out;
    }
    async getBoard(id) {
      const b = await req((await this._os('boards')).get(id));
      if (b) return b;
      return id === YVN.HOME ? { ...YVN.emptyBoard(YVN.HOME, 'Home'), _virtual: true } : null;
    }

    /** Atomic read-modify-write on one board. fn(board|null) returns the board to store (or null to skip). */
    async _update(id, fn) {
      const db = await this.open();
      const tx = db.transaction('boards', 'readwrite');
      const os = tx.objectStore('boards');
      const cur = (await req(os.get(id))) || null;
      const next = fn(cur);
      if (next) os.put(next);
      await done(tx);
      return next;
    }
    async _mutate(id, fn) {
      const b = await this._update(id, (cur) => {
        const b = cur || (id === YVN.HOME ? YVN.emptyBoard(YVN.HOME, 'Home') : null);
        if (!b) return null;
        if (fn(b) === false) return null;
        b.updatedAt = Date.now();
        b._dirty = true;
        return b;
      });
      if (b) this._emit('board:' + id);
      return b;
    }

    async _putBlob(imageId, which, blob, dirty, editedAt) {
      const os = await this._os('blobs', 'readwrite');
      os.put({ key: `${imageId}:${which}`, blob, dirty: !!dirty, editedAt: editedAt || 0 });
      return done(os.transaction);
    }
    async _getBlob(imageId, which) { return req((await this._os('blobs')).get(`${imageId}:${which}`)); }
    async _delBlob(imageId) {
      const os = await this._os('blobs', 'readwrite');
      os.delete(`${imageId}:orig`); os.delete(`${imageId}:edit`);
      return done(os.transaction);
    }

    /** New child board + its link card inside the parent. */
    async createBoard(parentId, o) {
      o = o || {};
      const id = YVN.uid('b_');
      const now = Date.now();
      const board = { ...YVN.emptyBoard(id, o.title || 'New Board', parentId), color: o.color || YVN.BOARD_COLORS[5], _dirty: true };
      await this._update(id, () => board);
      const item = await this.putItem(parentId, { type: 'board', boardId: id, x: o.x || 40, y: o.y || 40, w: YVN.CARD_W.board, createdAt: now });
      this._emit('board:' + id);
      return { board: strip(board), item };
    }

    async updateBoard(id, patch) {
      return this._mutate(id, (b) => {
        for (const k of ['title', 'color']) if (patch[k] !== undefined) b[k] = patch[k];
        b.metaUpdatedAt = Date.now();
      });
    }

    /** Create or update one item. blobs: { orig?: Blob } for a new picture. */
    async putItem(boardId, it, blobs) {
      const now = Date.now();
      const id = it.id || YVN.uid('i_');
      const media = it.image || it.file; // pictures and uploaded files share the blob store
      if (blobs && blobs.orig && media) await this._putBlob(media.id, 'orig', blobs.orig, true, now);
      let saved = null;
      await this._mutate(boardId, (b) => {
        let cur = b.items.find((x) => x.id === id);
        if (!cur) { cur = { id, type: it.type, createdAt: it.createdAt || now }; b.items.push(cur); }
        const prevImg = cur.image, prevFile = cur.file;
        for (const k of ITEM_KEYS) if (it[k] !== undefined) cur[k] = it[k];
        if (prevImg && it.image) cur.image = { ...prevImg, ...it.image };
        if (prevFile && it.file) cur.file = { ...prevFile, ...it.file };
        cur.updatedAt = now; cur.deleted = false;
        saved = { ...cur };
      });
      return saved;
    }

    /** Batch move/resize/recolor: patches = [{id, x?, y?, w?, color?, text?}] */
    async patchItems(boardId, patches) {
      const now = Date.now();
      return this._mutate(boardId, (b) => {
        let n = 0;
        for (const p of patches) {
          const it = b.items.find((x) => x.id === p.id);
          if (!it) continue;
          for (const k of ITEM_KEYS) if (p[k] !== undefined && k !== 'image') it[k] = p[k];
          it.updatedAt = now; n++;
        }
        if (!n) return false;
      });
    }

    async deleteItems(boardId, ids) {
      const now = Date.now();
      const childBoards = [];
      await this._mutate(boardId, (b) => {
        for (const it of b.items) {
          if (!ids.includes(it.id) || it.deleted) continue;
          it.deleted = true; it.updatedAt = now;
          if (it.type === 'board' && it.boardId) childBoards.push(it.boardId);
        }
      });
      for (const cid of childBoards) await this._deleteBoardTree(cid);
    }
    /** Undo / redo: put whole item snapshots back. A snapshot without `type` means "did not exist". */
    async restoreItems(boardId, snaps) {
      const now = Date.now();
      const on = [], off = [];
      await this._mutate(boardId, (b) => {
        for (const sn of snaps) {
          const cur = b.items.find((x) => x.id === sn.id);
          if (!sn.type) {
            if (cur && !cur.deleted) { cur.deleted = true; cur.updatedAt = now; if (cur.type === 'board') off.push(cur.boardId); }
            continue;
          }
          const next = JSON.parse(JSON.stringify(sn));
          next.updatedAt = now;
          delete next.purge;
          if (!next.deleted) delete next.moved;
          const ki = cur && cur.image;
          if (ki && next.image && ki.id === next.image.id) {
            if (!next.image.fileId) next.image.fileId = ki.fileId || null;
            if (!next.image.editedFileId && next.image.editedAt === ki.editedAt) next.image.editedFileId = ki.editedFileId || null;
          }
          if (cur) { for (const k of Object.keys(cur)) delete cur[k]; Object.assign(cur, next); } else b.items.push(next);
          if (next.type === 'board') (next.deleted ? off : on).push(next.boardId);
        }
      });
      for (const id of on) await this._undeleteBoardTree(id, boardId, new Set());
      for (const id of off) await this._deleteBoardTree(id);
    }
    async _undeleteBoardTree(id, parentId, seen) {
      if (seen.has(id)) return;
      seen.add(id);
      const b = await this.getBoard(id);
      if (!b) return;
      if (b.deleted || b.parentId !== parentId) await this._mutate(id, (x) => { x.deleted = false; x.parentId = parentId; x.metaUpdatedAt = Date.now(); });
      for (const it of YVN.liveItems(b)) if (it.type === 'board' && it.boardId) await this._undeleteBoardTree(it.boardId, id, seen);
    }

    /** Deleted cards that can still be restored (newest first). */
    async trash() {
      const sums = await this.summaries();
      const out = [];
      for (const b of await this.listBoards()) {
        for (const it of b.items) {
          if (!it.deleted || it.moved || it.purged || it.purge || !it.type) continue;
          if (Date.now() - (it.updatedAt || 0) > TRASH_MS) continue;
          out.push({ boardId: b.id, boardTitle: b.id === YVN.HOME ? 'Home' : b.title, item: strip(it), boardRefTitle: it.type === 'board' ? (sums[it.boardId] || {}).title || '' : null, deletedAt: it.updatedAt });
        }
      }
      return out.sort((a, c) => c.deletedAt - a.deletedAt);
    }
    async restoreFromTrash(boardId, itemId) {
      const b = await this.getBoard(boardId);
      const it = b && b.items.find((x) => x.id === itemId);
      if (!it) return;
      await this.restoreItems(boardId, [{ ...it, deleted: false }]);
    }
    /** Permanently delete (images are removed from Drive on the next sync). entries: [{boardId, itemId}] */
    async purgeTrash(entries) {
      const byBoard = new Map();
      for (const e of entries) { if (!byBoard.has(e.boardId)) byBoard.set(e.boardId, []); byBoard.get(e.boardId).push(e.itemId); }
      const childBoards = [];
      for (const [boardId, ids] of byBoard) {
        await this._mutate(boardId, (b) => {
          for (const it of b.items) if (ids.includes(it.id) && it.deleted) {
            it.purge = true; it.updatedAt = Date.now();
            if (it.type === 'board' && it.boardId) childBoards.push(it.boardId);
          }
        });
      }
      for (const id of childBoards) await this._purgeBoardTree(id, new Set());
    }
    async _purgeBoardTree(id, seen) {
      if (seen.has(id)) return;
      seen.add(id);
      const b = await this.getBoard(id);
      if (!b) return;
      const kids = b.items.filter((i) => i.type === 'board' && i.boardId).map((i) => i.boardId);
      await this._mutate(id, (x) => {
        x.deleted = true; x.metaUpdatedAt = Date.now();
        for (const it of x.items) if (!it.purged) { it.deleted = true; it.purge = true; it.updatedAt = Date.now(); }
      });
      for (const k of kids) await this._purgeBoardTree(k, seen);
    }

    async _deleteBoardTree(id) {
      const b = await this.getBoard(id);
      if (!b || b.deleted) return;
      await this._mutate(id, (x) => { x.deleted = true; x.metaUpdatedAt = Date.now(); });
      for (const it of YVN.liveItems(b)) if (it.type === 'board' && it.boardId) await this._deleteBoardTree(it.boardId);
    }

    /** Move items into another board (drop onto a board card). positions: {id: {x,y}} in the target board. */
    async moveItems(fromId, toId, ids, positions) {
      if (fromId === toId) return;
      const src = await this.getBoard(fromId);
      if (!src) return;
      // never move a board into itself or into one of its own descendants
      const ancestors = new Set();
      for (let cur = await this.getBoard(toId); cur; cur = cur.parentId ? await this.getBoard(cur.parentId) : null) {
        if (ancestors.has(cur.id)) break;
        ancestors.add(cur.id);
      }
      const moving = YVN.liveItems(src).filter((i) => ids.includes(i.id) && !(i.type === 'board' && ancestors.has(i.boardId)));
      if (!moving.length) return;
      const now = Date.now();
      await this._mutate(toId, (b) => {
        for (const it of moving) {
          const copy = { ...it, ...(positions && positions[it.id]), updatedAt: now, deleted: false };
          delete copy.removedFiles;
          const i = b.items.findIndex((x) => x.id === it.id);
          if (i >= 0) b.items[i] = copy; else b.items.push(copy);
        }
      });
      await this._mutate(fromId, (b) => {
        for (const it of b.items) if (moving.some((m) => m.id === it.id)) {
          it.deleted = true; it.moved = true; it.updatedAt = now; // moved: images live on in the target board
        }
      });
      for (const it of moving) if (it.type === 'board') {
        await this._mutate(it.boardId, (cb) => { cb.parentId = toId; cb.metaUpdatedAt = now; });
      }
    }

    /** Save annotation state + rendered WebP (blob null & edits null = revert to original). */
    async saveImageEdit(boardId, itemId, edits, blob) {
      const now = Date.now();
      const b = await this.getBoard(boardId);
      const it = b && b.items.find((x) => x.id === itemId);
      if (!it || !it.image) return null;
      if (blob) await this._putBlob(it.image.id, 'edit', blob, true, now);
      return this._mutate(boardId, (b) => {
        const it = b.items.find((x) => x.id === itemId);
        if (it.image.editedFileId && !edits) it.removedFiles = [...(it.removedFiles || []), it.image.editedFileId];
        it.image = { ...it.image, edits: edits || null, editedAt: edits ? now : null, editedFileId: edits ? it.image.editedFileId || null : null };
        it.updatedAt = now;
      });
    }

    /** Local-first image fetch; falls back to Drive and caches. which: 'orig' | 'edit' | undefined(auto) */
    async getImageBlob(img, which, drive) {
      if (!img) return null;
      which = which || (img.edits ? 'edit' : 'orig');
      const rec = await this._getBlob(img.id, which);
      const stale = rec && which === 'edit' && !rec.dirty && img.editedAt && rec.editedAt && rec.editedAt < img.editedAt;
      if (rec && !stale) return rec.blob;
      const fid = which === 'edit' ? img.editedFileId : img.fileId;
      if (fid && drive) {
        try {
          const blob = await drive.download(fid);
          await this._putBlob(img.id, which, blob, false, img.editedAt || 0);
          return blob;
        } catch (e) { console.warn('[YVN] image download failed', e); }
      }
      if (rec) return rec.blob;
      if (which === 'edit') return this.getImageBlob(img, 'orig', drive);
      return null;
    }

    async search(q) {
      const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.length) return [];
      const out = [];
      for (const b of await this.listBoards()) {
        if (terms.every((t) => (b.title || '').toLowerCase().includes(t))) out.push({ boardId: b.id, boardTitle: b.title, itemId: null, type: 'board', text: b.title });
        for (const it of YVN.liveItems(b)) {
          const text = YVN.itemText(it);
          if (terms.every((t) => text.toLowerCase().includes(t))) out.push({ boardId: b.id, boardTitle: b.id === YVN.HOME ? 'Home' : b.title, itemId: it.id, type: it.type, text, ts: it.ts, updatedAt: it.updatedAt });
        }
      }
      return out.slice(0, 200);
    }

    async recent() { return (await this.kvGet('recent')) || []; }
    async touchRecent(id) {
      if (!id || id === YVN.HOME) return;
      const list = (await this.recent()).filter((x) => x !== id);
      list.unshift(id);
      await this.kvSet('recent', list.slice(0, 12));
    }

    async buildIndex() {
      return { schemaVersion: YVN.SCHEMA_VERSION, updatedAt: Date.now(), boards: await this.summaries() };
    }

    // ---------- v1 → v2 migration ----------
    /** Convert locally stored v1 videos (once). Deterministic ids, so every device produces the same boards. */
    async _migrateLocal() {
      if (await this.kvGet('migratedV1')) return;
      const videos = await req(this.db.transaction('videos').objectStore('videos').getAll());
      if (videos.length) await this._importV1(videos, (await this.kvGet('categories')) || YVN.DEFAULT_CATEGORIES);
      await this.kvSet('migratedV1', true);
    }

    async _importV1(videos, categories) {
      const live = videos.filter((v) => !v.deleted && YVN.liveNotes(v).length);
      if (!live.length) return 0;
      const cats = (categories || []).filter((c) => !c.deleted);
      const groups = new Map();
      for (const v of live.sort((a, b) => a.createdAt - b.createdAt)) {
        const cat = cats.find((c) => c.id === v.categoryId);
        const key = cat ? cat.id : 'uncat';
        if (!groups.has(key)) groups.set(key, { cat, videos: [] });
        groups.get(key).videos.push(v);
      }
      // original timestamps (not "now"): a device that migrates later must never override newer edits
      const homeItems = [];
      let gi = 0;
      for (const [key, { cat, videos: vids }] of groups) {
        const boardId = 'b_v1_' + key;
        const items = [];
        let y = 40;
        for (const v of vids) {
          const video = { id: v.videoId, title: v.title || v.videoId, channel: v.channel || '' };
          let x = 40, rowH = 0;
          const place = (it) => {
            const s = YVN.estimateSize(it);
            if (x + s.w > 40 + 5 * 260) { x = 40; y += rowH + 20; rowH = 0; }
            it.x = x; it.y = y; x += s.w + 20; rowH = Math.max(rowH, s.h);
            items.push(it);
          };
          place({ id: 'i_v1_t_' + v.videoId, type: 'link', url: `https://www.youtube.com/watch?v=${v.videoId}`, title: video.title, w: 240, createdAt: v.createdAt, updatedAt: v.createdAt || 1, deleted: false });
          for (const n of YVN.liveNotes(v)) {
            const imgs = n.images || [];
            if (!imgs.length) {
              place({ id: 'i_v1_' + n.id, type: 'note', text: n.text || '', video, w: 260, createdAt: n.createdAt, updatedAt: n.updatedAt || 1, deleted: false });
              continue;
            }
            imgs.forEach((im, k) => place({
              id: 'i_v1_' + im.id, type: 'shot', ts: im.ts, video, text: k === 0 ? n.text || '' : '', w: 240,
              image: { id: im.id, w: im.w, h: im.h, fileId: im.fileId || null, editedFileId: im.editedFileId || null, edits: im.edits || null, editedAt: im.editedAt || null },
              createdAt: n.createdAt + k, updatedAt: n.updatedAt || 1, deleted: false,
            }));
          }
          y += rowH + 60;
        }
        const existing = await this.getBoard(boardId);
        const board = { ...YVN.emptyBoard(boardId, cat ? cat.name : 'Unsorted', YVN.HOME), color: cat ? cat.color : '#8b8d98', items, metaUpdatedAt: 1 };
        await this._update(boardId, () => ({ ...YVN.mergeBoard(existing ? strip(existing) : null, board), _dirty: true }));
        homeItems.push({ id: 'i_v1_ref_' + key, type: 'board', boardId, x: 40 + (gi % 4) * 140, y: 40 + Math.floor(gi / 4) * 140, w: 120, createdAt: gi, updatedAt: 1, deleted: false });
        gi++;
      }
      await this._mutate(YVN.HOME, (h) => {
        for (const it of homeItems) if (!h.items.some((x) => x.id === it.id)) h.items.push(it);
      });
      this._emit('board:' + YVN.HOME);
      return live.length;
    }

    /** Remote v1 data (Drive written by the old version) → import once. */
    async _migrateRemote(drive, layout, remoteIndex) {
      if (!remoteIndex || !remoteIndex.videos || (await this.kvGet('migratedRemoteV1'))) return;
      const videos = [];
      for (const id of Object.keys(remoteIndex.videos)) {
        const s = remoteIndex.videos[id];
        if (s.deleted) continue;
        const v = await drive.readJSON(`${id}.json`, layout.videos);
        if (v) videos.push(v);
      }
      // merge with whatever v1 data we still have locally
      const local = await req((await this._os('videos')).getAll());
      const byId = new Map(local.map((v) => [v.videoId, v]));
      const merged = videos.map((v) => YVN.mergeVideo(byId.get(v.videoId) ? strip(byId.get(v.videoId)) : null, v));
      for (const v of local) if (!videos.some((x) => x.videoId === v.videoId)) merged.push(strip(v));
      await this._importV1(merged, YVN.mergeCategories(remoteIndex.categories || [], (await this.kvGet('categories')) || []));
      await this.kvSet('migratedRemoteV1', true);
    }

    // ---------- sync ----------
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

    async _layout(drive) {
      const root = await drive.ensureFolder(YVN.ROOT_FOLDER, null);
      const [boards, images, videos] = await Promise.all([
        drive.ensureFolder('boards', root), drive.ensureFolder('images', root), drive.ensureFolder('videos', root),
      ]);
      return { root, boards, images, videos };
    }

    async _syncOnce(drive) {
      await this.init();
      const layout = await this._layout(drive);
      const remoteIndex = await drive.readJSON('index.json', layout.root);
      await this._migrateRemote(drive, layout, remoteIndex);
      let pulled = 0, pushed = 0;

      // 1) pull boards whose remote stamp differs from what we last synced
      const remoteBoards = (remoteIndex && remoteIndex.boards) || {};
      for (const id of Object.keys(remoteBoards)) {
        const lb = await req((await this._os('boards')).get(id));
        if (lb && lb._syncedAt === remoteBoards[id].updatedAt) continue;
        const rb = await drive.readJSON(`${id}.json`, layout.boards);
        if (!rb) continue;
        await this._update(id, (cur) => {
          if (!cur) return { ...rb, _dirty: false, _syncedAt: rb.updatedAt };
          const m = YVN.mergeBoard(strip(cur), rb);
          m._dirty = !!cur._dirty;
          m._syncedAt = cur._dirty ? cur._syncedAt : rb.updatedAt;
          return m;
        });
        pulled++;
        this._emit('board:' + id);
      }

      // 2) push dirty boards (images first so the JSON only references uploaded files)
      for (const b of await this.listBoards(true)) {
        if (!b._dirty && remoteBoards[b.id]) continue;
        const cleaned = [];
        for (const it of b.items) {
          for (const fid of it.removedFiles || []) await drive.trash(fid);
          it.removedFiles = [];
          const img = it.image || it.file;
          if (it.deleted) {
            // moved cards: the image lives on in the target board. Trashed cards keep their image until
            // the trash is emptied or 30 days pass, so they can still be restored.
            if (img && it.moved) { it.purged = true; delete it.image; delete it.file; }
            else if (img && !it.purged && (it.purge || Date.now() - (it.updatedAt || 0) > TRASH_MS)) {
              if (img.fileId) await drive.trash(img.fileId);
              if (img.editedFileId) await drive.trash(img.editedFileId);
              await this._delBlob(img.id);
              it.purged = true; delete it.image; delete it.file;
            }
            continue;
          }
          if (!img) continue;
          const o = await this._getBlob(img.id, 'orig');
          if (o && (o.dirty || !img.fileId)) {
            const fname = it.file ? `${img.id}-${String(it.file.name || 'file').replace(/[\/:*?"<>|]/g, '_')}` : `${img.id}.webp`;
            img.fileId = await drive.upload(fname, layout.images, o.blob, img.fileId);
            cleaned.push([img.id, 'orig', o]);
          }
          if (it.image && img.edits) {
            const e = await this._getBlob(img.id, 'edit');
            if (e && (e.dirty || !img.editedFileId)) {
              img.editedFileId = await drive.upload(`${img.id}.edit.webp`, layout.images, e.blob, img.editedFileId);
              cleaned.push([img.id, 'edit', e]);
            }
          }
        }
        await drive.writeJSON(`${b.id}.json`, layout.boards, strip(b));
        for (const [imageId, which, rec] of cleaned) {
          const now = await this._getBlob(imageId, which);
          if (now && now.editedAt === rec.editedAt) await this._putBlob(imageId, which, rec.blob, false, rec.editedAt);
        }
        const snapshot = b;
        await this._update(b.id, (cur) => {
          if (!cur) return null;
          if (cur.updatedAt === snapshot.updatedAt) return { ...snapshot, _dirty: false, _syncedAt: snapshot.updatedAt };
          const m = YVN.mergeBoard(strip(cur), strip(snapshot));
          m._dirty = true; m._syncedAt = cur._syncedAt;
          this._again = true;
          return m;
        });
        pushed++;
      }

      // 3) index.json
      const index = await this.buildIndex();
      const cmp = (i) => JSON.stringify(i && i.boards ? Object.values(i.boards).map((s) => [s.id, s.updatedAt, s.title, s.color, s.deleted]).sort() : null);
      if (pushed || cmp(index) !== cmp(remoteIndex) || (remoteIndex && remoteIndex.schemaVersion !== YVN.SCHEMA_VERSION)) {
        await drive.writeJSON('index.json', layout.root, index);
      }
      await this.kvSet('lastSync', Date.now());
      this._emit('sync');
      return { pulled, pushed };
    }
  }

  YVN.Store = Store;
})(typeof self !== 'undefined' ? self : globalThis);
