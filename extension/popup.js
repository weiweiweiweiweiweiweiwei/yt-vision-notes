const $ = (id) => document.getElementById(id);
const send = (type, data) => chrome.runtime.sendMessage({ type, ...(data || {}) });
let status = {};

function fmt(ms) { return ms ? new Date(ms).toLocaleString('zh-TW', { hour12: false }) : '尚未同步'; }

function render(r) {
  if (r && r.status) status = r.status;
  $('state').textContent = status.syncing ? '同步中…' : status.signedIn ? `已連線 Google Drive · 上次同步 ${fmt(status.lastSync)}` : '尚未登入 Google（筆記目前只存在本機）';
  if (r && r.videoCount != null) $('counts').textContent = `本機共有 ${r.videoCount} 部影片、${r.noteCount} 則筆記`;
  $('auth').textContent = status.signedIn ? '登出' : '登入 Google';
  $('auth').classList.toggle('primary', !status.signedIn);
  $('sync').disabled = !status.signedIn || status.syncing;
  $('err').textContent = status.error ? '錯誤：' + status.error : '';
  if (document.activeElement !== $('web')) $('web').value = status.webUrl || '';
}

async function refresh() { render(await send('getStatus')); }

$('auth').onclick = async () => {
  $('auth').disabled = true;
  const r = await send(status.signedIn ? 'signOut' : 'signIn');
  $('auth').disabled = false;
  if (r && !r.ok) $('err').textContent = '登入失敗：' + r.error + '（請確認 manifest.json 的 oauth2.client_id 已換成你的用戶端 ID）';
  refresh();
};
$('sync').onclick = async () => { $('sync').disabled = true; await send('syncNow'); refresh(); };
$('web').onchange = () => send('setWebUrl', { url: $('web').value.trim() });
$('open').onclick = async () => {
  const url = $('web').value.trim();
  if (!url) return ($('err').textContent = '請先填入知識庫網站網址');
  await send('setWebUrl', { url });
  chrome.tabs.create({ url });
};
chrome.runtime.onMessage.addListener((m) => { if (m.type === 'status') render({ status: m.status }); });
refresh();
