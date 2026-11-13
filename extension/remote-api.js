/* YT-Vision-Notes — board API over chrome.runtime messaging (the service worker owns the store).
 * Used by the YouTube content script and by the pop-out window page. */
(function (g) {
  'use strict';
  const YVN = (g.YVN = g.YVN || {});

  YVN.makeRemote = function (opts) {
    opts = opts || {};
    const changeFns = new Set(), msgFns = new Set();

    async function send(type, data) {
      let r;
      try {
        r = await chrome.runtime.sendMessage({ type, ...(data || {}) });
      } catch (e) {
        if (/context invalidated/i.test(e.message || '')) throw new Error('擴充功能已更新，請重新整理此頁面');
        throw e;
      }
      if (!r || !r.ok) throw new Error((r && r.error) || '擴充功能沒有回應');
      return r;
    }

    function connect() {
      try {
        const port = chrome.runtime.connect({ name: opts.portName || 'yvn' });
        port.onMessage.addListener((m) => {
          if (m.type === 'changed') for (const fn of changeFns) fn(m.boardId || null);
          for (const fn of msgFns) fn(m);
        });
        port.onDisconnect.addListener(() => setTimeout(() => { if (chrome.runtime && chrome.runtime.id) connect(); }, 1500));
      } catch (e) { /* extension reloaded */ }
    }
    connect();

    const api = {
      getBoard: (id) => send('getBoard', { id }).then((r) => r.board),
      summaries: () => send('summaries').then((r) => r.sums),
      createBoard: (parentId, o) => send('createBoard', { parentId, o }),
      updateBoard: (id, patch) => send('updateBoard', { id, patch }).then((r) => r.board),
      putItem: (boardId, item, dataURL) => send('putItem', { boardId, item, dataURL }).then((r) => r.item),
      patchItems: (boardId, patches) => send('patchItems', { boardId, patches }),
      deleteItems: (boardId, ids) => send('deleteItems', { boardId, ids }),
      moveItems: (from, to, ids, positions) => send('moveItems', { from, to, ids, positions }),
      getImage: (boardId, item, which) => send('getImage', { image: item.image, which }).then((r) => r.dataURL),
      saveImageEdit: async (boardId, itemId, edits, blob) => send('saveImageEdit', { boardId, itemId, edits, edited: blob ? await YVN.blobToDataURL(blob) : null }),
      search: (q) => send('search', { q }).then((r) => r.results),
      recent: () => send('recent').then((r) => r.ids),
      touchRecent: (id) => send('touchRecent', { id }),
      onChange: (fn) => { changeFns.add(fn); return () => changeFns.delete(fn); },
    };
    return { api, send, onMessage: (fn) => msgFns.add(fn) };
  };
})(typeof self !== 'undefined' ? self : globalThis);
