const $ = (id) => document.getElementById(id);
const send = (type, data) => chrome.runtime.sendMessage({ type, ...(data || {}) });
let status = {};

function fmt(ms) { return ms ? new Date(ms).toLocaleString('zh-TW', { hour12: false }) : 'Not synced yet'; }

function render(r) {
  if (r && r.status) status = r.status;
  $('state').textContent = status.syncing ? 'Syncing…' : status.signedIn ? `Connected to Google Drive · last sync ${fmt(status.lastSync)}` : 'Not signed in to Google (notes are only on this computer)';
  if (r && r.boardCount != null) $('counts').textContent = `${r.boardCount} boards, ${r.itemCount} cards on this computer`;
  $('auth').textContent = status.signedIn ? 'Sign out' : 'Sign in with Google';
  $('auth').classList.toggle('primary', !status.signedIn);
  $('sync').disabled = !status.signedIn || status.syncing;
  $('err').textContent = status.error ? 'Error: ' + status.error : '';
  if (document.activeElement !== $('web')) $('web').value = status.webUrl || '';
}

async function refresh() { render(await send('getStatus')); }

$('auth').onclick = async () => {
  $('auth').disabled = true;
  const r = await send(status.signedIn ? 'signOut' : 'signIn');
  $('auth').disabled = false;
  if (r && !r.ok) $('err').textContent = 'Sign-in failed: ' + r.error + ' (check that oauth2.client_id in manifest.json is your client ID)';
  refresh();
};
$('sync').onclick = async () => { $('sync').disabled = true; await send('syncNow'); refresh(); };
$('web').onchange = () => send('setWebUrl', { url: $('web').value.trim() });
$('open').onclick = async () => {
  const url = $('web').value.trim();
  if (!url) return ($('err').textContent = 'Enter the knowledge base URL first');
  await send('setWebUrl', { url });
  chrome.tabs.create({ url });
};
chrome.runtime.onMessage.addListener((m) => { if (m.type === 'status') render({ status: m.status }); });
refresh();

// Gemini (AI notes) settings: stored locally only
chrome.storage.local.get(['geminiKey', 'geminiModel']).then((r) => { $('gkey').value = r.geminiKey || ''; $('gmodel').value = r.geminiModel || ''; });
$('gkey').onchange = () => chrome.storage.local.set({ geminiKey: $('gkey').value.trim() });
$('gmodel').onchange = () => chrome.storage.local.set({ geminiModel: $('gmodel').value.trim() });
