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

  const sync = el('button', { class: 'yb-hbtn win-sync', title: '同步', onclick: () => remote.send('syncNow').catch(() => {}) }, el('i'));
  const renderStatus = () => {
    sync.className = 'yb-hbtn win-sync ' + (status.syncing ? 'busy' : status.error ? 'err' : status.signedIn ? 'ok' : '');
    sync.title = status.syncing ? '同步中…' : status.error ? '同步失敗：' + status.error : status.signedIn ? '已同步到 Google Drive' : '尚未登入 Google';
  };

  const root = document.getElementById('board');
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const theme = () => root.classList.toggle('yb-dark', dark.matches);
  dark.addEventListener('change', theme);

  const view = new YVN.BoardView(root, remote.api, {
    mode: 'window',
    capture: async () => (await remote.send('captureTab', { tabId })).cap,
    currentVideo: async () => (await remote.send('tabVideo', { tabId })).video,
    seek: (video, ts) => remote.send('seekTab', { tabId, video, ts }).catch((e) => view.toast(e.message)),
    headerExtras: [
      sync,
      el('button', { class: 'yb-hbtn', title: '在網站開啟這個 Board', 'aria-label': '在網站開啟', onclick: () => {
        if (!status.webUrl) return view.toast('請先在擴充功能圖示的彈出視窗設定知識庫網址');
        window.open(status.webUrl.replace(/#.*$/, '') + (view.boardId === YVN.HOME ? '#/' : `#/b/${encodeURIComponent(view.boardId)}`), '_blank');
      } }, icon('external', 17)),
      el('button', { class: 'yb-hbtn', title: '收回到 YouTube 右側', 'aria-label': '收回到 YouTube 右側', onclick: () => remote.send('closePopout') }, icon('dock', 17)),
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
