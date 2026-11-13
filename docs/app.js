/* YT-Vision-Notes — GitHub Pages knowledge base (vanilla SPA, hash routing, no build step). */
(() => {
  'use strict';
  const YVN = window.YVN;
  const esc = YVN.escapeHtml;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const app = $('#app');
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';

  const store = new YVN.Store('yvn-web');
  const D = { videos: [], categories: [], tags: {} };      // in-memory snapshot of the local store
  const V = { cat: sessionStorage.getItem('yvnCat') || 'all', syncing: false, error: '', videoShell: null, editing: null };

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
        if (++n > 100) return rej(new Error('Google 登入元件載入失敗（請檢查網路或擋廣告外掛）'));
        setTimeout(wait, 100);
      })();
    });
  }
  async function requestToken(prompt) {
    if (!clientId()) throw new Error('尚未設定 OAuth Client ID（請到 ⚙ 設定）');
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
        error_callback: (e) => settle(new Error(e.type === 'popup_closed' ? '登入視窗已關閉' : e.type === 'popup_failed_to_open' ? '登入視窗被瀏覽器阻擋，請再按一次同步' : e.message || '登入失敗')),
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

  // ---------- sync ----------
  function renderSync() {
    const dot = $('#syncDot'), txt = $('#syncText');
    dot.className = 'dot ' + (V.syncing ? 'busy' : V.error ? 'err' : tokenValid() ? 'ok' : '');
    txt.textContent = V.syncing ? '同步中…' : V.error ? '同步失敗' : tokenValid() ? '已同步' : localStorage.getItem('yvnSignedIn') ? '重新連線' : '登入 Google';
    $('#syncBtn').title = V.error || '與 Google Drive 同步';
  }
  async function sync(interactive) {
    if (V.syncing) return;
    if (!tokenValid()) {
      if (!interactive) return renderSync();
      try { await requestToken(localStorage.getItem('yvnSignedIn') ? '' : 'consent'); localStorage.setItem('yvnSignedIn', '1'); }
      catch (e) { V.error = e.message; renderSync(); toast(e.message); if (!clientId()) openSettings(); return; }
    }
    V.syncing = true; V.error = ''; renderSync();
    try {
      await store.sync(drive);
      await reload();
      softRender();
    } catch (e) {
      console.error(e); V.error = e.message || String(e);
      if (interactive) toast('同步失敗：' + V.error);
    }
    V.syncing = false; renderSync();
  }
  let syncTimer;
  const scheduleSync = () => { clearTimeout(syncTimer); syncTimer = setTimeout(() => sync(false), 1500); };

  async function reload() {
    D.videos = await store.listVideos();
    D.categories = await store.getCategories();
    D.tags = await store.allTags();
  }
  const catOf = (id) => D.categories.find((c) => c.id === id) || null;
  const videoOf = (id) => D.videos.find((v) => v.videoId === id) || null;

  // ---------- utils ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }
  function dayLabel(ms) {
    const d = new Date(ms), now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff < 7) return ['週日', '週一', '週二', '週三', '週四', '週五', '週六'][d.getDay()];
    return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  }
  const badge = (catId) => { const c = catOf(catId); return c ? `<span class="badge" style="background:${esc(c.color)}">${esc(c.name)}</span>` : ''; };
  const tagLink = (t, on) => `<a class="tag${on ? ' on' : ''}" href="#/tag/${encodeURIComponent(t)}">#${esc(t)}</a>`;

  // lazy images from IndexedDB / Drive
  const urlCache = new Map();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); loadImg(e.target); }
  }, { rootMargin: '300px' });
  async function loadImg(imgEl) {
    const [videoId, noteId, imageId] = imgEl.dataset.img.split('|');
    const v = videoOf(videoId), n = v && v.notes.find((x) => x.id === noteId), img = n && n.images.find((i) => i.id === imageId);
    if (!img) return;
    const key = `${img.id}:${img.editedAt || 0}`;
    if (!urlCache.has(key)) {
      urlCache.set(key, store.getImageBlob(videoId, img, undefined, driveOrNull()).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null));
    }
    const url = await urlCache.get(key);
    if (url) imgEl.src = url; else { urlCache.delete(key); imgEl.alt = '圖片尚未下載（請登入同步）'; }
  }
  const observeImages = () => app.querySelectorAll('img[data-img]:not([src])').forEach((i) => io.observe(i));

  // ---------- shared fragments ----------
  function noteHTML(v, n, opts) {
    opts = opts || {};
    const imgs = n.images || [];
    const strip = imgs.length ? `<div class="strip${imgs.length === 1 ? ' single' : ''}">${imgs.map((img, i) => `
        <button class="shot" data-act="open" data-v="${v.videoId}" data-n="${n.id}" data-i="${i}" aria-label="放大截圖 ${i + 1}">
          <img data-img="${v.videoId}|${n.id}|${img.id}" alt="截圖 ${YVN.fmtTime(img.ts)}" loading="lazy">
          ${imgs.length > 1 ? `<span class="n">${i + 1}</span>` : ''}
          <span class="t" data-act="seek" data-v="${v.videoId}" data-ts="${img.ts}">${YVN.fmtTime(img.ts)}</span>
        </button>`).join('')}</div>` : '';
    if (V.editing === n.id) {
      return `<article class="note" data-note="${n.id}">
        <header><button class="ts" data-act="seek" data-v="${v.videoId}" data-ts="${n.ts}">${YVN.fmtTime(n.ts)}</button><span class="src">編輯中</span></header>
        ${strip}
        <div class="note-edit">
          <textarea class="ta" id="editText" aria-label="筆記內容">${esc(n.text)}</textarea>
          <input class="inp" id="editTags" value="${esc((n.tags || []).map((t) => '#' + t).join(' '))}" placeholder="#標籤 以空白分隔" list="taglist" aria-label="標籤">
          <div class="actions"><button class="btn sm" data-act="edit-cancel">取消</button><button class="btn sm primary" data-act="edit-save" data-v="${v.videoId}" data-n="${n.id}">儲存</button></div>
        </div></article>`;
    }
    return `<article class="note" data-note="${n.id}">
      <header>
        <a class="ts" data-act="seek" data-v="${v.videoId}" data-ts="${n.ts}" href="#/video/${v.videoId}/${n.ts}">${YVN.fmtTime(n.ts)}</a>
        ${opts.wall ? `<a class="src" href="#/video/${v.videoId}/${n.ts}" title="${esc(v.title)}">${esc(v.title || v.videoId)}</a>${badge(v.categoryId)}` : `<span class="src">${YVN.fmtDate(n.updatedAt)}</span>
          <button class="iconbtn" data-act="edit" data-n="${n.id}" title="編輯" aria-label="編輯筆記">✎</button>
          <button class="iconbtn" data-act="del-note" data-v="${v.videoId}" data-n="${n.id}" title="刪除" aria-label="刪除筆記">🗑</button>`}
      </header>
      ${strip}
      ${n.text ? `<div class="md" data-v="${v.videoId}">${YVN.renderMarkdown(n.text)}</div>` : ''}
      ${n.tags && n.tags.length ? `<div class="tagrow">${n.tags.map((t) => tagLink(t, t === opts.activeTag)).join('')}</div>` : ''}
    </article>`;
  }

  function filterBar(route) {
    const counts = { all: D.videos.length, none: D.videos.filter((v) => !catOf(v.categoryId)).length };
    for (const v of D.videos) if (catOf(v.categoryId)) counts[v.categoryId] = (counts[v.categoryId] || 0) + 1;
    const tab = (id, label, color) => `<button class="tab${V.cat === id ? ' on' : ''}" data-act="cat" data-cat="${id}">${color ? `<i style="background:${esc(color)}"></i>` : ''}${esc(label)} <small>${counts[id] || 0}</small></button>`;
    const top = Object.entries(D.tags).sort((a, b) => b[1] - a[1]).slice(0, 24);
    return `<nav class="tabs" aria-label="主分類">${tab('all', '全部')}${D.categories.map((c) => tab(c.id, c.name, c.color)).join('')}${counts.none ? tab('none', '未分類') : ''}</nav>
      ${top.length ? `<nav class="pills" aria-label="熱門標籤">${top.map(([t, n]) => `<a class="pill${route.tag === t ? ' on' : ''}" href="${route.tag === t ? '#/' : '#/tag/' + encodeURIComponent(t)}">#${esc(t)} <small>${n}</small></a>`).join('')}</nav>` : ''}`;
  }
  const inCat = (v) => V.cat === 'all' || (V.cat === 'none' ? !catOf(v.categoryId) : v.categoryId === V.cat);

  // ---------- views ----------
  function viewLibrary(route) {
    const q = (route.q || '').trim().toLowerCase();
    const vids = D.videos.filter(inCat);
    let html = filterBar(route);

    if (route.tag || q) {
      // cross-video knowledge wall
      const notes = [];
      for (const v of vids) for (const n of YVN.liveNotes(v)) {
        if (route.tag && !(n.tags || []).includes(route.tag)) continue;
        if (q && !(`${n.text}\n${(n.tags || []).map((t) => '#' + t).join(' ')}\n${v.title}\n${v.channel}`.toLowerCase().includes(q))) continue;
        notes.push([v, n]);
      }
      notes.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      const shots = notes.reduce((s, x) => s + x[1].images.length, 0);
      html += `<div class="bar"><h1>${route.tag ? '#' + esc(route.tag) : '搜尋「' + esc(route.q) + '」'}</h1>
        <span class="muted">${notes.length} 則筆記 · ${shots} 張截圖 · 跨 ${new Set(notes.map((x) => x[0].videoId)).size} 部影片</span>
        <a class="btn sm" href="#/">清除篩選</a></div>`;
      html += notes.length ? `<div class="wall">${notes.map(([v, n]) => noteHTML(v, n, { wall: true, activeTag: route.tag })).join('')}</div>` : '<p class="muted">沒有符合的筆記。</p>';
      app.innerHTML = html;
      return;
    }

    if (!D.videos.length) {
      app.innerHTML = `<div class="empty"><h2>還沒有任何筆記</h2>
        <p class="muted">這裡會像 YouTube 觀看紀錄一樣，列出所有你做過截圖筆記的影片。</p>
        <ol><li>安裝 <b>YT Vision Notes</b> Chrome 擴充功能並登入 Google。</li><li>在 YouTube 播放器按「筆記」圖示，暫停 → 點 <b>[+]</b> 擷取 → 寫幾句話 → 儲存。</li><li>回到這裡按右上角「登入 Google」，筆記就會從你的 Google Drive 同步進來。</li></ol>
        <button class="btn primary" data-act="sync">登入 Google 並同步</button></div>`;
      return;
    }
    const sorted = vids.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    let last = '';
    html += sorted.length ? '' : '<p class="muted">這個分類還沒有影片。</p>';
    for (const v of sorted) {
      const label = dayLabel(v.updatedAt);
      if (label !== last) { html += `${last ? '</div>' : ''}<h2 class="day">${label}</h2><div class="grid">`; last = label; }
      const s = YVN.summarize(v);
      html += `<a class="vcard" href="#/video/${v.videoId}">
        <div class="cover" style="background-image:url('https://i.ytimg.com/vi/${encodeURIComponent(v.videoId)}/mqdefault.jpg')"><span>${s.noteCount} 則筆記 · ${s.imageCount} 張截圖</span></div>
        <div class="meta"><h3>${esc(v.title || v.videoId)}</h3>
          <div class="sub">${badge(v.categoryId)}<span>${esc(v.channel || '')}</span><span>· ${YVN.fmtDate(v.updatedAt)}</span></div>
          ${s.tags.length ? `<div class="tagrow">${s.tags.slice(0, 4).map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}${s.tags.length > 4 ? `<span class="muted">+${s.tags.length - 4}</span>` : ''}</div>` : ''}
        </div></a>`;
    }
    if (last) html += '</div>';
    app.innerHTML = html;
  }

  // ----- video detail -----
  let player = null, playerReady = false, pendingSeek = null;
  function loadYT() {
    if (window.YT && YT.Player) return Promise.resolve();
    return new Promise((res) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); res(); };
      if (!$('script[data-yt]')) { const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.dataset.yt = '1'; document.head.appendChild(s); }
    });
  }
  function seek(ts) {
    if (player && playerReady) { player.seekTo(ts, true); player.playVideo(); } else pendingSeek = ts;
    const p = $('.player'); if (p && p.getBoundingClientRect().top < 0) p.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function destroyPlayer() { if (player && player.destroy) { try { player.destroy(); } catch (e) { /* noop */ } } player = null; playerReady = false; V.videoShell = null; }

  function backlinksHTML(v) {
    const out = [];
    const needles = [v.videoId, v.title].filter(Boolean).map((s) => `[[${s}]]`.toLowerCase());
    for (const o of D.videos) {
      if (o.videoId === v.videoId) continue;
      for (const n of YVN.liveNotes(o)) if (needles.some((s) => (n.text || '').toLowerCase().includes(s))) out.push(`<li><a href="#/video/${o.videoId}/${n.ts}">${esc(o.title)} · ${YVN.fmtTime(n.ts)}</a></li>`);
    }
    return `<section class="backlinks"><h2>反向連結</h2>${out.length ? `<ul>${out.join('')}</ul>` : `<p class="muted">在其他筆記寫 <code>[[${esc(v.title || v.videoId)}]]</code> 就會出現在這裡。</p>`}</section>`;
  }
  function timelineHTML(v) {
    const notes = YVN.liveNotes(v);
    return `<h2>${notes.length} 則筆記 · ${notes.reduce((s, n) => s + n.images.length, 0)} 張截圖</h2>
      ${notes.map((n) => noteHTML(v, n)).join('') || '<p class="muted">這部影片沒有筆記了。</p>'}
      <article class="note addnote">
        <textarea class="ta" id="addText" placeholder="補充一則文字筆記（會記錄播放器目前的時間點；支援 Markdown、#標籤、[[雙向連結]]）" aria-label="新增文字筆記"></textarea>
        <div class="actions"><button class="btn sm primary" data-act="add-note" data-v="${v.videoId}">新增筆記</button></div>
      </article>
      ${backlinksHTML(v)}`;
  }
  function infoHTML(v) {
    return `<h1>${esc(v.title || v.videoId)}</h1>
      <div class="row"><span class="muted">${esc(v.channel || '')}</span>
        <select class="sel" data-act="set-cat" data-v="${v.videoId}" aria-label="主分類"><option value="">未分類</option>${D.categories.map((c) => `<option value="${c.id}"${c.id === v.categoryId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
        <button class="btn sm" data-act="export" data-v="${v.videoId}">匯出 .md + 圖片 ZIP</button>
        <a class="btn sm" href="${esc(v.url)}" target="_blank" rel="noopener">在 YouTube 開啟 ↗</a>
        <button class="btn sm danger" data-act="del-video" data-v="${v.videoId}">刪除</button></div>`;
  }
  function viewVideo(route) {
    const v = videoOf(route.videoId);
    if (!v) { destroyPlayer(); app.innerHTML = `<div class="empty"><h2>找不到這部影片的筆記</h2><p class="muted">可能尚未同步。</p><button class="btn primary" data-act="sync">同步</button> <a class="btn" href="#/">回首頁</a></div>`; return; }
    if (V.videoShell !== v.videoId) {
      destroyPlayer();
      app.innerHTML = `<div class="bar"><a class="btn sm" href="#/">← 知識庫</a></div>
        <div class="detail"><div class="playercol"><div class="player"><div id="ytp"></div></div><div class="vinfo"></div></div><div class="timeline"></div></div>
        <datalist id="taglist"></datalist>`;
      V.videoShell = v.videoId;
      const start = route.ts || 0;
      loadYT().then(() => {
        if (V.videoShell !== v.videoId) return;
        player = new YT.Player('ytp', {
          videoId: v.videoId, width: '100%', height: '100%',
          playerVars: { start, rel: 0, playsinline: 1, origin: location.origin },
          events: { onReady: () => { playerReady = true; if (pendingSeek != null) { seek(pendingSeek); pendingSeek = null; } } },
        });
      });
    } else if (route.ts != null && route.tsChanged) seek(route.ts);
    $('.vinfo').innerHTML = infoHTML(v);
    $('.timeline').innerHTML = timelineHTML(v);
    $('#taglist').innerHTML = Object.keys(D.tags).map((t) => `<option value="#${esc(t)}">`).join('');
  }

  // ---------- router ----------
  let lastHash = '';
  function parseRoute() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
    if (parts[0] === 'video' && parts[1]) return { name: 'video', videoId: parts[1], ts: parts[2] != null && parts[2] !== '' ? +parts[2] : null };
    if (parts[0] === 'tag' && parts[1]) return { name: 'library', tag: parts[1] };
    if (parts[0] === 'search' && parts[1]) return { name: 'library', q: parts.slice(1).join('/') };
    return { name: 'library' };
  }
  function render() {
    const route = parseRoute();
    route.tsChanged = location.hash !== lastHash;
    const navigated = location.hash !== lastHash;
    lastHash = location.hash;
    if (route.name === 'video') viewVideo(route);
    else { destroyPlayer(); viewLibrary(route); }
    const qEl = $('#q'); if (document.activeElement !== qEl) qEl.value = route.q || '';
    observeImages();
    if (navigated && route.name !== 'video') window.scrollTo(0, 0);
    document.title = route.name === 'video' && videoOf(route.videoId) ? `${videoOf(route.videoId).title} — Vision Notes` : 'YT Vision Notes — 知識庫';
  }
  /** Re-render after background sync unless the user is in the middle of typing. */
  function softRender() {
    const a = document.activeElement;
    if (V.editing || (a && app.contains(a) && /TEXTAREA|INPUT/.test(a.tagName) && a.value)) return;
    const add = $('#addText'); if (add && add.value) return;
    render();
  }
  window.addEventListener('hashchange', () => { V.editing = null; render(); });

  // ---------- actions ----------
  const metaOf = (v) => ({ videoId: v.videoId, title: v.title, channel: v.channel, duration: v.duration });
  async function changed() { await reload(); render(); scheduleSync(); }
  const parseTagInput = (s) => YVN.uniq(String(s || '').split(/[\s,，]+/).map(YVN.normTag));

  function openEditor(videoId, noteId, index) {
    const v = videoOf(videoId), n = v && v.notes.find((x) => x.id === noteId);
    if (!n) return;
    YVN.Editor.open({
      index,
      images: n.images.map((img) => ({ id: img.id, ts: img.ts, edits: img.edits, load: () => store.getImageBlob(videoId, img, 'orig', driveOrNull()) })),
      onSeek: (ts) => { if (V.videoShell === videoId) seek(ts); else location.hash = `#/video/${videoId}/${ts}`; },
      onSave: async (image, { edits, blob }) => { await store.saveImageEdit(videoId, noteId, image.id, edits, blob); await changed(); },
    });
  }

  async function exportZip(videoId) {
    const v = videoOf(videoId); if (!v) return;
    toast('正在打包…');
    const cat = catOf(v.categoryId), files = [];
    let md = `# ${v.title || v.videoId}\n\n- 影片：${v.url}\n- 頻道：${v.channel || ''}\n- 分類：${cat ? cat.name : '未分類'}\n- 匯出時間：${YVN.fmtDate(Date.now())}\n`;
    let missing = 0;
    for (const n of YVN.liveNotes(v)) {
      md += `\n---\n\n## [${YVN.fmtTime(n.ts)}](https://youtu.be/${v.videoId}?t=${n.ts})\n\n`;
      if (n.tags && n.tags.length) md += n.tags.map((t) => '#' + t).join(' ') + '\n\n';
      if (n.text) md += n.text.trim() + '\n\n';
      for (let i = 0; i < n.images.length; i++) {
        const img = n.images[i];
        const blob = await store.getImageBlob(v.videoId, img, undefined, driveOrNull());
        if (!blob) { missing++; continue; }
        const name = `images/${YVN.fmtTime(img.ts).replace(/:/g, '-')}_${img.id}.webp`;
        files.push({ name, data: blob });
        md += `![${YVN.fmtTime(img.ts)} 步驟 ${i + 1}](${name})\n\n`;
      }
    }
    const safe = (v.title || v.videoId).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    files.unshift({ name: `${safe}.md`, data: md });
    const zip = await YVN.makeZip(files);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zip); a.download = `${safe}.zip`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    toast(missing ? `已匯出（有 ${missing} 張圖片尚未下載，請登入同步後重試）` : '已匯出 ZIP');
  }

  function openSettings() {
    const dlg = $('#dlg');
    const draw = () => {
      dlg.innerHTML = `<h2>分類與設定</h2>
        <h3>主分類</h3>
        <div id="cats">${D.categories.map((c) => `<div class="catrow" data-id="${c.id}"><input type="color" value="${esc(c.color)}" aria-label="代表色"><input class="inp" type="text" value="${esc(c.name)}" maxlength="30" aria-label="分類名稱"><button class="iconbtn" data-del title="刪除分類" aria-label="刪除分類">🗑</button></div>`).join('')}</div>
        <div class="catrow" id="newcat"><input type="color" value="#f5a524" aria-label="新分類代表色"><input class="inp" type="text" placeholder="新增分類…" maxlength="30" aria-label="新分類名稱"><button class="btn sm" data-add>新增</button></div>
        <h3>Google OAuth Client ID（Web application）</h3>
        <input class="inp" id="cid" value="${esc(clientId())}" placeholder="xxxxxxxx.apps.googleusercontent.com" spellcheck="false">
        <p class="muted" style="font-size:13px">只存在這個瀏覽器。${tokenValid() ? '目前已登入。' : ''}</p>
        <div class="actions">${localStorage.getItem('yvnSignedIn') ? '<button class="btn sm danger" data-signout>登出 Google</button>' : ''}<button class="btn sm primary" data-close>完成</button></div>`;
    };
    draw();
    dlg.onclick = async (e) => {
      const t = e.target;
      if (t.matches('[data-close]')) return dlg.close();
      if (t.matches('[data-signout]')) {
        if (token && window.google) google.accounts.oauth2.revoke(token.value, () => {});
        token = null; localStorage.removeItem('yvnToken'); localStorage.removeItem('yvnSignedIn'); renderSync(); return draw();
      }
      if (t.matches('[data-add]')) {
        const row = $('#newcat', dlg), name = $('input[type=text]', row).value.trim();
        if (!name) return;
        await store.upsertCategory({ name, color: $('input[type=color]', row).value });
        await changed(); return draw();
      }
      if (t.matches('[data-del]')) {
        const id = t.closest('.catrow').dataset.id, c = catOf(id);
        if (!confirm(`刪除分類「${c.name}」？影片與筆記不會被刪除。`)) return;
        await store.deleteCategory(id); await changed(); return draw();
      }
    };
    dlg.onchange = async (e) => {
      if (e.target.id === 'cid') { localStorage.setItem('yvnClientId', e.target.value.trim()); tokenClient = null; return; }
      const row = e.target.closest('.catrow[data-id]');
      if (!row) return;
      const name = $('input[type=text]', row).value.trim();
      if (!name) return;
      await store.upsertCategory({ id: row.dataset.id, name, color: $('input[type=color]', row).value });
      await changed();
    };
    if (!dlg.open) dlg.showModal();
  }

  document.addEventListener('click', async (e) => {
    // links rendered from markdown
    const mdA = e.target.closest('.md a.yvn-ts');
    if (mdA) {
      e.preventDefault();
      const vid = mdA.closest('.md').dataset.v;
      if (V.videoShell === vid) seek(+mdA.dataset.ts); else location.hash = `#/video/${vid}/${mdA.dataset.ts}`;
      return;
    }
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const { act, v, n } = t.dataset;
    switch (act) {
      case 'cat': V.cat = t.dataset.cat; sessionStorage.setItem('yvnCat', V.cat); return render();
      case 'sync': return sync(true);
      case 'seek':
        e.preventDefault(); e.stopPropagation();
        if (V.videoShell === v) seek(+t.dataset.ts); else location.hash = `#/video/${v}/${t.dataset.ts}`;
        return;
      case 'open': return openEditor(v, n, +t.dataset.i);
      case 'edit': V.editing = n; render(); { const ta = $('#editText'); if (ta) ta.focus(); } return;
      case 'edit-cancel': V.editing = null; return render();
      case 'edit-save': {
        const vid = videoOf(v), note = vid.notes.find((x) => x.id === n);
        await store.upsertNote(metaOf(vid), { id: n, ts: note.ts, text: $('#editText').value, tags: parseTagInput($('#editTags').value), images: note.images });
        V.editing = null; return changed();
      }
      case 'del-note':
        if (!confirm('確定刪除這則筆記與其截圖？')) return;
        await store.deleteNote(v, n); return changed();
      case 'add-note': {
        const body = $('#addText').value.trim();
        if (!body) return toast('請先輸入內容');
        const ts = player && playerReady ? Math.floor(player.getCurrentTime() || 0) : 0;
        await store.upsertNote(metaOf(videoOf(v)), { ts, text: body, tags: [], images: [] });
        return changed();
      }
      case 'export': return exportZip(v);
      case 'del-video':
        if (!confirm('確定刪除這部影片的所有筆記與截圖？此動作會同步到 Google Drive。')) return;
        await store.deleteVideo(v); await reload(); scheduleSync(); location.hash = '#/'; return;
    }
  });
  document.addEventListener('change', async (e) => {
    const t = e.target.closest('[data-act=set-cat]');
    if (t) { await store.setVideoMeta(t.dataset.v, { categoryId: t.value || null }); await changed(); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      const btn = e.target.id === 'editText' || e.target.id === 'editTags' ? $('[data-act=edit-save]') : e.target.id === 'addText' ? $('[data-act=add-note]') : null;
      if (btn) { e.preventDefault(); btn.click(); }
    } else if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && !$('.yvne-root')) { e.preventDefault(); $('#q').focus(); }
  });
  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#q').value.trim();
    location.hash = !q ? '#/' : q.startsWith('#') && !/\s/.test(q) ? `#/tag/${encodeURIComponent(YVN.normTag(q))}` : `#/search/${encodeURIComponent(q)}`;
  });
  $('#syncBtn').addEventListener('click', () => sync(true));
  $('#settingsBtn').addEventListener('click', openSettings);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && tokenValid()) scheduleSync(); });

  // ---------- boot ----------
  window.yvnApp = { store, reload, render }; // handy for debugging in DevTools
  (async () => {
    await reload();
    render(); renderSync();
    if (tokenValid()) sync(false);
  })();
})();
