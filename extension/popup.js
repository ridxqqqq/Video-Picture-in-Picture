// 视频画中画 Plus - 弹窗逻辑
const $ = (s) => document.querySelector(s);
const statusEl = $('#status');
const openBtn = $('#open');
const savedEl = $('#saved');
const DEFAULTS = { w: 512, h: 320 };

function setStatus(html, tone = '') {
  statusEl.innerHTML = html;
  statusEl.className = 'card ' + tone;
}

function send(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: 'nocontent' });
      resolve(res || { ok: false, error: 'noresponse' });
    });
  });
}

// 确保页面里已注入内容脚本:扩展安装/重载前就打开的页面自动补注入,免刷新
async function ensureReady(tabId) {
  const ping = await send(tabId, { type: 'vpip:query' });
  if (ping.error !== 'nocontent' && ping.error !== 'noresponse') return { ok: true, injected: false };
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'], injectImmediately: true });
    const ping2 = await send(tabId, { type: 'vpip:query' });
    if (ping2.error === 'nocontent' || ping2.error === 'noresponse') return { ok: false, reason: 'nocontent' };
    return { ok: true, injected: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

function unsupportedHint(reason) {
  if (/file:/i.test(reason) || /Cannot access/i.test(reason)) {
    return '<span class="bad">无法访问此页面</span><span class="muted">本地文件请在扩展详情中开启「允许访问文件网址」</span>';
  }
  return '<span class="bad">此页面不支持画中画</span><span class="muted">浏览器内置页面(chrome://、应用商店等)无法注入,请在普通网页上使用</span>';
}

function renderQuery(res) {
  if (res.error === 'nocontent' || res.error === 'noresponse') {
    setStatus('<span class="warn">页面连接异常</span><span class="muted">请刷新页面后重试</span>', 'warn');
  } else if (res.docPip) {
    setStatus('<span class="good">● 画中画运行中</span><span class="muted">点小窗上的返回按钮即可还原视频</span>', 'ok');
  } else if (!res.videos) {
    setStatus('<span class="warn">未检测到视频</span><span class="muted">请先打开并播放网页中的视频</span>', 'warn');
  } else {
    setStatus(`<span class="good">● 检测到 ${res.videos} 个视频</span><span class="muted">点击下方按钮开启</span>`, 'ok');
  }
}

(async () => {
  // ---- 尺寸偏好 ----
  const prefs = await chrome.storage.local.get(DEFAULTS);
  $('#w').value = prefs.w;
  $('#h').value = prefs.h;

  $('#save').addEventListener('click', async () => {
    const w = Math.max(260, Math.min(3840, Number($('#w').value) || DEFAULTS.w));
    const h = Math.max(160, Math.min(2160, Number($('#h').value) || DEFAULTS.h));
    $('#w').value = w;
    $('#h').value = h;
    await chrome.storage.local.set({ w, h });
    savedEl.textContent = '已保存 ✓';
    setTimeout(() => (savedEl.textContent = ''), 1800);
  });

  $('#reset').addEventListener('click', async () => {
    $('#w').value = DEFAULTS.w;
    $('#h').value = DEFAULTS.h;
    await chrome.storage.local.set(DEFAULTS);
    savedEl.textContent = '已恢复默认';
    setTimeout(() => (savedEl.textContent = ''), 1800);
  });

  // ---- 连接页面 ----
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) {
    setStatus('<span class="bad">未找到活动标签页</span>');
    return;
  }

  setStatus('连接页面中…');
  const st = await ensureReady(tab.id);
  if (!st.ok) {
    setStatus(unsupportedHint(st.reason || ''));
  } else {
    if (st.injected) {
      setStatus('<span class="good">● 已自动连接页面</span><span class="muted">正在检测视频…</span>', 'ok');
    }
    const res = await send(tab.id, { type: 'vpip:query' });
    renderQuery(res);
  }

  openBtn.addEventListener('click', async () => {
    openBtn.disabled = true;
    const st2 = await ensureReady(tab.id);
    if (!st2.ok) {
      setStatus(unsupportedHint(st2.reason || ''));
      openBtn.disabled = false;
      return;
    }
    const r = await send(tab.id, { type: 'vpip:open' });
    openBtn.disabled = false;
    if (r.ok) {
      setStatus('<span class="good">● 已开启画中画</span><span class="muted">拖拽小窗边缘或四角可调整宽高</span>', 'ok');
    } else if (r.error === 'novideo') {
      setStatus('<span class="warn">未找到视频</span><span class="muted">请先在页面中播放视频</span>', 'warn');
    } else if (r.error === 'NotAllowedError') {
      setStatus('<span class="warn">需要一次点击确认</span><span class="muted">页面中已弹出确认按钮,点击它即可开启</span>', 'warn');
    } else {
      setStatus('<span class="bad">开启失败</span><span class="muted">页面连接异常,请刷新页面后重试</span>');
    }
  });
})();
