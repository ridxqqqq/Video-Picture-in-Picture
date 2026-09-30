// 视频画中画 Plus - 后台 Service Worker
// 职责:右键菜单/快捷键开启、消息不通时自动补注入、直链下载、m3u8 嗅探与解析下载编排

const CONTENT_CSS = 'content.css';
const CONTENT_JS = 'content.js';

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: 'nocontent' });
      resolve(res || { ok: false, error: 'noresponse' });
    });
  });
}

// 内容脚本未就绪(扩展刚安装/重载前打开的页面)时自动补注入
async function ensureContent(tabId) {
  const ping = await sendToTab(tabId, { type: 'vpip:query' });
  if (ping.error !== 'nocontent' && ping.error !== 'noresponse') return true;
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: [CONTENT_CSS] });
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_JS], injectImmediately: true });
    const ping2 = await sendToTab(tabId, { type: 'vpip:query' });
    return ping2.error !== 'nocontent' && ping2.error !== 'noresponse';
  } catch (e) {
    return false;
  }
}

async function openInTab(tabId) {
  if (await ensureContent(tabId)) {
    return sendToTab(tabId, { type: 'vpip:open' });
  }
  return { ok: false, error: 'nocontent' };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'vpip-open',
      title: '画中画播放(窗口大小可拖拽)',
      contexts: ['video'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'vpip-open' && tab && tab.id != null) {
    openInTab(tab.id);
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-pip') return;
  chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab && tab.id != null) openInTab(tab.id);
  });
});

// 小窗"解析并下载":直链视频用浏览器下载器后台下载
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'vpip:download' && typeof msg.url === 'string') {
    chrome.downloads.download({ url: msg.url, filename: msg.filename || undefined, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, message: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ ok: true, id: downloadId });
    });
    return true; // 异步响应
  }
  if (msg && msg.type === 'vpip:save-blob' && typeof msg.url === 'string') {
    // offscreen 合并完成的 blob(同扩展 origin)交给 downloads API 落盘
    chrome.downloads.download({ url: msg.url, filename: msg.filename || undefined, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, message: chrome.runtime.lastError.message });
        return;
      }
      sendResponse({ ok: true, id: downloadId });
    });
    return true;
  }
});

/* ---------------- m3u8 嗅探(storage.session,SW 重启不丢) ---------------- */
function isM3u8Url(u) { return /\.m3u8(\?|#|$)/i.test(u); }

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.tabId >= 0 && isM3u8Url(details.url)) pushM3u8(details.tabId, details.url);
}, { urls: ['<all_urls>'] });

chrome.webRequest.onHeadersReceived.addListener((details) => {
  if (details.tabId < 0) return;
  const h = (details.responseHeaders || []).find((x) => x.name.toLowerCase() === 'content-type');
  if (h && /mpegurl/i.test(h.value || '')) pushM3u8(details.tabId, details.url);
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

async function pushM3u8(tabId, url) {
  try {
    const { m3u8 } = await chrome.storage.session.get({ m3u8: {} });
    const arr = m3u8[tabId] || [];
    if (!arr.includes(url)) arr.push(url);
    m3u8[tabId] = arr.slice(-10);
    await chrome.storage.session.set({ m3u8 });
  } catch {}
}

async function getCapturedM3u8(tabId) {
  try {
    const { m3u8 } = await chrome.storage.session.get({ m3u8: {} });
    const arr = m3u8[tabId] || [];
    return arr.length ? arr[arr.length - 1] : null;
  } catch { return null; }
}

/* ---------------- m3u8 解析下载编排(offscreen 管线) ---------------- */
let m3u8Busy = false;
let m3u8Job = null; // { tabId, dlId }

// MV3:runtime.sendMessage 从后台广播不会投递给 content scripts,需用 tabs.sendMessage 转发
function forwardToJob(msg) {
  if (!m3u8Job || m3u8Job.tabId == null) return;
  if (msg.dlId && m3u8Job.dlId && msg.dlId !== m3u8Job.dlId) return;
  try {
    chrome.tabs.sendMessage(m3u8Job.tabId, msg).catch(() => {});
  } catch {}
}

async function ensureOffscreen(dbgSW) {
  let hasDoc = 'n/a';
  try { hasDoc = await chrome.offscreen.hasDocument(); } catch (e) { hasDoc = 'err:' + String(e).slice(0, 60); }
  if (dbgSW) dbgSW('hasDocument=' + hasDoc);
  const tryCreate = async () => {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'm3u8 视频分片下载、解密与合并',
      });
      return true;
    } catch { return false; }
  };
  await tryCreate();
  let ready = await pingOffscreenUntilReady(6000);
  if (!ready) {
    await tryCreate();
    ready = await pingOffscreenUntilReady(8000);
  }
  if (!ready) throw new Error('offscreen 文档未能就绪');
  if (dbgSW) dbgSW('offscreen ready');
}

// 用 ping/pong 探活:offscreen 未创建或脚本未加载完时自动重试,确保 start 消息不丢失
function pingOffscreenUntilReady(timeout = 8000) {
  return new Promise((res) => {
    const deadline = Date.now() + timeout;
    const tick = () => {
      if (Date.now() > deadline) return res(false);
      chrome.runtime.sendMessage({ type: 'vpip:m3u8-ping' }, (r) => {
        if (chrome.runtime.lastError || !(r && r.pong)) {
          setTimeout(tick, 350);
          return;
        }
        res(true);
      });
    };
    tick();
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'vpip:get-captured-m3u8') {
    const tabId = sender.tab && sender.tab.id;
    getCapturedM3u8(tabId).then((url) => sendResponse({ ok: !!url, url }));
    return true;
  }
  if (msg.type === 'vpip:download-m3u8') {
    if (m3u8Busy) {
      sendResponse({ ok: false, message: '已有 m3u8 下载任务进行中,请稍候' });
      return;
    }
    m3u8Busy = true;
    m3u8Job = { tabId: sender && sender.tab ? sender.tab.id : null, dlId: msg.dlId };
    const dbgSW = (t) => forwardToJob({ type: 'vpip:m3u8-debug', dlId: msg.dlId, text: t });
    ensureOffscreen(dbgSW).then(() => {
      dbgSW('sending m3u8-start');
      chrome.runtime.sendMessage({ type: 'vpip:m3u8-start', url: msg.url, filename: msg.filename, dlId: msg.dlId });
      sendResponse({ ok: true, started: true });
    }).catch((e) => {
      m3u8Busy = false;
      dbgSW('ensure failed: ' + String((e && e.message) || e).slice(0, 50));
      sendResponse({ ok: false, message: String((e && e.message) || e) });
    });
    return true;
  }
  if (msg.type === 'vpip:m3u8-progress' || msg.type === 'vpip:m3u8-debug') {
    forwardToJob(msg);
    return;
  }
  if (msg.type === 'vpip:m3u8-done') {
    m3u8Busy = false;
    forwardToJob(msg);
    setTimeout(() => { try { chrome.offscreen.closeDocument(); } catch {} }, 2000);
    return;
  }
});
