// 视频画中画 Plus - 内容脚本
// 核心能力:
//  1. 视频悬浮按钮(hover 出现)一键开启画中画
//  2. Document PiP 自定义窗口:控制条 + 四边/四角拖拽调整宽高 + 尺寸记忆
//  3. 顶层不可用时回退到原生 video.requestPictureInPicture
(() => {
  'use strict';
  // 每个 isolated world 只初始化一次;扩展重载后新 world 会接管(标志存于 window,world 间隔离)
  if (window.__vpipLoaded) return;
  window.__vpipLoaded = true;

  // 清理旧上下文残留(扩展重载后旧脚本的元素/窗口)
  try {
    const staleBtn = document.getElementById('__vpip_hover_btn');
    if (staleBtn) staleBtn.remove();
    const staleConfirm = document.querySelector('.__vpip_confirm');
    if (staleConfirm) staleConfirm.remove();
    // 接管遗留的画中画窗口:把视频放回页面并关闭
    if (window === window.top && window.documentPictureInPicture && documentPictureInPicture.window) {
      const pw = documentPictureInPicture.window;
      const v = pw.document.querySelector('.vp-stage video');
      const ph = document.querySelector('.__vpip_placeholder');
      if (v && ph && ph.parentNode) {
        ph.parentNode.insertBefore(v, ph);
        ph.remove();
      }
      pw.close();
    }
  } catch {}

  const MIN_W = 260, MIN_H = 160, DEFAULT_W = 512, DEFAULT_H = 320;

  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

  /* ---------------- 工具 ---------------- */
  function visibleVideos() {
    return [...document.querySelectorAll('video')].filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width > 40 && r.height > 40;
    });
  }

  function pickVideo() {
    const vs = visibleVideos();
    if (!vs.length) return document.querySelector('video');
    let best = vs[0], bestA = 0;
    for (const v of vs) {
      const r = v.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > bestA) { bestA = a; best = v; }
    }
    return best;
  }

  function findVideoFrom(t) {
    if (!t || t.nodeType !== 1) return null;
    if (t.tagName === 'VIDEO') return t;
    let n = t;
    for (let i = 0; n && n !== document.body && i < 6; i++, n = n.parentElement) {
      const v = n.querySelector && n.querySelector('video');
      if (v) return v;
    }
    return null;
  }

  let toastEl = null, toastTimer = 0;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = '__vpip_toast';
      (document.body || document.documentElement).appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toastEl) toastEl.style.display = 'none'; }, 2600);
  }

  function throttle(fn, ms) {
    let last = 0, timer = 0, lastArgs = null;
    const run = () => { last = Date.now(); timer = 0; fn(...lastArgs); };
    return (...args) => {
      lastArgs = args;
      const now = Date.now();
      if (now - last >= ms) run();
      else if (!timer) timer = setTimeout(run, ms - (now - last));
    };
  }

  /* ---------------- 悬浮按钮 ---------------- */
  const BTN_HTML =
    '<svg class="vp-ico" viewBox="0 0 24 24" fill="none"><rect x="2" y="4" width="20" height="14" rx="2.5" stroke="#fff" stroke-width="2"/><rect x="12" y="11" width="9" height="7" rx="1.5" fill="#fff"/><path d="M8 8.5v5l4.2-2.5z" fill="#fff"/></svg><span>画中画</span>';

  const btn = document.createElement('div');
  btn.id = '__vpip_hover_btn';
  btn.innerHTML = BTN_HTML;
  (document.body || document.documentElement).appendChild(btn);

  let btnVideo = null, hideTimer = 0;

  function ensureBtnParent(video) {
    const fs = document.fullscreenElement;
    const target = fs && video && (fs === video || fs.contains(video)) ? fs : (document.body || document.documentElement);
    if (btn.parentNode !== target) target.appendChild(btn);
  }

  function showBtnFor(video) {
    const r = video.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return;
    ensureBtnParent(video);
    btnVideo = video;
    btn.style.left = clamp(r.left + 10, 4, window.innerWidth - 110) + 'px';
    btn.style.top = clamp(r.top + 10, 4, window.innerHeight - 42) + 'px';
    btn.style.display = 'flex';
    clearTimeout(hideTimer);
  }
  function hideBtnSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { btn.style.display = 'none'; btnVideo = null; }, 180);
  }

  btn.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  btn.addEventListener('mouseleave', hideBtnSoon);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const v = btnVideo;
    btn.style.display = 'none';
    btnVideo = null;
    if (v) handleToggle(v);
  }, true);

  document.addEventListener('mouseover', (e) => {
    if (btn.contains(e.target)) return;
    if (e.target.closest && e.target.closest('.__vpip_confirm')) return;
    const v = findVideoFrom(e.target);
    if (v) showBtnFor(v);
  }, true);
  document.addEventListener('mouseout', (e) => {
    if (e.relatedTarget && btn.contains(e.relatedTarget)) return;
    if (findVideoFrom(e.target) || e.target === btn) hideBtnSoon();
  }, true);

  /* ---------------- 手势受限时的确认层 ---------------- */
  function showConfirmLayer(video) {
    if (document.querySelector('.__vpip_confirm')) return;
    const layer = document.createElement('div');
    layer.className = '__vpip_confirm';
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = '点击开启画中画';
    b.addEventListener('click', () => { layer.remove(); handleToggle(video); });
    layer.appendChild(b);
    (document.body || document.documentElement).appendChild(layer);
    setTimeout(() => layer.remove(), 5000);
  }

  /* ---------------- 开启 / 关闭 ---------------- */
  async function handleToggle(video) {
    const r = await togglePip(video);
    if (!r.ok) {
      if (r.error === 'NotAllowedError') showConfirmLayer(video);
      else toast('画中画开启失败：' + (r.message || r.error || '未知错误'));
    }
  }

  async function togglePip(video) {
    try {
      // 已有 Document PiP 窗口 → 视为关闭
      if (window.documentPictureInPicture && documentPictureInPicture.window) {
        documentPictureInPicture.window.close();
        return { ok: true, closed: true };
      }
      // 顶层 + 支持 Document PiP → 自定义可调宽高窗口
      if (window === window.top && 'documentPictureInPicture' in window) {
        return await openDocPip(video);
      }
      // 回退:原生系统画中画(同样支持拖拽调整大小)
      return await nativePip(video);
    } catch (err) {
      return { ok: false, error: (err && err.name) || 'Error', message: (err && err.message) || String(err) };
    }
  }

  async function nativePip(video) {
    if (document.pictureInPictureElement === video) {
      await document.exitPictureInPicture();
      return { ok: true, closed: true };
    }
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    await video.requestPictureInPicture();
    return { ok: true, mode: 'native' };
  }

  /* ---------------- Document PiP 自定义窗口 ---------------- */
  const I = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
    vol: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M18.8 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>',
    mute: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    restore: '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 9h8a7 7 0 0 1 7 7v3" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 3v10m0 0l-4-4m4 4l4-4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };

  const PIP_CSS = `
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; overflow: hidden;
      font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
    .vp-stage { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: #000; }
    .vp-stage video { width: 100%; height: 100%; object-fit: contain; background: #000; }
    .vp-controls { position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 6px;
      padding: 8px 10px; background: linear-gradient(to top, rgba(2,6,23,.92), rgba(2,6,23,.45));
      opacity: .45; transition: opacity .18s; }
    html:hover .vp-controls { opacity: 1; }
    .vp-ctl { flex: none; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
      border: 0; border-radius: 8px; background: transparent; color: #e2e8f0; cursor: pointer; padding: 0; }
    .vp-ctl:hover { background: rgba(255,255,255,.14); }
    .vp-ctl:disabled { opacity: .35; cursor: default; }
    .vp-ctl svg { width: 17px; height: 17px; fill: currentColor; display: block; }
    .vp-time { flex: none; color: #cbd5e1; font-size: 12px; font-variant-numeric: tabular-nums; }
    .vp-seek { flex: 1 1 auto; min-width: 40px; accent-color: #818cf8; cursor: pointer; }
    .vp-seek:disabled { opacity: .3; cursor: default; }
    .vp-vol { flex: none; width: 64px; accent-color: #818cf8; cursor: pointer; }
    .vp-size { flex: none; color: #94a3b8; font-size: 12px; font-variant-numeric: tabular-nums;
      min-width: 58px; text-align: center; }
    .vp-tip { position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
      background: rgba(15,23,42,.88); color: #e2e8f0; font-size: 12px; padding: 6px 14px;
      border-radius: 999px; pointer-events: none; opacity: 0; transition: opacity .3s; z-index: 8; white-space: nowrap; }
    .vp-tip.show { opacity: 1; }
    .vp-apply { position: absolute; left: 50%; top: 42%; transform: translate(-50%, -50%); z-index: 10;
      padding: 10px 20px; border: 0; border-radius: 999px; background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff; font: 600 13.5px system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
      cursor: pointer; box-shadow: 0 8px 28px rgba(99, 102, 241, 0.5); animation: vpipPop .18s ease-out; }
    .vp-apply:hover { filter: brightness(1.1); }
    @keyframes vpipPop { from { transform: translate(-50%, -50%) scale(.85); opacity: 0; }
      to { transform: translate(-50%, -50%) scale(1); opacity: 1; } }
    @media (max-width: 480px) { .vp-time, .vp-vol { display: none; } }
    @media (max-width: 360px) { .vp-seek { display: none; } }
    .vp-rs { position: fixed; z-index: 9; }
    .vp-rs-n  { top: 0; left: 10px; right: 10px; height: 5px; cursor: ns-resize; }
    .vp-rs-s  { bottom: 0; left: 10px; right: 10px; height: 5px; cursor: ns-resize; }
    .vp-rs-w  { left: 0; top: 10px; bottom: 10px; width: 5px; cursor: ew-resize; }
    .vp-rs-e  { right: 0; top: 10px; bottom: 10px; width: 5px; cursor: ew-resize; }
    .vp-rs-ne { top: 0; right: 0; width: 14px; height: 14px; cursor: nesw-resize; }
    .vp-rs-nw { top: 0; left: 0; width: 14px; height: 14px; cursor: nwse-resize; }
    .vp-rs-se { bottom: 0; right: 0; width: 16px; height: 16px; cursor: nwse-resize; }
    .vp-rs-sw { bottom: 0; left: 0; width: 14px; height: 14px; cursor: nesw-resize; }
  `;

  /* ---------------- 视频解析下载 ---------------- */
  function resolveVideoSource(video) {
    if (video.srcObject) return { kind: 'stream' };
    let u = video.currentSrc || video.src || '';
    if (!u) {
      const s = video.querySelector('source[src]') || (video.parentElement && video.parentElement.querySelector('source[src]'));
      if (s) u = s.src;
    }
    if (!u) return { kind: 'none' };
    if (/\.m3u8(\?|#|$)/i.test(u)) return { kind: 'hls', url: u };
    if (/\.mpd(\?|#|$)/i.test(u)) return { kind: 'dash', url: u };
    if (u.startsWith('blob:')) return { kind: 'blob', url: u };
    if (/^https?:/i.test(u) || u.startsWith('data:')) return { kind: 'direct', url: u };
    return { kind: 'unknown', url: u };
  }

  function sanitizeFilename(name, fallback) {
    let n = String(name || '').replace(/[\\/:*?"<>|\r\n]+/g, '_').replace(/^\.+/, '').trim();
    if (!n) n = fallback;
    return n.slice(0, 120);
  }

  function suggestFilename(video) {
    const u = video.currentSrc || video.src || '';
    try {
      const url = new URL(u);
      const last = decodeURIComponent((url.pathname.split('/').pop() || '').trim());
      if (/\.[a-z0-9]{2,5}$/i.test(last)) return sanitizeFilename(last, 'video.mp4');
      const base = (document.title || url.hostname || 'video').replace(/\s+/g, ' ').trim().slice(0, 60);
      return sanitizeFilename(base + '.mp4', 'video.mp4');
    } catch {
      return sanitizeFilename('video.mp4', 'video.mp4');
    }
  }

  async function handleDownload(video) {
    const src = resolveVideoSource(video);
    if (src.kind === 'stream') { toast('直播 / 摄像头画面无法下载'); return; }
    if (src.kind === 'none' || src.kind === 'unknown') { toast('未找到可下载的视频地址'); return; }
    if (src.kind === 'dash') { toast('DASH 流媒体暂不支持下载'); return; }
    if (src.kind === 'hls') { startM3u8Download(src.url); return; }

    const filename = suggestFilename(video);

    if (src.kind === 'direct') {
      toast('开始下载:' + filename);
      chrome.runtime.sendMessage({ type: 'vpip:download', url: src.url, filename }, (resp) => {
        if (chrome.runtime.lastError) { toast('下载失败:' + String(chrome.runtime.lastError.message).slice(0, 60)); return; }
        if (resp && resp.ok) toast('已开始下载 ✓ ' + filename);
        else toast('下载失败:' + String((resp && resp.message) || '未知原因').slice(0, 60));
      });
      return;
    }

    // blob:先查后台嗅探到的 m3u8(MSE 播放场景);无捕获则同源读取保存
    chrome.runtime.sendMessage({ type: 'vpip:get-captured-m3u8' }, (cap) => {
      if (chrome.runtime.lastError) {
        toast('下载失败:' + String(chrome.runtime.lastError.message).slice(0, 60));
        return;
      }
      if (cap && cap.ok && cap.url) {
        startM3u8Download(cap.url);
        return;
      }
      (async () => {
        try {
          toast('解析视频数据…');
          const resp = await fetch(src.url);
          const blob = await resp.blob();
          if (!blob || !blob.size) { toast('该视频为流式加载(MSE),暂不支持完整下载'); return; }
          const a = document.createElement('a');
          a.href = src.url;
          a.download = filename;
          (document.body || document.documentElement).appendChild(a);
          a.click();
          a.remove();
          toast('已开始保存 ✓ ' + filename);
        } catch (err) {
          toast('该视频无法直接下载(' + String((err && err.message) || '跨源限制').slice(0, 50) + ')');
        }
      })();
    });
  }

  function startM3u8Download(url) {
    const dlId = 'dl' + Math.random().toString(36).slice(2, 10);
    let filename = sanitizeFilename((document.title || 'video').replace(/\s+/g, ' ').trim().slice(0, 60) + '.ts', 'video.ts');
    try {
      const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
      if (/\.m3u8$/i.test(last)) filename = sanitizeFilename(last.replace(/\.m3u8.*$/i, '') + '.ts', filename);
    } catch {}
    toast('开始解析 m3u8…');
    chrome.runtime.sendMessage({ type: 'vpip:download-m3u8', url, filename, dlId }, (resp) => {
      if (chrome.runtime.lastError) { toast('m3u8 任务失败:' + String(chrome.runtime.lastError.message).slice(0, 50)); return; }
      if (resp && !resp.ok) { toast('m3u8 任务失败:' + String(resp.message || '').slice(0, 50)); return; }
      toast('m3u8 解析中,分片将自动合并为 ' + filename);
    });
  }

  function parkVideo(video) {
    const parent = video.parentNode, next = video.nextSibling;
    const ph = document.createElement('div');
    ph.className = '__vpip_placeholder';
    const r = video.getBoundingClientRect();
    ph.style.width = Math.round(r.width) + 'px';
    ph.style.height = Math.round(r.height) + 'px';
    ph.textContent = '画中画播放中';
    if (parent) parent.insertBefore(ph, next);
    return { parent, next, ph };
  }

  function unparkVideo(video, park) {
    if (park.ph && park.ph.parentNode) {
      park.ph.parentNode.insertBefore(video, park.ph);
      park.ph.remove();
    } else if (park.parent && park.parent.isConnected) {
      park.parent.insertBefore(video, park.next || null);
    } else {
      document.body.appendChild(video);
    }
  }

  async function openDocPip(video) {
    if (document.pictureInPictureElement) {
      try { await document.exitPictureInPicture(); } catch {}
    }
    const prefs = await chrome.storage.local.get({ w: DEFAULT_W, h: DEFAULT_H });
    const maxW = (window.screen && screen.availWidth) || 1920;
    const maxH = (window.screen && screen.availHeight) || 1080;
    const W = clamp(Math.round(prefs.w) || DEFAULT_W, MIN_W, maxW);
    const H = clamp(Math.round(prefs.h) || DEFAULT_H, MIN_H, maxH);

    const pipWin = await documentPictureInPicture.requestWindow({ width: W, height: H });
    // resizeTo 的参数是窗口外框尺寸,先测量边框差,统一以“内容尺寸”为准
    const openerW = window.innerWidth || 1920;
    const openerH = window.innerHeight || 1080;
    const bx = Math.max(0, (pipWin.outerWidth || 0) - (pipWin.innerWidth || 0));
    const by = Math.max(0, (pipWin.outerHeight || 0) - (pipWin.innerHeight || 0));
    const availW = (window.screen && screen.availWidth) || 1920;
    const availH = (window.screen && screen.availHeight) || 1080;
    const resizeToInner = (w, h) => {
      pipWin.resizeTo(
        Math.min(Math.round(w) + bx, availW),
        Math.min(Math.round(h) + by, availH)
      );
    };
    let autoSizeOk = true;
    try { resizeToInner(W, H); } catch { autoSizeOk = false; }
    const doc = pipWin.document;
    doc.title = '画中画';

    const style = doc.createElement('style');
    style.textContent = PIP_CSS;
    doc.head.appendChild(style);

    doc.body.innerHTML = `
      <div class="vp-stage"></div>
      <div class="vp-tip">拖拽边缘 / 四角调整大小 · 双击角部恢复默认</div>
      <div class="vp-controls">
        <button class="vp-ctl" id="vp-play" title="播放 / 暂停">${I.pause}</button>
        <span class="vp-time" id="vp-cur">0:00</span>
        <input class="vp-seek" id="vp-seek" type="range" min="0" max="1000" value="0" step="1">
        <span class="vp-time" id="vp-dur">0:00</span>
        <button class="vp-ctl" id="vp-mute" title="静音">${I.vol}</button>
        <input class="vp-vol" id="vp-vol" type="range" min="0" max="1" step="0.01" value="${video.volume}">
        <span class="vp-size" id="vp-size"></span>
        <button class="vp-ctl" id="vp-dl" title="解析并下载视频">${I.download}</button>
        <button class="vp-ctl" id="vp-restore" title="放回页面">${I.restore}</button>
      </div>
      ${['n', 's', 'w', 'e', 'ne', 'nw', 'se', 'sw'].map((d) => `<div class="vp-rs vp-rs-${d}" data-dir="${d}"></div>`).join('')}
    `;

    const stage = doc.querySelector('.vp-stage');
    const wasControls = video.controls;
    video.controls = false;

    const park = parkVideo(video);
    stage.appendChild(video);

    const $ = (sel) => doc.querySelector(sel);
    const playBtn = $('#vp-play'), curEl = $('#vp-cur'), durEl = $('#vp-dur'),
      seek = $('#vp-seek'), muteBtn = $('#vp-mute'), vol = $('#vp-vol'),
      sizeEl = $('#vp-size'), tipEl = $('.vp-tip'), restoreBtn = $('#vp-restore');

    const fmt = (s) => {
      if (!isFinite(s) || s < 0) return '直播';
      s = Math.floor(s);
      const m = Math.floor(s / 60), r = s % 60, h = Math.floor(m / 60);
      return h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`
               : `${m}:${String(r).padStart(2, '0')}`;
    };

    const updateSize = () => { sizeEl.textContent = `${pipWin.innerWidth} × ${pipWin.innerHeight}`; };
    updateSize();

    // ---- 播放 / 暂停 ----
    const syncPlay = () => { playBtn.innerHTML = video.paused ? I.play : I.pause; };
    syncPlay();
    playBtn.addEventListener('click', () => {
      if (video.paused) video.play().catch(() => {}); else video.pause();
    });
    stage.addEventListener('click', (e) => {
      if (e.target === video) { if (video.paused) video.play().catch(() => {}); else video.pause(); }
    });

    // ---- 进度 ----
    const hasDuration = () => isFinite(video.duration) && video.duration > 0;
    let seeking = false;
    const syncDur = () => {
      seek.disabled = !hasDuration();
      durEl.textContent = hasDuration() ? fmt(video.duration) : '直播';
    };
    syncDur();
    const onTime = () => {
      curEl.textContent = fmt(video.currentTime);
      if (!seeking && hasDuration()) seek.value = Math.round((video.currentTime / video.duration) * 1000);
    };
    seek.addEventListener('pointerdown', () => { seeking = true; });
    seek.addEventListener('pointerup', () => { seeking = false; });
    seek.addEventListener('input', () => { if (hasDuration()) video.currentTime = (seek.value / 1000) * video.duration; });

    // ---- 音量 ----
    const syncVol = () => {
      muteBtn.innerHTML = (video.muted || video.volume === 0) ? I.mute : I.vol;
      vol.value = video.muted ? 0 : video.volume;
    };
    muteBtn.addEventListener('click', () => { video.muted = !video.muted; });
    vol.addEventListener('input', () => {
      video.volume = Number(vol.value);
      video.muted = Number(vol.value) === 0;
    });
    syncVol();

    // ---- video 事件绑定(统一登记,关闭时移除) ----
    const vL = [];
    const vOn = (type, fn) => { video.addEventListener(type, fn); vL.push([type, fn]); };
    vOn('play', syncPlay);
    vOn('pause', syncPlay);
    vOn('timeupdate', onTime);
    vOn('durationchange', syncDur);
    vOn('volumechange', syncVol);

    restoreBtn.addEventListener('click', () => pipWin.close());

    const dlBtn = $('#vp-dl');
    dlBtn.addEventListener('click', () => { handleDownload(video); });

    // 若浏览器忽略了初始尺寸(当前窗口与期望偏差过大),提供一键恢复记忆尺寸的兜底按钮
    const showApplyBtn = () => {
      if (doc.querySelector('.vp-apply')) return;
      const b = doc.createElement('button');
      b.className = 'vp-apply';
      b.type = 'button';
      b.textContent = `应用上次尺寸 ${W} × ${H}`;
      b.addEventListener('click', () => {
        try { resizeToInner(W, H); } catch {}
        b.remove();
      });
      doc.body.appendChild(b);
    };
    setTimeout(() => {
      const dw = Math.abs(pipWin.innerWidth - W), dh = Math.abs(pipWin.innerHeight - H);
      if (!autoSizeOk || dw > 24 || dh > 24) showApplyBtn();
    }, 280);

    tipEl.classList.add('show');
    setTimeout(() => tipEl.classList.remove('show'), 3200);

    // ---- 拖拽调整宽高 ----
    const savePrefs = throttle((w, h) => {
      chrome.storage.local.set({ w, h }).catch(() => {});
    }, 400);

    pipWin.addEventListener('resize', () => {
      updateSize();
      savePrefs(pipWin.innerWidth, pipWin.innerHeight);
    });

    for (const h of doc.querySelectorAll('.vp-rs')) {
      h.addEventListener('mousedown', startResize(h.dataset.dir));
      h.addEventListener('dblclick', () => {
        try { resizeToInner(DEFAULT_W, DEFAULT_H); savePrefs(DEFAULT_W, DEFAULT_H); } catch {}
      });
    }

    function startResize(dir) {
      return (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const sx = e.screenX, sy = e.screenY;
        const sw = pipWin.innerWidth, sh = pipWin.innerHeight;
        const sl = pipWin.screenX, st = pipWin.screenY;
        // 上限不超过打开页面的视口,避免触发浏览器对超大请求的异常钐制
        const maxW = Math.max(MIN_W + 1, Math.min(openerW, availW));
        const maxH = Math.max(MIN_H + 1, Math.min(openerH, availH));
        let resizeBlocked = false;
        const onMove = (ev) => {
          const dx = ev.screenX - sx, dy = ev.screenY - sy;
          let W2 = clamp(sw + (dir.includes('e') ? dx : 0), MIN_W, maxW);
          let H2 = clamp(sh + (dir.includes('s') ? dy : 0), MIN_H, maxH);
          let L2 = sl, T2 = st;
          if (dir.includes('w')) { W2 = clamp(sw - dx, MIN_W, maxW); L2 = sl + (sw - W2); }
          if (dir.includes('n')) { H2 = clamp(sh - dy, MIN_H, maxH); T2 = st + (sh - H2); }
          L2 = clamp(L2, -(W2 - 100), availW - 100);
          T2 = clamp(T2, 0, availH - 100);
          try { if (dir.includes('w') || dir.includes('n')) pipWin.moveTo(Math.round(L2), Math.round(T2)); } catch {}
          if (!resizeBlocked) {
            try { resizeToInner(W2, H2); } catch (err) {
              if (err && err.name === 'NotAllowedError') resizeBlocked = true; // 激活过期,停止调整避免反复抛错
            }
          }
          updateSize();
        };
        const onUp = () => {
          doc.removeEventListener('mousemove', onMove, true);
          doc.removeEventListener('mouseup', onUp, true);
          savePrefs(pipWin.innerWidth, pipWin.innerHeight);
        };
        doc.addEventListener('mousemove', onMove, true);
        doc.addEventListener('mouseup', onUp, true);
      };
    }

    // ---- 关闭恢复 ----
    let restored = false;
    pipWin.addEventListener('pagehide', () => {
      if (restored) return;
      restored = true;
      for (const [t, f] of vL) video.removeEventListener(t, f);
      try { unparkVideo(video, park); } catch {}
      video.controls = wasControls;
    });

    return { ok: true, mode: 'document' };
  }

  // m3u8 下载进度/完成提示(offscreen 管线)
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.dlId) return;
    if (msg.type === 'vpip:m3u8-progress') {
      toast('m3u8 下载中 ' + msg.done + '/' + msg.total);
    } else if (msg.type === 'vpip:m3u8-debug') {
      toast('[m3u8] ' + String(msg.text || '').slice(0, 60));
    } else if (msg.type === 'vpip:m3u8-done') {
      toast(msg.ok ? 'm3u8 下载完成 ✓ ' + (msg.filename || '') : 'm3u8 下载失败:' + String(msg.message || '').slice(0, 50));
    }
  });

  /* ---------------- 消息通道(popup / 快捷键 / 右键菜单) ---------------- */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'vpip:query') {
      sendResponse({
        videos: visibleVideos().length,
        docPip: !!(window.documentPictureInPicture && documentPictureInPicture.window),
      });
      return;
    }
    if (msg.type === 'vpip:open' || msg.type === 'vpip:open-menu') {
      const v = pickVideo();
      if (!v) {
        sendResponse({ ok: false, error: 'novideo' });
        return;
      }
      togglePip(v).then((r) => {
        if (!r.ok && r.error === 'NotAllowedError') showConfirmLayer(v);
        sendResponse(r);
      });
      return true; // 异步响应
    }
  });
})();
