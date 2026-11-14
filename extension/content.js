/* YT-Vision-Notes — YouTube content script: player toggle, resizable note panel (whiteboard) next to the player,
 * frame capture, pop-out window bridge. */
(() => {
  'use strict';
  if (window.__yvnLoaded) return;
  window.__yvnLoaded = true;
  const YVN = self.YVN;
  const el = YVN.el, icon = YVN.boardIcon;

  const remote = YVN.makeRemote({ portName: 'yvn-tab' });
  const S = { on: false, popped: false, videoId: null, status: {}, sideW: 0 };
  const ui = {};

  const videoEl = () => document.querySelector('video.html5-main-video');
  const flexy = () => document.querySelector('ytd-watch-flexy');
  const currentVideoId = () => (location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null);
  const text = (sel) => { const n = document.querySelector(sel); return n ? n.textContent.trim() : ''; };
  function currentVideo() {
    const id = currentVideoId();
    if (!id) return null;
    return {
      id,
      title: text('ytd-watch-metadata h1') || document.title.replace(/ - YouTube$/, '').replace(/^\(\d+\)\s*/, ''),
      channel: text('ytd-watch-metadata ytd-channel-name a') || text('#owner #channel-name a'),
    };
  }

  // ---------- capture / seek ----------
  function captureFrame() {
    const v = videoEl();
    if (!v || !v.videoWidth || !currentVideoId()) throw new Error('No video frame found');
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    try {
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height); // raw frame: no overlay, progress bar or controls
      return { dataURL: c.toDataURL('image/webp', 0.92), w: c.width, h: c.height, ts: Math.floor(v.currentTime), video: currentVideo() };
    } catch (e) {
      throw new Error('This video is protected and cannot be captured'); // DRM / tainted canvas
    }
  }
  /** Capture frames at several timestamps (for AI notes), then put the video back where it was. */
  async function captureMany(list, onProgress) {
    const v = videoEl();
    if (!v || !currentVideoId()) throw new Error('No video frame found');
    const t0 = v.currentTime, wasPlaying = !v.paused;
    v.pause();
    const out = [];
    try {
      for (let i = 0; i < list.length; i++) {
        if (onProgress) onProgress(i, list.length, list[i]);
        await new Promise((res) => {
          let done = false;
          const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); res(); };
          v.addEventListener('seeked', fin);
          v.currentTime = Math.min(list[i] + 0.5, Math.max(0, (v.duration || 1e9) - 0.5));
          setTimeout(fin, 5000);
        });
        await new Promise((r) => setTimeout(r, 400)); // let the decoded frame reach the element
        try { const cap = captureFrame(); cap.ts = list[i]; out.push(cap); } catch (e) { out.push(null); }
      }
    } finally {
      v.currentTime = t0;
      if (wasPlaying) v.play().catch(() => {});
    }
    return out;
  }
  function seek(video, ts) {
    if (video && video.id && video.id !== currentVideoId()) {
      location.href = `https://www.youtube.com/watch?v=${video.id}&t=${Math.floor(ts)}s`;
      return;
    }
    const v = videoEl();
    if (!v) return;
    v.currentTime = ts;
    v.play().catch(() => {});
  }

  let toastTimer;
  function toast(msg) {
    if (!ui.toast) return;
    ui.toast.textContent = msg; ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 2600);
  }

  // ---------- panel ----------
  function webUrl(hash) {
    if (!S.status.webUrl) { toast('Set the knowledge base URL in the extension popup first'); return; }
    window.open(S.status.webUrl.replace(/#.*$/, '') + (hash || ''), '_blank', 'noopener');
  }
  function renderStatus() {
    if (!ui.sync) return;
    const st = S.status;
    ui.sync.className = 'yb-hbtn yvn-sync ' + (st.syncing ? 'busy' : st.error ? 'err' : st.signedIn ? 'ok' : '');
    ui.sync.title = st.syncing ? 'Syncing…' : st.error ? 'Sync failed: ' + st.error : st.signedIn ? 'Synced to Google Drive (click to sync now)' : 'Not signed in to Google: notes are only on this computer (sign in from the extension icon)';
  }

  function buildPanel() {
    ui.sync = el('button', { class: 'yb-hbtn yvn-sync', onclick: () => remote.send('syncNow').catch((e) => toast(e.message)) }, el('i'));
    ui.toast = el('div', { class: 'yvn-toast', role: 'status', hidden: true });
    ui.root = el('div', { class: 'yvn-board' });
    ui.panel = el('div', { id: 'yvn-panel' }, ui.root, ui.toast);
    ui.view = new YVN.BoardView(ui.root, remote.api, {
      mode: 'panel',
      capture: async () => captureFrame(),
      captureMany,
      aiGenerate: (req) => YVN.geminiNotes(req),
      currentVideo,
      seek,
      toast,
      headerExtras: [
        ui.sync,
        el('button', { class: 'yb-hbtn', title: 'Open this board on the website', 'aria-label': 'Open on website', onclick: () => webUrl(ui.view.boardId === YVN.HOME ? '#/' : `#/b/${encodeURIComponent(ui.view.boardId)}`) }, icon('external', 17)),
        el('button', { class: 'yb-hbtn', title: 'Pop out into its own window (drag it to another screen)', 'aria-label': 'Pop out', onclick: popout }, icon('popout', 17)),
        el('button', { class: 'yb-hbtn', title: 'Close notes', 'aria-label': 'Close notes', onclick: () => setOn(false) }, icon('close', 17)),
      ],
    });
    // keep YouTube hotkeys (k, j, f, space…) away while typing in the panel
    for (const t of ['keydown', 'keyup', 'keypress']) {
      ui.panel.addEventListener(t, (e) => { if (e.target.closest('input, textarea, [contenteditable]')) e.stopPropagation(); });
    }
    renderStatus();
  }

  function mountPanel() {
    const secondary = document.querySelector('ytd-watch-flexy #secondary');
    if (!secondary) return;
    if (!ui.panel) buildPanel();
    if (ui.panel.parentElement !== secondary) secondary.prepend(ui.panel);
    mountSplitter(secondary);
    applyWidth();
  }

  // ---------- resizable divider between player and panel ----------
  const MIN_SIDE = 340, MIN_PLAYER = 360;
  function columnsWidth() {
    const cols = document.querySelector('ytd-watch-flexy #columns');
    return cols ? cols.getBoundingClientRect().width : window.innerWidth;
  }
  function clampW(w) { return Math.round(Math.max(MIN_SIDE, Math.min(w, columnsWidth() - MIN_PLAYER))); }
  function applyWidth() {
    const f = flexy();
    if (!f) return;
    if (S.on && !S.popped && S.sideW) {
      const w = clampW(S.sideW) + 'px';
      f.style.setProperty('--ytd-watch-flexy-sidebar-width', w);
      f.style.setProperty('--ytd-watch-flexy-sidebar-min-width', w);
    } else {
      f.style.removeProperty('--ytd-watch-flexy-sidebar-width');
      f.style.removeProperty('--ytd-watch-flexy-sidebar-min-width');
    }
  }
  let resizeRAF = 0;
  const nudgePlayer = () => { if (!resizeRAF) resizeRAF = requestAnimationFrame(() => { resizeRAF = 0; window.dispatchEvent(new Event('resize')); }); };

  function mountSplitter(secondary) {
    if (!ui.split) {
      ui.split = el('div', { id: 'yvn-split', title: 'Drag to resize video and notes (double-click cycles 1/3, 1/2, 2/3)', role: 'separator', 'aria-orientation': 'vertical' }, el('span'));
      ui.split.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const right = secondary.getBoundingClientRect().right;
        document.documentElement.classList.add('yvn-resizing');
        const mv = (ev) => { S.sideW = clampW(right - ev.clientX - 12); applyWidth(); nudgePlayer(); };
        const up = () => {
          window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
          document.documentElement.classList.remove('yvn-resizing');
          chrome.storage.local.set({ sideW: S.sideW }).catch(() => {});
          window.dispatchEvent(new Event('resize'));
        };
        window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
      });
      ui.split.addEventListener('dblclick', () => {
        const cw = columnsWidth();
        const presets = [1 / 3, 1 / 2, 2 / 3].map((r) => clampW(cw * r));
        const cur = clampW(S.sideW || 402);
        const i = presets.findIndex((p) => p > cur + 8);
        S.sideW = presets[i < 0 ? 0 : i];
        applyWidth(); window.dispatchEvent(new Event('resize'));
        chrome.storage.local.set({ sideW: S.sideW }).catch(() => {});
      });
    }
    if (ui.split.nextElementSibling !== secondary) secondary.parentElement.insertBefore(ui.split, secondary);
  }

  // ---------- pop-out window ----------
  async function popout() {
    try {
      await remote.send('popout', { boardId: ui.view ? ui.view.boardId : '' });
      setPopped(true);
    } catch (e) { toast(e.message); }
  }
  function setPopped(p) {
    S.popped = p;
    render();
  }

  // ---------- on / off ----------
  function render() {
    const active = S.on && !S.popped && !!S.videoId;
    document.documentElement.classList.toggle('yvn-on', active);
    const b = document.querySelector('.yvn-toggle');
    if (b) {
      b.classList.toggle('on', S.on && !S.popped);
      b.classList.toggle('popped', S.popped);
      b.setAttribute('aria-pressed', String(S.on));
      b.title = S.popped ? 'Notes are open in a separate window (click to switch)' : 'Vision Notes';
    }
    if (active) mountPanel();
    applyWidth();
    window.dispatchEvent(new Event('resize'));
  }
  function setOn(on) {
    if (on && S.popped) { remote.send('popout', {}).catch(() => {}); return; } // focus the window instead
    const was = S.on;
    S.on = on;
    chrome.storage.local.set({ panelOn: on }).catch(() => {});
    render();
    if (on && !was && ui.view) { opened = true; ui.view.open(YVN.HOME); } // every time notes are opened: start from Home
  }

  function mountButton() {
    const bar = document.querySelector('#movie_player .ytp-right-controls');
    if (!bar || bar.querySelector('.yvn-toggle')) return;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    // a brain, drawn as a 24px line icon and centred by CSS (see .yvn-toggle in content.css)
    svg.setAttribute('viewBox', '0 0 24 24');
    for (const [k, v] of Object.entries({ fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v);
    const BRAIN = [
      'M9.4 4.6C7.6 4.1 5.8 5.2 5.4 7C3.8 7.5 2.9 9.1 3.3 10.7C2.5 12.2 3.1 14 4.7 14.8C5.4 16.1 6.9 16.7 8.4 16.3C9.9 17.6 12.3 17.8 14 16.9L14.5 19.4C14.7 20.6 16.3 20.6 16.5 19.4L16.7 17.1C18.9 16.9 20.6 15.3 20.8 13.1C21.4 11.2 20.7 9.2 19.1 8.2C18.7 6.2 16.9 4.8 14.9 5C13.4 3.7 11 3.6 9.4 4.6Z',
      'M9.4 4.6C10 5.6 9.8 6.7 9 7.4', 'M5.4 7C6.6 6.9 7.6 7.5 8.1 8.5', 'M12.2 6.3C12 7.8 13 9 14.4 9.2', 'M19.1 8.2C17.9 8.3 17 9 16.6 10',
      'M6.6 13.2C8.2 11.7 10.8 11.5 12.8 12.4C14.4 13.1 16.2 12.8 17.3 11.7', 'M4.7 14.8C5 13.9 5.7 13.4 6.6 13.2', 'M10.3 9.6C11.2 10.4 12.4 10.5 13.3 10', 'M14 16.9C14.9 16.4 15.9 16.6 16.7 17.1',
    ];
    for (const d of BRAIN) { const p = document.createElementNS(svgNS, 'path'); p.setAttribute('d', d); svg.appendChild(p); }
    const btn = el('button', { class: 'ytp-button yvn-toggle', title: 'Vision Notes', 'aria-label': 'Vision Notes', 'aria-pressed': String(S.on), onclick: () => setOn(!(S.on && !S.popped)) });
    btn.appendChild(svg);
    bar.prepend(btn);
    render();
  }

  // ---------- boot ----------
  let opened = false;
  function tick() {
    mountButton();
    const id = currentVideoId();
    if (id !== S.videoId) { S.videoId = id; render(); }
    if (S.on && !S.popped && S.videoId) {
      mountPanel();
      if (!opened && ui.view) { opened = true; ui.view.open(YVN.HOME); }
    }
  }
  document.addEventListener('yt-navigate-finish', tick);
  setInterval(tick, 1000);
  window.addEventListener('resize', () => { if (S.on) applyWidth(); });

  document.addEventListener('keydown', (e) => {
    if (!(S.on && S.videoId && e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyS')) return;
    e.preventDefault(); e.stopPropagation();
    if (!S.popped && ui.view) { ui.view.captureShot(); return; }
    try { remote.send('shotToPopout', { cap: captureFrame() }); } catch (err) { toast(err.message); }
  }, true);

  remote.onMessage((m) => {
    if (m.type === 'status') { S.status = m.status; renderStatus(); }
  });

  // requests from the service worker on behalf of the pop-out window
  chrome.runtime.onMessage.addListener((m, _sender, reply) => {
    if (m.type === 'captureFrame') { try { reply({ cap: captureFrame() }); } catch (e) { reply({ error: e.message }); } return false; }
    if (m.type === 'currentVideo') { reply({ video: currentVideo() }); return false; }
    if (m.type === 'captureMany') { captureMany(m.list || []).then((caps) => reply({ caps }), (e) => reply({ error: e.message })); return true; }
    if (m.type === 'seek') { seek(m.video, m.ts); reply({ ok: true }); return false; }
    if (m.type === 'popin') { setPopped(false); reply({ ok: true }); return false; }
    return false;
  });

  Promise.all([chrome.storage.local.get(['panelOn', 'sideW']), remote.send('isPopped').catch(() => ({}))]).then(([r, p]) => {
    S.on = !!r.panelOn;
    S.sideW = r.sideW || 0;
    S.popped = !!p.popped;
    tick();
  });
})();
