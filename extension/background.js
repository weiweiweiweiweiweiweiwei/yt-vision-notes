/* YT-Vision-Notes — service worker: owns the local store (IndexedDB in the extension origin),
 * Google auth (chrome.identity) and Drive sync. Content scripts talk to it through messages. */
importScripts('shared/core.js', 'shared/drive.js', 'shared/store.js');

const store = new YVN.Store('yvn-ext');
const ports = new Set();
const status = { signedIn: false, syncing: false, lastSync: 0, error: '' };
let lastToken = null;

async function getToken(forceRefresh, interactive) {
  if (forceRefresh && lastToken) {
    await chrome.identity.removeCachedAuthToken({ token: lastToken });
    lastToken = null;
  }
  const r = await chrome.identity.getAuthToken({ interactive: !!interactive });
  lastToken = r && typeof r === 'object' ? r.token : r;
  if (!lastToken) throw new Error('no token');
  return lastToken;
}

const drive = new YVN.Drive({ getToken: (force) => getToken(force, false), cache: store.driveCache() });

function broadcast(msg) {
  for (const p of ports) { try { p.postMessage(msg); } catch (e) { ports.delete(p); } }
  chrome.runtime.sendMessage(msg).catch(() => {}); // popup, if open
}
const pushStatus = () => broadcast({ type: 'status', status: { ...status } });

async function restoreStatus() {
  const s = await chrome.storage.local.get(['signedIn', 'webUrl']);
  status.signedIn = !!s.signedIn;
  status.webUrl = s.webUrl || '';
  status.lastSync = (await store.kvGet('lastSync')) || 0;
}
const ready = restoreStatus();

async function sync() {
  await ready;
  if (!status.signedIn) return { skipped: true };
  status.syncing = true; status.error = ''; pushStatus();
  try {
    const r = await store.sync(drive);
    status.lastSync = Date.now();
    if (r && r.pulled) broadcast({ type: 'changed' });
    return r;
  } catch (e) {
    console.warn('[YVN] sync failed', e);
    status.error = String(e.message || e);
    if (/no token|OAuth2|not signed|not granted|revoked/i.test(status.error)) {
      status.signedIn = false;
      await chrome.storage.local.set({ signedIn: false });
    }
    return { error: status.error };
  } finally {
    status.syncing = false; pushStatus();
  }
}

async function signIn() {
  await getToken(false, true);
  status.signedIn = true; status.error = '';
  await chrome.storage.local.set({ signedIn: true });
  pushStatus();
  return sync();
}
async function signOut() {
  try {
    const t = await getToken(false, false);
    await chrome.identity.removeCachedAuthToken({ token: t });
    await fetch('https://oauth2.googleapis.com/revoke?token=' + t, { method: 'POST' });
  } catch (e) { /* already signed out */ }
  lastToken = null; status.signedIn = false;
  await chrome.storage.local.set({ signedIn: false });
  pushStatus();
}

const strip = (v) => { if (!v) return null; const o = {}; for (const k in v) if (k[0] !== '_') o[k] = v[k]; return o; };

const handlers = {
  async getState({ videoId }) {
    await ready;
    return {
      video: videoId ? strip(await store.getVideo(videoId)) : null,
      categories: await store.getCategories(),
      tags: await store.allTags(),
      status: { ...status },
    };
  },
  async saveNote({ meta, note, images }) {
    const blobs = {};
    for (const i of images || []) {
      if (i.orig) blobs[i.id + ':orig'] = await YVN.dataURLToBlob(i.orig);
      if (i.edited && i.edits) blobs[i.id + ':edit'] = await YVN.dataURLToBlob(i.edited);
    }
    note.images = (images || []).map((i) => ({ id: i.id, ts: i.ts, w: i.w, h: i.h, edits: i.edits || null }));
    const r = await store.upsertNote(meta, note, blobs);
    sync();
    return { video: strip(r.video), noteId: r.noteId, tags: await store.allTags() };
  },
  async deleteNote({ videoId, noteId }) {
    const v = await store.deleteNote(videoId, noteId);
    sync();
    return { video: strip(v || (await store.getVideo(videoId))) };
  },
  async setCategory({ videoId, categoryId }) {
    if (!(await store.getVideo(videoId))) return { video: null }; // applied with the first saved note
    const v = await store.setVideoMeta(videoId, { categoryId });
    sync();
    return { video: strip(v) };
  },
  async saveImageEdit({ videoId, noteId, imageId, edits, edited }) {
    const blob = edits && edited ? await YVN.dataURLToBlob(edited) : null;
    const v = await store.saveImageEdit(videoId, noteId, imageId, edits, blob);
    sync();
    return { video: strip(v) };
  },
  async getImage({ videoId, noteId, imageId, which }) {
    const v = await store.getVideo(videoId);
    const n = v && v.notes.find((x) => x.id === noteId);
    const img = n && n.images.find((i) => i.id === imageId);
    if (!img) return { dataURL: null };
    const blob = await store.getImageBlob(videoId, img, which, status.signedIn ? drive : null);
    return { dataURL: blob ? await YVN.blobToDataURL(blob) : null };
  },
  async upsertCategory({ category }) {
    const c = await store.upsertCategory(category);
    sync();
    return { category: c, categories: await store.getCategories() };
  },
  async deleteCategory({ id }) {
    await store.deleteCategory(id);
    sync();
    return { categories: await store.getCategories() };
  },
  async getStatus() {
    await ready;
    const videos = await store.listVideos();
    return { status: { ...status }, videoCount: videos.length, noteCount: videos.reduce((n, v) => n + YVN.liveNotes(v).length, 0) };
  },
  async setWebUrl({ url }) { status.webUrl = url || ''; await chrome.storage.local.set({ webUrl: status.webUrl }); pushStatus(); return {}; },
  async signIn() { await signIn(); return { status: { ...status } }; },
  async signOut() { await signOut(); return { status: { ...status } }; },
  async syncNow() { const r = await sync(); return { result: r, status: { ...status } }; },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const fn = msg && handlers[msg.type];
  if (!fn) return false;
  fn(msg).then((r) => sendResponse({ ok: true, ...r }), (e) => { console.error('[YVN]', msg.type, e); sendResponse({ ok: false, error: String(e.message || e) }); });
  return true; // async response
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'yvn') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
});

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('yvn-sync', { periodInMinutes: 30 }));
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('yvn-sync', { periodInMinutes: 30 }); sync(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'yvn-sync') sync(); });
