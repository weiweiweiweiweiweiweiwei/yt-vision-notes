/* YT-Vision-Notes — pop-out window: the same board, in its own window (drag it to a second monitor).
 * Capture and seek are forwarded to the YouTube tab that opened it. */
(() => {
  'use strict';
  const YVN = self.YVN;
  const el = YVN.el, icon = YVN.boardIcon;
  const params = new URLSearchParams(location.search);
  const tabId = +params.get('tab') || null;
  const remote = YVN.makeRemote({ portName: 'yvn-win' });
  let status = {};

  const sync = el('button', { class: 'yb-hbtn win-sync', title: 'Sync', onclick: () => remote.send('syncNow').catch(() => {}) }, el('i'));
  const renderStatus = () => {
    sync.className = 'yb-hbtn win-sync ' + (status.syncing ? 'busy' : status.error ? 'err' : status.signedIn ? 'ok' : '');
    sync.title = status.syncing ? 'Syncing…' : status.error ? 'Sync failed: ' + status.error : status.signedIn ? 'Synced to Google Drive' : 'Not signed in to Google';
  };

  const root = document.getElementById('board');
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const theme = () => root.classList.toggle('yb-dark', dark.matches);
  dark.addEventListener('change', theme);

  const view = new YVN.BoardView(root, remote.api, {
    mode: 'window',
    capture: async () => (await remote.send('captureTab', { tabId })).cap,
    captureMany: async (list) => (await remote.send('captureTabMany', { tabId, list })).caps,
    aiGenerate: (req) => YVN.geminiNotes(req),
    currentVideo: async () => (await remote.send('tabVideo', { tabId })).video,
    seek: (video, ts) => remote.send('seekTab', { tabId, video, ts }).catch((e) => view.toast(e.message)),
    headerExtras: [
      sync,
      el('button', { class: 'yb-hbtn', title: 'Open this board on the website', 'aria-label': 'Open on website', onclick: () => {
        if (!status.webUrl) return view.toast('Set the knowledge base URL in the extension popup first');
        window.open(status.webUrl.replace(/#.*$/, '') + (view.boardId === YVN.HOME ? '#/' : `#/b/${encodeURIComponent(view.boardId)}`), '_blank');
      } }, icon('external', 17)),
      el('button', { class: 'yb-hbtn', title: 'Dock back into YouTube', 'aria-label': 'Dock back into YouTube', onclick: () => remote.send('closePopout') }, icon('dock', 17)),
    ],
    onNavigate: (id) => {
      try { localStorage.setItem('winBoard', id); } catch (e) { /* ignore */ }
      remote.api.getBoard(id).then((b) => { document.title = (b && b.id !== YVN.HOME ? b.title + ' — ' : '') + 'YT Vision Notes'; });
    },
  });
  theme();

  remote.onMessage((m) => {
    if (m.type === 'status') { status = m.status; renderStatus(); }
    if (m.type === 'addShot' && (!m.tabId || !tabId || m.tabId === tabId)) view.addShot(m.cap);
  });

  // global capture shortcut inside this window too
  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyS') { e.preventDefault(); view.captureShot(); }
  }, true);

  view.open(params.get('board') || YVN.HOME);
})();
