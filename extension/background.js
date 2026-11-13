/* YT-Vision-Notes — service worker: owns the local store (IndexedDB in the extension origin), Google auth
 * (chrome.identity), Drive sync and the pop-out windows. Pages talk to it through messages + ports. */
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
  if (msg.type === 'status') chrome.runtime.sendMessage(msg).catch(() => {}); // popup, if open
}
const pushStatus = () => broadcast({ type: 'status', status: { ...status } });
store.onChange((w) => { if (w.startsWith('board:')) broadcast({ type: 'changed', boardId: w.slice(6) }); });

async function restoreStatus() {
  const s = await chrome.storage.local.get(['signedIn', 'webUrl']);
  status.signedIn = !!s.signedIn;
  status.webUrl = s.webUrl || '';
  await store.init();
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
let syncTimer;
function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(sync, 4000); }

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

// ---------- pop-out windows (one per YouTube tab) ----------
async function popMap() { return (await chrome.storage.session.get('pop')).pop || {}; }
async function setPopMap(m) { await chrome.storage.session.set({ pop: m }); }

async function findYouTubeTab(preferId) {
  if (preferId) { try { const t = await chrome.tabs.get(preferId); if (t && /youtube\.com\/watch/.test(t.url || '')) return t.id; } catch (e) { /* closed */ } }
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/watch*' });
  tabs.sort((a, b) => (b.active - a.active) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
  return tabs[0] ? tabs[0].id : null;
}
async function toTab(tabId, msg) {
  const id = await findYouTubeTab(tabId);
  if (!id) throw new Error('找不到正在播放的 YouTube 分頁');
  const r = await chrome.tabs.sendMessage(id, msg).catch(() => null);
  if (!r) throw new Error('YouTube 分頁沒有回應，請重新整理那個分頁');
  if (r.error) throw new Error(r.error);
  return r;
}

chrome.windows.onRemoved.addListener(async (winId) => {
  const m = await popMap();
  for (const tabId of Object.keys(m)) {
    if (m[tabId] !== winId) continue;
    delete m[tabId];
    chrome.tabs.sendMessage(+tabId, { type: 'popin' }).catch(() => {});
  }
  await setPopMap(m);
});
chrome.windows.onBoundsChanged && chrome.windows.onBoundsChanged.addListener(async (w) => {
  const m = await popMap();
  if (Object.values(m).includes(w.id)) chrome.storage.local.set({ popBounds: { left: w.left, top: w.top, width: w.width, height: w.height } });
});

// ---------- message handlers ----------
const mutated = (r) => { scheduleSync(); return r; };
const handlers = {
  async getBoard({ id }) { await ready; return { board: strip(await store.getBoard(id)) }; },
  async summaries() { await ready; return { sums: await store.summaries() }; },
  async createBoard({ parentId, o }) { return mutated(await store.createBoard(parentId, o)); },
  async updateBoard({ id, patch }) { return mutated({ board: strip(await store.updateBoard(id, patch)) }); },
  async putItem({ boardId, item, dataURL }) {
    const blobs = dataURL ? { orig: await YVN.dataURLToBlob(dataURL) } : null;
    return mutated({ item: await store.putItem(boardId, item, blobs) });
  },
  async patchItems({ boardId, patches }) { await store.patchItems(boardId, patches); return mutated({}); },
  async deleteItems({ boardId, ids }) { await store.deleteItems(boardId, ids); return mutated({}); },
  async moveItems({ from, to, ids, positions }) { await store.moveItems(from, to, ids, positions); return mutated({}); },
  async getImage({ image, which }) {
    const blob = await store.getImageBlob(image, which, status.signedIn ? drive : null);
    return { dataURL: blob ? await YVN.blobToDataURL(blob) : null };
  },
  async saveImageEdit({ boardId, itemId, edits, edited }) {
    const blob = edits && edited ? await YVN.dataURLToBlob(edited) : null;
    await store.saveImageEdit(boardId, itemId, edits, blob);
    return mutated({});
  },
  async restoreItems({ boardId, items }) { await store.restoreItems(boardId, items); return mutated({}); },
  async trash() { return { list: await store.trash() }; },
  async restoreFromTrash({ boardId, itemId }) { await store.restoreFromTrash(boardId, itemId); return mutated({}); },
  async purgeTrash({ entries }) { await store.purgeTrash(entries); return mutated({}); },
  async search({ q }) { return { results: await store.search(q) }; },
  async recent() { return { ids: await store.recent() }; },
  async touchRecent({ id }) { await store.touchRecent(id); return {}; },

  async getStatus() {
    await ready;
    const boards = await store.listBoards();
    return { status: { ...status }, boardCount: boards.filter((b) => b.id !== YVN.HOME).length, itemCount: boards.reduce((n, b) => n + YVN.liveItems(b).filter((i) => i.type !== 'board').length, 0) };
  },
  async setWebUrl({ url }) { status.webUrl = url || ''; await chrome.storage.local.set({ webUrl: status.webUrl }); pushStatus(); return {}; },
  async signIn() { await signIn(); return { status: { ...status } }; },
  async signOut() { await signOut(); return { status: { ...status } }; },
  async syncNow() { const r = await sync(); return { result: r, status: { ...status } }; },

  async popout({ boardId }, sender) {
    const tabId = sender.tab && sender.tab.id;
    const m = await popMap();
    if (tabId && m[tabId]) {
      try { await chrome.windows.update(m[tabId], { focused: true }); return { windowId: m[tabId] }; } catch (e) { delete m[tabId]; }
    }
    const { popBounds } = await chrome.storage.local.get('popBounds');
    const b = popBounds || { width: 760, height: 900 };
    const url = chrome.runtime.getURL(`board.html?tab=${tabId || ''}&board=${encodeURIComponent(boardId || '')}`);
    const w = await chrome.windows.create({ url, type: 'popup', focused: true, ...b });
    if (tabId) { m[tabId] = w.id; await setPopMap(m); }
    return { windowId: w.id };
  },
  async isPopped(_m, sender) {
    const m = await popMap();
    const winId = sender.tab && m[sender.tab.id];
    if (!winId) return { popped: false };
    try { await chrome.windows.get(winId); return { popped: true }; } catch (e) { delete m[sender.tab.id]; await setPopMap(m); return { popped: false }; }
  },
  async closePopout(_m, sender) {
    const winId = sender.tab && sender.tab.windowId;
    if (winId) await chrome.windows.remove(winId).catch(() => {});
    return {};
  },
  async captureTab({ tabId }) { const r = await toTab(tabId, { type: 'captureFrame' }); return { cap: r.cap }; },
  async tabVideo({ tabId }) { const r = await toTab(tabId, { type: 'currentVideo' }).catch(() => ({ video: null })); return { video: r.video }; },
  async seekTab({ tabId, video, ts }) { await toTab(tabId, { type: 'seek', video, ts }); return {}; },
  // Alt+S pressed in a YouTube tab whose notes live in a pop-out window → let that window place the card
  async shotToPopout({ cap }, sender) { broadcast({ type: 'addShot', tabId: sender.tab && sender.tab.id, cap }); return {}; },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = msg && handlers[msg.type];
  if (!fn) return false;
  fn(msg, sender).then((r) => sendResponse({ ok: true, ...r }), (e) => { console.error('[YVN]', msg.type, e); sendResponse({ ok: false, error: String(e.message || e) }); });
  return true; // async response
});

chrome.runtime.onConnect.addListener((port) => {
  if (!/^yvn/.test(port.name)) return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.postMessage({ type: 'status', status: { ...status } });
});

chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create('yvn-sync', { periodInMinutes: 30 }); sync(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('yvn-sync', { periodInMinutes: 30 }); sync(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'yvn-sync') sync(); });
