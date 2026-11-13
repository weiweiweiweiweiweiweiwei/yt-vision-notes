/* YT-Vision-Notes — minimal Google Drive API v3 client (fetch based).
 * Works in the extension service worker (token from chrome.identity) and on the web (token from GIS).
 * Scope needed: https://www.googleapis.com/auth/drive.file */
(function (g) {
  'use strict';
  const YVN = (g.YVN = g.YVN || {});
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';

  class Drive {
    /**
     * @param {object} o
     * @param {(forceRefresh:boolean)=>Promise<string>} o.getToken
     * @param {object} [o.cache] persisted path→fileId map ({get(k), set(k,v), del(k)}; may be async)
     */
    constructor(o) {
      this.getToken = o.getToken;
      this.cache = o.cache || { m: new Map(), get(k) { return this.m.get(k); }, set(k, v) { this.m.set(k, v); }, del(k) { this.m.delete(k); } };
    }

    async request(url, opts = {}, retry = true) {
      const token = await this.getToken(false);
      const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
      if (res.status === 401 && retry) {
        await this.getToken(true);
        return this.request(url, opts, false);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`Drive API ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }
      return res;
    }

    async find(name, parentId, mime) {
      const q = [`name='${name.replace(/'/g, "\\'")}'`, 'trashed=false'];
      if (parentId) q.push(`'${parentId}' in parents`);
      if (mime) q.push(`mimeType='${mime}'`);
      const url = `${API}/files?q=${encodeURIComponent(q.join(' and '))}&fields=files(id,name,modifiedTime)&orderBy=createdTime&pageSize=10&spaces=drive`;
      const data = await (await this.request(url)).json();
      return data.files && data.files[0] ? data.files[0].id : null;
    }

    async ensureFolder(name, parentId) {
      const key = `folder:${parentId || 'root'}/${name}`;
      const cached = await this.cache.get(key);
      if (cached) return cached;
      let id = await this.find(name, parentId, FOLDER_MIME);
      if (!id) {
        const body = { name, mimeType: FOLDER_MIME };
        if (parentId) body.parents = [parentId];
        const res = await this.request(`${API}/files?fields=id`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        id = (await res.json()).id;
      }
      await this.cache.set(key, id);
      return id;
    }

    /** /YT-Vision-Notes/{videos,images} */
    async layout() {
      const root = await this.ensureFolder(YVN.ROOT_FOLDER, null);
      const [videos, images] = await Promise.all([this.ensureFolder('videos', root), this.ensureFolder('images', root)]);
      return { root, videos, images };
    }

    async fileId(name, parentId) {
      const key = `file:${parentId}/${name}`;
      const cached = await this.cache.get(key);
      if (cached) return cached;
      const id = await this.find(name, parentId);
      if (id) await this.cache.set(key, id);
      return id;
    }

    async readJSON(name, parentId) {
      const key = `file:${parentId}/${name}`;
      let id = await this.fileId(name, parentId);
      if (!id) return null;
      try {
        return await (await this.request(`${API}/files/${id}?alt=media`)).json();
      } catch (e) {
        if (e.status !== 404) throw e;
        await this.cache.del(key); // stale cache (file removed on Drive) → look it up again
        id = await this.find(name, parentId);
        if (!id) return null;
        await this.cache.set(key, id);
        return (await this.request(`${API}/files/${id}?alt=media`)).json();
      }
    }

    async writeJSON(name, parentId, data) {
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const id = await this.fileId(name, parentId);
      const newId = await this.upload(name, parentId, blob, id);
      await this.cache.set(`file:${parentId}/${name}`, newId);
      return newId;
    }

    /** Create (multipart) or overwrite (media) a file. Returns the file id. */
    async upload(name, parentId, blob, existingId) {
      if (existingId) {
        try {
          await this.request(`${UPLOAD}/files/${existingId}?uploadType=media&fields=id`, {
            method: 'PATCH', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob,
          });
          return existingId;
        } catch (e) {
          if (e.status !== 404) throw e; // file vanished → recreate below
        }
      }
      const boundary = 'yvn' + Math.random().toString(36).slice(2);
      const meta = { name, parents: [parentId] };
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
        `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
        blob,
        `\r\n--${boundary}--`,
      ]);
      const res = await this.request(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
      });
      return (await res.json()).id;
    }

    async download(fileId) {
      return (await this.request(`${API}/files/${fileId}?alt=media`)).blob();
    }

    async trash(fileId) {
      try {
        await this.request(`${API}/files/${fileId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }),
        });
      } catch (e) { if (e.status !== 404) throw e; }
    }
  }

  YVN.Drive = Drive;
})(typeof self !== 'undefined' ? self : globalThis);
