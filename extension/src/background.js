const MEDIA_URL = /^https:\/\/pbs\.twimg\.com\/media\/[A-Za-z0-9_-]+(\?|$)/;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'xlens:fetch') return false;
  if (typeof msg.url !== 'string' || !MEDIA_URL.test(msg.url)) {
    sendResponse({ ok: false, error: 'not an X media URL' });
    return false;
  }
  fetch(msg.url, { credentials: 'omit' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get('content-type') || '';
      sendResponse({ ok: true, type, data: toBase64(await res.arrayBuffer()) });
    })
    .catch((err) => sendResponse({ ok: false, error: String(err) }));
  return true;
});

// ---------------------------------------------------------------------------
// Right-click menu
// ---------------------------------------------------------------------------
const MENU_ID = 'xlens-copy-original';

async function modes() {
  return (await chrome.storage.session.get('lensModes')).lensModes || {};
}

async function syncMenu() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const on = !!(tab && (await modes())[tab.id]);
  chrome.contextMenus.update(MENU_ID, { visible: !on }, () => void chrome.runtime.lastError);
}

function createMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '拡大画像をコピー',
      contexts: ['image'],
      documentUrlPatterns: ['https://x.com/*', 'https://twitter.com/*'],
      targetUrlPatterns: ['https://pbs.twimg.com/media/*'],
    });
    syncMenu();
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove('lensMode');
  createMenu();
});
chrome.runtime.onStartup.addListener(syncMenu);
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'xlens:lens-mode' || !sender.tab?.id) return false;
  modes().then(async (m) => {
    m[sender.tab.id] = !!msg.on;
    await chrome.storage.session.set({ lensModes: m });
    syncMenu();
  });
  return false;
});
chrome.tabs.onActivated.addListener(syncMenu);
chrome.windows.onFocusChanged.addListener(syncMenu);
chrome.tabs.onRemoved.addListener((tabId) => {
  modes().then((m) => {
    if (!(tabId in m)) return;
    delete m[tabId];
    chrome.storage.session.set({ lensModes: m });
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id || !info.srcUrl) return;
  chrome.tabs.sendMessage(
    tab.id,
    { type: 'xlens:copy-original', src: info.srcUrl },
    { frameId: info.frameId ?? 0 },
    () => void chrome.runtime.lastError,
  );
});
