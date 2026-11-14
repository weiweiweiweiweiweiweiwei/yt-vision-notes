/* YT-Vision-Notes — GitHub Pages knowledge base: Milanote-style boards on top of the shared board engine. */
(() => {
  'use strict';
  const YVN = window.YVN;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = YVN.el;
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const strip = (v) => { if (!v) return null; const o = {}; for (const k in v) if (k[0] !== '_') o[k] = v[k]; return o; };

  const store = new YVN.Store('yvn-web');
  const S = { syncing: false, error: '' };

  // ---------- auth (Google Identity Services token flow) ----------
  const clientId = () => localStorage.getItem('yvnClientId') || (window.YVN_CONFIG && window.YVN_CONFIG.clientId) || '';
  let token = null;
  try { token = JSON.parse(localStorage.getItem('yvnToken') || 'null'); } catch (e) { token = null; }
  const tokenValid = () => !!(token && token.exp > Date.now() + 60000);
  let tokenClient = null, tokenWaiters = [];

  function gisReady() {
    return new Promise((res, rej) => {
      let n = 0;
      (function wait() {
        if (window.google && google.accounts && google.accounts.oauth2) return res();
        if (++n > 100) return rej(new Error('Google sign-in failed to load (check your network or ad blocker)'));
        setTimeout(wait, 100);
      })();
    });
  }
  async function requestToken(prompt) {
    if (!clientId()) throw new Error('OAuth Client ID is not set (open ⚙ Settings)');
    await gisReady();
    if (!tokenClient || tokenClient._cid !== clientId()) {
      const settle = (err, val) => { const w = tokenWaiters; tokenWaiters = []; w.forEach(([res, rej]) => (err ? rej(err) : res(val))); };
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId(), scope: SCOPE,
        callback: (r) => {
          if (r.error) return settle(new Error(r.error_description || r.error));
          token = { value: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 };
          localStorage.setItem('yvnToken', JSON.stringify(token));
          settle(null, token.value);
        },
        error_callback: (e) => settle(new Error(e.type === 'popup_closed' ? 'The sign-in window was closed' : e.type === 'popup_failed_to_open' ? 'The browser blocked the sign-in window. Click sync again' : e.message || 'Sign-in failed')),
      });
      tokenClient._cid = clientId();
    }
    return new Promise((res, rej) => { tokenWaiters.push([res, rej]); tokenClient.requestAccessToken({ prompt: prompt == null ? '' : prompt }); });
  }
  const drive = new YVN.Drive({
    getToken: async (force) => (!force && tokenValid() ? token.value : requestToken('')),
    cache: store.driveCache(),
  });
  const driveOrNull = () => (tokenValid() ? drive : null);

  // ---------- toast ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  // ---------- sync ----------
  const syncBtn = el('button', { class: 'yb-hbtn app-sync', title: 'Sync with Google Drive', onclick: () => sync(true) }, el('i', { class: 'dot' }), el('span', {}, 'Sign in'));
  function renderSync() {
    syncBtn.querySelector('.dot').className = 'dot ' + (S.syncing ? 'busy' : S.error ? 'err' : tokenValid() ? 'ok' : '');
    syncBtn.querySelector('span').textContent = S.syncing ? 'Syncing…' : S.error ? 'Sync failed' : tokenValid() ? 'Synced' : localStorage.getItem('yvnSignedIn') ? 'Reconnect' : 'Sign in with Google';
    syncBtn.title = S.error || 'Sync with Google Drive';
  }
  async function sync(interactive) {
    if (S.syncing) return;
    if (!tokenValid()) {
      if (!interactive) return renderSync();
      try { await requestToken(localStorage.getItem('yvnSignedIn') ? '' : 'consent'); localStorage.setItem('yvnSignedIn', '1'); }
      catch (e) { S.error = e.message; renderSync(); toast(e.message); if (!clientId()) openSettings(); return; }
    }
    S.syncing = true; S.error = ''; renderSync();
    try {
      await store.sync(drive);
      view.reload();
    } catch (e) {
      console.error(e); S.error = e.message || String(e);
      if (interactive) toast('Sync failed: ' + S.error);
    }
    S.syncing = false; renderSync();
  }
  let syncTimer;
  const scheduleSync = () => { clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(false), 2500); };

  // ---------- board API over the local store ----------
  const urlCache = new Map();
  const mut = (fn) => async (...a) => { const r = await fn(...a); scheduleSync(); return r; };
  const api = {
    getBoard: async (id) => strip(await store.getBoard(id)),
    summaries: () => store.summaries(),
    createBoard: mut((p, o) => store.createBoard(p, o)),
    updateBoard: mut((id, patch) => store.updateBoard(id, patch).then(strip)),
    putItem: mut(async (b, it, dataURL) => store.putItem(b, it, dataURL ? { orig: await YVN.dataURLToBlob(dataURL) } : null)),
    patchItems: mut((b, p) => store.patchItems(b, p).then(() => true)),
    deleteItems: mut((b, ids, o) => store.deleteItems(b, ids, o)),
    moveItems: mut((f, t, ids, pos) => store.moveItems(f, t, ids, pos)),
    saveImageEdit: mut((b, id, edits, blob) => store.saveImageEdit(b, id, edits, blob).then(() => true)),
    async getImage(boardId, it, which) {
      const img = it.image || it.file;
      if (!img) return null;
      const w = which || (img.edits ? 'edit' : 'orig');
      const key = `${img.id}:${w}:${img.editedAt || 0}`;
      if (urlCache.has(key)) return urlCache.get(key);
      const blob = await store.getImageBlob(img, w, driveOrNull());
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      urlCache.set(key, url);
      return url;
    },
    restoreItems: mut((b, items) => store.restoreItems(b, items)),
    trash: () => store.trash(),
    restoreFromTrash: mut((b, id) => store.restoreFromTrash(b, id)),
    purgeTrash: mut((entries) => store.purgeTrash(entries)),
    async me() {
      try { const c = JSON.parse(localStorage.getItem('yvnMe') || 'null'); if (c) return c; } catch (e) { /* ignore */ }
      if (!tokenValid()) return null;
      const u = (await (await drive.request('https://www.googleapis.com/drive/v3/about?fields=user(displayName,photoLink)')).json()).user || {};
      const me = { name: u.displayName || '', photo: u.photoLink || '' };
      localStorage.setItem('yvnMe', JSON.stringify(me));
      return me;
    },
    search: (q) => store.search(q),
    recent: () => store.recent(),
    touchRecent: (id) => store.touchRecent(id),
    onChange: (fn) => store.onChange((w) => fn(w.startsWith('board:') ? w.slice(6) : null)),
  };

  // ---------- mini YouTube player for timestamps ----------
  const mini = $('#mini');
  function seek(video, ts) {
    if (!video) return toast('This card has no video');
    $('#miniTitle').textContent = video.title || video.id;
    $('#miniOpen').href = `https://www.youtube.com/watch?v=${video.id}&t=${Math.floor(ts)}s`;
    $('#miniFrame').src = `https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&start=${Math.floor(ts)}&rel=0`;
    mini.hidden = false;
  }
  $('#miniClose').onclick = () => { mini.hidden = true; $('#miniFrame').src = 'about:blank'; };

  // ---------- export current board as Markdown + images ----------
  async function exportZip() {
    const b = await store.getBoard(view.boardId);
    if (!b) return;
    const sums = await store.summaries();
    const items = YVN.liveItems(b).sort((a, c) => a.y - c.y || a.x - c.x);
    const files = [];
    const lines = [`# ${b.id === YVN.HOME ? 'Home' : b.title}`, ''];
    let missing = 0;
    for (const it of items) {
      if (it.type === 'note') {
        if (it.video) lines.push(`> Summary: [${it.video.title}](https://www.youtube.com/watch?v=${it.video.id})`, '');
        lines.push(it.text || '', '');
      } else if (it.image) {
        const blob = await store.getImageBlob(it.image, null, driveOrNull());
        const name = `images/${it.image.id}.webp`;
        if (blob) files.push({ name, data: blob }); else missing++;
        lines.push(`![](${name})`);
        if (it.type === 'shot' && it.video) lines.push(`[${YVN.fmtTime(it.ts)}](https://www.youtube.com/watch?v=${it.video.id}&t=${Math.floor(it.ts || 0)}s) ${it.video.title}`);
        if (it.text) lines.push(it.text);
        lines.push('');
      } else if (it.type === 'link') lines.push(`- [${it.title || it.url}](${it.url})`, '');
      else if (it.type === 'board') lines.push(`- 📁 [[${(sums[it.boardId] || {}).title || 'Untitled'}]]`, '');
      else if (it.type === 'column') lines.push(`## ${it.title || 'Column'}`, '');
      else if (it.type === 'todo') lines.push(...(it.title ? [`**${it.title}**`] : []), ...(it.todos || []).map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`), '');
      else if (it.type === 'color') lines.push(`- Color ${it.name || ''} \`${(it.hex || '').toUpperCase()}\``, '');
      else if (it.type === 'heading') lines.push(`## ${it.text || ''}`, '');
      else if (it.type === 'table' && (it.rows || []).length) {
        const cell = (v) => String(v || '').replace(/\|/g, '\|').replace(/\n/g, ' ');
        const [head, ...body] = it.rows;
        lines.push(`| ${head.map(cell).join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body.map((r) => `| ${r.map(cell).join(' | ')} |`), '');
      } else if (it.type === 'doc') lines.push(`### ${it.title || 'Untitled document'}`, '', it.text || '', '');
      else if (it.type === 'video' && it.url) lines.push(`- Video: [${it.title || it.url}](${it.url})`, '');
      else if (it.type === 'map' && it.query) lines.push(`- Map: [${it.query}](https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(it.query)})`, '');
      else if (it.file) {
        const blob = await store.getImageBlob(it.file, 'orig', driveOrNull());
        const name = `files/${it.file.id}-${String(it.file.name || 'file').replace(/[\/:*?"<>|]/g, '_')}`;
        if (blob) files.push({ name, data: blob }); else missing++;
        lines.push(`- File: [${it.file.name || 'File'}](${encodeURI(name)})`, '');
      } else if (it.type === 'sketch') lines.push('- (sketch)', '');
    }
    files.unshift({ name: 'board.md', data: lines.join('\n') });
    const zip = await YVN.makeZip(files);
    const safe = (b.id === YVN.HOME ? 'Home' : b.title || 'board').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zip); a.download = `${safe}.zip`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast(missing ? `Exported (${missing} images not downloaded yet — sign in, sync and try again)` : 'Exported ZIP');
  }

  // ---------- settings ----------
  function openSettings() {
    const dlg = $('#dlg');
    const signOut = () => {
      if (token && window.google) google.accounts.oauth2.revoke(token.value, () => {});
      token = null; localStorage.removeItem('yvnToken'); localStorage.removeItem('yvnSignedIn'); localStorage.removeItem('yvnMe'); renderSync(); draw();
    };
    const draw = () => {
      const cid = el('input', { class: 'inp', id: 'cid', value: clientId(), placeholder: 'xxxxxxxx.apps.googleusercontent.com', spellcheck: 'false' });
      cid.value = clientId();
      cid.onchange = () => { localStorage.setItem('yvnClientId', cid.value.trim()); tokenClient = null; };
      dlg.replaceChildren(
        el('h2', {}, 'Settings'),
        el('h3', {}, 'Google OAuth Client ID（Web application）'),
        cid,
        el('p', { class: 'muted' }, 'Stored only in this browser. ' + (tokenValid() ? 'Currently signed in.' : '')),
        el('h3', {}, 'How to use'),
        el('ul', { class: 'help' },
          el('li', {}, 'Wheel, middle-button drag or Space + drag: pan the board; Ctrl + wheel: zoom'),
          el('li', {}, 'Left-drag on empty space: select cards (hold Shift to add)'),
          el('li', {}, 'Double-click empty space: new note; double-click a card: edit; double-click a screenshot: annotate'),
          el('li', {}, 'Drag cards onto a board card to move them into it; Alt + drag duplicates'),
          el('li', {}, 'Paste or drop images and links; Delete removes the selected cards')),
        el('div', { class: 'actions' },
          localStorage.getItem('yvnSignedIn') && el('button', { class: 'btn danger', onclick: signOut }, 'Sign out of Google'),
          el('button', { class: 'btn primary', onclick: () => dlg.close() }, 'Done')));
    };
    draw();
    if (!dlg.open) dlg.showModal();
  }

  // ---------- routing ----------
  const parseHash = () => {
    const m = /^#\/b\/([^/]+)(?:\/([^/]+))?/.exec(location.hash);
    return m ? { board: decodeURIComponent(m[1]), item: m[2] ? decodeURIComponent(m[2]) : null } : { board: YVN.HOME, item: null };
  };
  let ignoreHash = false;
  const boardEl = $('#board');
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const applyTheme = () => boardEl.classList.toggle('yb-dark', dark.matches);
  dark.addEventListener('change', applyTheme);

  const view = new YVN.BoardView(boardEl, api, {
    mode: 'web',
    seek,
    toast,
    headerExtras: [
      el('button', { class: 'yb-hbtn', title: 'Export this board as Markdown + images (ZIP)', onclick: exportZip }, 'Export'),
      syncBtn,
      el('button', { class: 'yb-hbtn', title: 'Settings', 'aria-label': 'Settings', onclick: openSettings }, '⚙'),
    ],
    onNavigate: (id) => {
      const want = id === YVN.HOME ? '#/' : `#/b/${encodeURIComponent(id)}`;
      if (location.hash !== want && !(id === YVN.HOME && !location.hash)) { ignoreHash = true; location.hash = want; }
      store.getBoard(id).then((b) => { document.title = `${b && b.id !== YVN.HOME ? b.title + ' — ' : ''}YT Vision Notes`; });
    },
  });
  applyTheme();
  window.addEventListener('hashchange', () => {
    if (ignoreHash) { ignoreHash = false; return; }
    const r = parseHash();
    view.open(r.board, r.item);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && tokenValid()) scheduleSync(); });

  // ---------- boot ----------
  window.yvnApp = { store, view, sync };
  (async () => {
    await store.init();
    renderSync();
    const r = parseHash();
    await view.open(r.board, r.item);
    if (tokenValid()) sync(false);
  })();
})();
