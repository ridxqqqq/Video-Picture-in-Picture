// 视频画中画 Plus - 自动化验收测试(puppeteer-core + 本机 Chromium 系浏览器)
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const SHOTS = path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const CANDIDATES = [
  path.join(__dirname, 'chrome', 'chrome-win64', 'chrome.exe'), // Chrome for Testing(支持 --load-extension)
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const BROWSERS = CANDIDATES.filter((p) => p && fs.existsSync(p));
if (!BROWSERS.length) { console.error('NO BROWSER FOUND'); process.exit(2); }

const results = [];
// 本地 HLS 测试流常量
const HLS_KEY = Buffer.from('0123456789abcdef');
function hlsPlaylist(variant, enc) {
  let fill = '';
  if (variant === 'low') fill = '&fill=255';
  else if (variant === 'hi') fill = '&fill=187';
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0'];
  if (enc) lines.push('#EXT-X-KEY:METHOD=AES-128,URI="/key",IV=0x00000000000000000000000000000001');
  for (let i = 0; i < 5; i++) lines.push('#EXTINF:4.0,', `/seg.ts?i=${i}${fill}${enc ? '&enc=1' : ''}`);
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}
function check(name, cond, extra) {
  results.push({ name, pass: !!cond });
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  | ' + JSON.stringify(extra) : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 测试临时配置:把 /slow 排除出自动注入(模拟扩展安装/重载前打开的页面),结束后还原
  const MANI = path.join(EXT, 'manifest.json');
  const maniOrig = fs.readFileSync(MANI, 'utf8');
  const maniTmp = JSON.parse(maniOrig);
  maniTmp.content_scripts[0].exclude_matches = ['http://127.0.0.1:8931/slow*', 'http://localhost:8931/slow*'];
  fs.writeFileSync(MANI, JSON.stringify(maniTmp, null, 2));
  let restored = false;
  const restoreManifest = () => {
    if (restored) return;
    restored = true;
    try { fs.writeFileSync(MANI, maniOrig); } catch {}
  };
  process.on('exit', restoreManifest);

  const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    const pageFile = { '/': 'page.html', '/page.html': 'page.html', '/page2.html': 'page2.html', '/page3.html': 'page3.html', '/page4.html': 'page4.html' }[pathname];
    if (pageFile) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(path.join(__dirname, pageFile)).pipe(res);
    } else if (req.url.startsWith('/key')) {
      // HLS AES-128 解密 KEY(16 字节)
      const key = Buffer.from('0123456789abcdef');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': key.length });
      res.end(key);
    } else if (req.url.startsWith('/seg.ts')) {
      // 分片:默认每片填充 i+1;fill 参数指定填充;enc=1 时 AES-128-CBC 加密(IV=1)
      const q = new URL('http://x' + req.url).searchParams;
      const i = parseInt(q.get('i') || '0', 10) || 0;
      const fillQ = q.get('fill');
      const fill = fillQ !== null ? parseInt(fillQ, 10) & 255 : (i + 1) & 255;
      let buf = Buffer.alloc(4096, fill);
      if (q.get('enc') === '1') {
        const iv = Buffer.alloc(16); iv[15] = 1;
        const c = crypto.createCipheriv('aes-128-cbc', HLS_KEY, iv);
        buf = Buffer.concat([c.update(buf), c.final()]);
      }
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': buf.length });
      res.end(buf);
    } else if (req.url.startsWith('/test.m3u8')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(hlsPlaylist(req.url.includes('hi=1') ? 'hi' : 'plain', false));
    } else if (req.url.startsWith('/test-enc.m3u8')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(hlsPlaylist('plain', true));
    } else if (req.url.startsWith('/test-low.m3u8')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(hlsPlaylist('low', false));
    } else if (req.url.startsWith('/master.m3u8')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080\n/test.m3u8?hi=1\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\n/test-low.m3u8\n');
    } else if (req.url === '/slow') {
      // 故意挂起的页面:DOM 已有 body 但流不结束,document_idle 不触发 → 内容脚本不注入
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.write('<!doctype html><html><head><meta charset="utf-8"><title>slow</title></head><body><h1>slow page (never finishes loading)</h1></body></html>');
    } else if (req.url === '/test.mp4') {
      // 伪 mp4(仅用于验证下载链路,不需要可解码)
      const buf = Buffer.alloc(256 * 1024, 7);
      buf.write('ftyp', 4, 'ascii');
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': buf.length });
      res.end(buf);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(8931, '127.0.0.1', r));

  let browser = null;
  for (const exe of BROWSERS) {
    console.log('trying browser:', exe);
    try {
      browser = await puppeteer.launch({
        executablePath: exe,
        headless: false,
        args: [
          `--disable-extensions-except=${EXT}`,
          `--load-extension=${EXT}`,
          '--no-first-run', '--no-default-browser-check', '--noerrdialogs',
          '--window-size=1360,850', '--window-position=20,20',
          '--autoplay-policy=no-user-gesture-required',
        ],
        defaultViewport: null,
        protocolTimeout: 60000,
      });
      // 确认扩展 service worker 真的加载了(--load-extension 在部分品牌版被禁用)
      await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 8000 });
      break;
    } catch (e) {
      console.log('  -> failed:', e.message.split('\n')[0]);
      try { await browser.close(); } catch {}
      browser = null;
    }
  }
  if (!browser) { console.error('ALL BROWSERS FAILED'); server.close(); process.exit(2); }

  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker');
  const worker = await swTarget.worker();
  const extId = new URL(swTarget.url()).host;
  console.log('extension id:', extId);

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8931/page.html', { waitUntil: 'load' });
  await page.waitForSelector('#__vpip_hover_btn', { timeout: 10000 }); // content script 注入痕迹(DOM 元素)
  await page.waitForFunction(() => {
    const v = document.getElementById('big');
    return v && v.videoWidth > 0 && !v.paused;
  }, { timeout: 10000 });

  // T1 悬浮按钮
  await page.hover('#big');
  await page.waitForSelector('#__vpip_hover_btn', { visible: true, timeout: 5000 });
  check('T1 悬停视频出现画中画按钮', true);

  // T2 开启 Document PiP
  await page.click('#__vpip_hover_btn');
  await page.waitForFunction(() => window.documentPictureInPicture && documentPictureInPicture.window, { timeout: 8000 });
  const s2 = await page.evaluate(() => {
    const w = documentPictureInPicture.window;
    const v = w.document.querySelector('.vp-stage video');
    return {
      w: w.innerWidth, h: w.innerHeight,
      hasVideo: !!v,
      big: !!(v && v.videoWidth === 640 && v.videoHeight === 360),
      playing: !!(v && !v.paused),
      placeholder: !!document.querySelector('.__vpip_placeholder'),
      controls: !!w.document.querySelector('.vp-controls'),
      handles: w.document.querySelectorAll('.vp-rs').length,
    };
  });
  check('T2 画中画窗口开启并载入视频', s2.hasVideo, s2);
  check('T2b 多视频时选中最大的', s2.big, s2);
  check('T2c 小窗内视频持续播放', s2.playing, s2);
  check('T2d 原位置显示占位提示', s2.placeholder, s2);
  check('T2e 控制条与 8 个拖拽手柄存在', s2.controls && s2.handles === 8, s2);

  // T2f/T2g 初始尺寸:浏览器可能忽略 requestWindow 尺寸参数 → 兜底按钮一键应用
  await sleep(600);
  const t2f = await page.evaluate(() => ({
    w: documentPictureInPicture.window.innerWidth,
    h: documentPictureInPicture.window.innerHeight,
    applyBtn: !!documentPictureInPicture.window.document.querySelector('.vp-apply'),
  }));
  if (Math.abs(t2f.w - 512) <= 14 && Math.abs(t2f.h - 320) <= 14) {
    check('T2f 开启即为记忆/默认尺寸(自动应用)', true, t2f);
  } else {
    check('T2f 初始尺寸被浏览器忽略 → 出现兜底按钮', t2f.applyBtn, t2f);
    await page.evaluate(() => {
      const b = documentPictureInPicture.window.document.querySelector('.vp-apply');
      if (b) b.click();
    });
    await sleep(500);
    const t2g = await page.evaluate(() => ({
      w: documentPictureInPicture.window.innerWidth,
      h: documentPictureInPicture.window.innerHeight,
      gone: !documentPictureInPicture.window.document.querySelector('.vp-apply'),
    }));
    check('T2g 点击兜底按钮应用记忆尺寸', Math.abs(t2g.w - 512) <= 14 && Math.abs(t2g.h - 320) <= 14 && t2g.gone, t2g);
  }

  await page.screenshot({ path: path.join(SHOTS, 'main-page-pip-open.png') });
  try {
    for (const t of browser.targets()) {
      if (t.type() !== 'page' && t.type() !== 'window') continue;
      try {
        const tp = await t.page();
        const title = await tp.evaluate(() => document.title).catch(() => '');
        if (title === '画中画') {
          await tp.screenshot({ path: path.join(SHOTS, 'pip-window.png') });
          console.log('pip window screenshot saved');
          break;
        }
      } catch {}
    }
  } catch (e) { console.log('pip screenshot skipped:', e.message.split('\n')[0]); }

  // T3 拖拽右下角放大
  const b3 = await page.evaluate(() => ({ w: documentPictureInPicture.window.innerWidth, h: documentPictureInPicture.window.innerHeight }));
  await page.evaluate(() => {
    const win = documentPictureInPicture.window, doc = win.document;
    const h = doc.querySelector('.vp-rs-se');
    const mk = (type, x, y, tgt) => tgt.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, screenX: x, screenY: y, clientX: x, clientY: y, button: 0 }));
    mk('mousedown', 900, 700, h);
    mk('mousemove', 980, 780, doc);
    mk('mouseup', 980, 780, doc);
  });
  await sleep(700);
  const a3 = await page.evaluate(() => ({ w: documentPictureInPicture.window.innerWidth, h: documentPictureInPicture.window.innerHeight }));
  check('T3 拖拽右下角放大 +80/+80', a3.w >= b3.w + 70 && a3.h >= b3.h + 70, { before: b3, after: a3 });

  // T4 尺寸记忆
  const stored = await worker.evaluate(() => new Promise((res) => chrome.storage.local.get(['w', 'h'], res)));
  check('T4 调整后的尺寸写入存储', Math.abs(stored.w - a3.w) <= 20 && Math.abs(stored.h - a3.h) <= 20, { stored, after: a3 });

  // T5 拖拽左上角缩小(验证双向与位置跟随)
  const b5 = await page.evaluate(() => ({ w: documentPictureInPicture.window.innerWidth, h: documentPictureInPicture.window.innerHeight }));
  await page.evaluate(() => {
    const win = documentPictureInPicture.window, doc = win.document;
    const h = doc.querySelector('.vp-rs-nw');
    const mk = (type, x, y, tgt) => tgt.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, screenX: x, screenY: y, clientX: x, clientY: y, button: 0 }));
    mk('mousedown', 400, 300, h);
    mk('mousemove', 440, 340, doc);
    mk('mouseup', 440, 340, doc);
  });
  await sleep(700);
  const a5 = await page.evaluate(() => ({ w: documentPictureInPicture.window.innerWidth, h: documentPictureInPicture.window.innerHeight }));
  check('T5 拖拽左上角缩小 -40/-40', a5.w <= b5.w - 30 && a5.h <= b5.h - 30, { before: b5, after: a5 });

  // T6 关闭 → 视频回原位
  await page.evaluate(() => documentPictureInPicture.window.close());
  await page.waitForFunction(() => !document.querySelector('.__vpip_placeholder'), { timeout: 5000 });
  const s6 = await page.evaluate(() => {
    const v = document.querySelector('#big');
    return { inPage: !!v && document.body.contains(v), controls: v.controls };
  });
  check('T6 关闭后视频回到页面原位置', s6.inPage, s6);

  // T7 重新开启使用记忆尺寸
  await page.hover('#big');
  await page.waitForSelector('#__vpip_hover_btn', { visible: true, timeout: 5000 });
  await page.click('#__vpip_hover_btn');
  await page.waitForFunction(() => window.documentPictureInPicture && documentPictureInPicture.window, { timeout: 8000 });
  await sleep(600);
  const a7 = await page.evaluate(() => ({
    w: documentPictureInPicture.window.innerWidth,
    h: documentPictureInPicture.window.innerHeight,
    applyBtn: !!documentPictureInPicture.window.document.querySelector('.vp-apply'),
  }));
  if (Math.abs(a7.w - a5.w) <= 14 && Math.abs(a7.h - a5.h) <= 14) {
    check('T7 重开窗口使用记忆尺寸(自动应用)', true, { expected: a5, got: a7 });
  } else {
    check('T7 重开被忽略 → 兜底按钮出现', a7.applyBtn, { expected: a5, got: a7 });
    await page.evaluate(() => {
      const b = documentPictureInPicture.window.document.querySelector('.vp-apply');
      if (b) b.click();
    });
    await sleep(500);
    const a7b = await page.evaluate(() => ({ w: documentPictureInPicture.window.innerWidth, h: documentPictureInPicture.window.innerHeight }));
    check('T7 兜底应用记忆尺寸', Math.abs(a7b.w - a5.w) <= 14 && Math.abs(a7b.h - a5.h) <= 14, { expected: a5, got: a7b });
  }
  await page.evaluate(() => documentPictureInPicture.window.close());
  await sleep(400);

  // T8 popup/快捷键消息路径(无手势场景) → 直接开启 或 确认层兜底
  const tabId = await worker.evaluate(() => new Promise((res) => chrome.tabs.query({ active: true, currentWindow: true }, ([t]) => res(t.id))));
  const msgRes = await worker.evaluate((tid) => new Promise((res) => {
    chrome.tabs.sendMessage(tid, { type: 'vpip:open' }, (r) => res({ r, err: chrome.runtime.lastError && String(chrome.runtime.lastError.message) }));
  }), tabId);
  await sleep(800);
  const layer = await page.evaluate(() => !!document.querySelector('.__vpip_confirm'));
  const directOk = msgRes.r && msgRes.r.ok;
  const pipStill = await page.evaluate(() => !!(window.documentPictureInPicture && documentPictureInPicture.window));
  check('T8 消息路径开启(直接成功或确认层兜底)', directOk || (layer && !pipStill), { msgRes, layer, pipStill });

  if (!directOk && layer) {
    await page.click('.__vpip_confirm button');
    await page.waitForFunction(() => window.documentPictureInPicture && documentPictureInPicture.window, { timeout: 8000 });
    check('T8b 点击确认层成功开启画中画', true);
  }
  await page.evaluate(() => { if (documentPictureInPicture.window) documentPictureInPicture.window.close(); });
  await sleep(300);

  // T9 自愈链路:页面未注入内容脚本(模拟扩展安装/重载前打开的页面)→ 自动补注入后消息恢复
  console.log('T9: open slow page...');
  const p9 = await browser.newPage();
  await p9.goto('http://127.0.0.1:8931/slow', { waitUntil: 'domcontentloaded', timeout: 4000 }).catch(() => console.log('T9: goto timeout as expected'));
  await sleep(800);
  console.log('T9: bringToFront...');
  await p9.bringToFront().catch((e) => console.log('T9: bringToFront err', String(e).slice(0, 100)));
  await sleep(300);
  console.log('T9: query tabId...');
  const tid9 = await worker.evaluate(() => new Promise((res) => chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([t]) => res(t && t.id != null ? t.id : null))));
  console.log('T9: tabId =', tid9);
  const orphan9 = await worker.evaluate((tid) => new Promise((res) => chrome.tabs.sendMessage(tid, { type: 'vpip:query' }, () => res({ err: chrome.runtime.lastError && String(chrome.runtime.lastError.message) }))), tid9);
  console.log('T9: orphan ping =', JSON.stringify(orphan9));
  console.log('T9: injecting...');
  const inj9 = await worker.evaluate(async (tid) => {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tid }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tid }, files: ['content.js'], injectImmediately: true });
      return { ok: true };
    } catch (e) { return { ok: false, err: String(e).slice(0, 200) }; }
  }, tid9);
  console.log('T9: inject result =', JSON.stringify(inj9));
  console.log('T9: sw alive check...');
  const alive9 = await Promise.race([
    worker.evaluate(() => 'alive-' + Date.now()).then((v) => v, (e) => 'err:' + String(e).slice(0, 80)),
    sleep(8000).then(() => 'TIMEOUT'),
  ]);
  console.log('T9: sw alive =', alive9);
  await sleep(400);
  console.log('T9: ping after inject...');
  const ping9 = await Promise.race([
    worker.evaluate((tid) => new Promise((res) => chrome.tabs.sendMessage(tid, { type: 'vpip:query' }, (r) => res({ r, err: chrome.runtime.lastError && String(chrome.runtime.lastError.message) }))), tid9),
    sleep(15000).then(() => ({ err: 'PING-TIMEOUT' })),
  ]);
  console.log('T9: ping9 =', JSON.stringify(ping9));
  const probe9 = await worker.evaluate(async (tid) => {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: () => ({ loaded: !!window.__vpipLoaded, btn: !!document.getElementById('__vpip_hover_btn'), ready: document.readyState, title: document.title }),
        injectImmediately: true,
      });
      return { ok: true, result: r.result };
    } catch (e) { return { ok: false, err: String(e).slice(0, 160) }; }
  }, tid9);
  check('T9 未注入页面自动补注入后恢复(免刷新自愈)', !!orphan9.err && inj9.ok && ping9.r && ping9.r.videos === 0, { orphan9, inj9, ping9, probe9 });
  await p9.close();

  // T10 浏览器内置页面拒绝注入(弹窗会给出"此页面不支持"提示)
  const p3 = await browser.newPage();
  await p3.goto('chrome://version/', { waitUntil: 'load' }).catch(() => {});
  await sleep(600);
  await p3.bringToFront();
  await sleep(300);
  const p3Tid = await worker.evaluate(() => new Promise((res) => chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([t]) => res(t && t.id != null ? t.id : null))));
  const rej = await worker.evaluate(async (tid) => {
    try { await chrome.scripting.executeScript({ target: { tabId: tid }, files: ['content.js'] }); return { ok: true }; }
    catch (e) { return { ok: false, err: String(e).slice(0, 160) }; }
  }, p3Tid);
  check('T10 内置页面注入被拒(弹窗会提示不支持)', rej.ok === false, rej);
  await p3.close();

  // ---- T11 系列:小窗右下角“解析并下载” ----
  const DLDIR = path.join(__dirname, 'downloads-test');
  fs.rmSync(DLDIR, { recursive: true, force: true });
  fs.mkdirSync(DLDIR, { recursive: true });
  const cdpB = await browser.target().createCDPSession();
  await cdpB.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DLDIR, eventsEnabled: true });
  let dlSuggested = null;
  cdpB.on('Browser.downloadWillBegin', (e) => { dlSuggested = e.suggestedFilename; });
  const waitDownload = async (timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const files = fs.readdirSync(DLDIR).filter((f) => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
      if (files.length) {
        const f = files[0];
        const st = fs.statSync(path.join(DLDIR, f));
        if (st.size > 0) return { file: f, size: st.size };
      }
      await sleep(300);
    }
    return null;
  };

  // T11a 直链视频:控制条右下角下载按钮 → 浏览器下载器落盘
  const p2v = await browser.newPage();
  await p2v.goto('http://127.0.0.1:8931/page2.html', { waitUntil: 'load' });
  await p2v.waitForSelector('#__vpip_hover_btn', { timeout: 10000 });
  await p2v.hover('#v');
  await p2v.waitForSelector('#__vpip_hover_btn', { visible: true, timeout: 5000 });
  await p2v.click('#__vpip_hover_btn');
  await p2v.waitForFunction(() => window.documentPictureInPicture && documentPictureInPicture.window, { timeout: 8000 });
  await sleep(600);
  await p2v.evaluate(() => { const b = documentPictureInPicture.window.document.querySelector('.vp-apply'); if (b) b.click(); });
  await sleep(400);
  const hasDl = await p2v.evaluate(() => {
    const d = documentPictureInPicture.window.document;
    const btn = d.querySelector('#vp-dl');
    if (!btn) return false;
    const rs = d.querySelector('#vp-restore');
    // 右下角:与“放回页面”按钮相邻且在其左侧
    return rs && btn.getBoundingClientRect().right <= rs.getBoundingClientRect().left + 10 && btn.getBoundingClientRect().right >= rs.getBoundingClientRect().left - 10;
  });
  check('T11a 下载按钮出现在控制条右下角(返回按钮左侧)', hasDl);

  const before11 = fs.readdirSync(DLDIR).length;
  await p2v.evaluate(() => { documentPictureInPicture.window.document.querySelector('#vp-dl').click(); });
  await sleep(600);
  const dl1 = await waitDownload();
  const files11 = fs.readdirSync(DLDIR).filter((f) => !f.endsWith('.crdownload'));
  check('T11b 直链视频成功下载到磁盘(256KB)', dl1 && files11.length > before11 && dl1.size >= 200 * 1024, { dlSuggested, dl1, files11: files11.slice(0, 5) });
  await p2v.evaluate(() => { if (documentPictureInPicture.window) documentPictureInPicture.window.close(); });
  await sleep(300);
  await p2v.close();

  // T11c blob 视频:a[download] 保存,文件名取页面标题
  const p3b = await browser.newPage();
  await p3b.goto('http://127.0.0.1:8931/page3.html', { waitUntil: 'load' });
  await p3b.waitForSelector('#__vpip_hover_btn', { timeout: 10000 });
  await p3b.waitForFunction(() => { const v = document.getElementById('v'); return v && v.src && v.src.startsWith('blob:'); }, { timeout: 8000 });
  await p3b.hover('#v');
  await p3b.waitForSelector('#__vpip_hover_btn', { visible: true, timeout: 5000 });
  await p3b.click('#__vpip_hover_btn');
  await p3b.waitForFunction(() => window.documentPictureInPicture && documentPictureInPicture.window, { timeout: 8000 });
  await sleep(600);
  await p3b.evaluate(() => { const b = documentPictureInPicture.window.document.querySelector('.vp-apply'); if (b) b.click(); });
  await sleep(300);
  const before11c = fs.readdirSync(DLDIR).length;
  await p3b.evaluate(() => { documentPictureInPicture.window.document.querySelector('#vp-dl').click(); });
  await sleep(3500);
  const files11c = fs.readdirSync(DLDIR).filter((f) => !f.endsWith('.crdownload'));
  check('T11c blob 视频通过 a[download] 保存', files11c.length > before11c, { files11c: files11c.slice(0, 5) });
  await p3b.evaluate(() => { if (documentPictureInPicture.window) documentPictureInPicture.window.close(); });
  await sleep(300);
  await p3b.close();

  // T11d 直播/生成流(srcObject):给出不可下载提示
  await page.bringToFront();
  await page.hover('#big');
  await page.waitForSelector('#__vpip_hover_btn', { visible: true, timeout: 5000 });
  await page.click('#__vpip_hover_btn');
  await page.waitForFunction(() => window.documentPictureInPicture && documentPictureInPicture.window, { timeout: 8000 });
  await sleep(600);
  await page.evaluate(() => { const b = documentPictureInPicture.window.document.querySelector('.vp-apply'); if (b) b.click(); });
  await sleep(300);
  await page.evaluate(() => { documentPictureInPicture.window.document.querySelector('#vp-dl').click(); });
  await sleep(500);
  const toastText = await page.evaluate(() => {
    const t = document.querySelector('.__vpip_toast');
    return t && t.style.display !== 'none' ? t.textContent : '';
  });
  check('T11d 直播/生成流视频给出不可下载提示', /无法下载|不支持/.test(toastText || ''), { toastText });
  await page.evaluate(() => { if (documentPictureInPicture.window) documentPictureInPicture.window.close(); });
  await sleep(300);

  // ---- T12 系列:m3u8 解析下载 ----
  const m3u8Cases = [
    { name: 'T12 直链 m3u8(明文)解析下载', q: 'src=/test.m3u8', expect: (b) => b.length === 20480 && b[0] === 1 && b[4096] === 2 && b[8192] === 3 && b[12288] === 4 && b[16384] === 5 },
    { name: 'T13 加密 m3u8(AES-128 解密)解析下载', q: 'src=/test-enc.m3u8', expect: (b) => b.length === 20480 && b[0] === 1 && b[4096] === 2 && b[8192] === 3 && b[12288] === 4 && b[16384] === 5 },
    { name: 'T14 master playlist 自动选最高码率', q: 'src=/master.m3u8', expect: (b) => b.length === 20480 && b[0] === 187 && b[4096] === 187 && b[16384] === 187 },
    { name: 'T15 blob 视频 + 网络嗅探捕获 m3u8 下载', q: 'src=/test.m3u8&blob=1', expect: (b) => b.length === 20480 && b[0] === 1 && b[4096] === 2 },
  ];
  for (const mc of m3u8Cases) {
    const pt = await browser.newPage();
    await pt.goto('http://127.0.0.1:8931/page4.html?' + mc.q, { waitUntil: 'load' }).catch(() => {});
    await pt.waitForSelector('#__vpip_hover_btn', { timeout: 10000 });
    if (mc.q.includes('blob=1')) {
      await pt.waitForFunction(() => window.__blobReady === true, { timeout: 8000 }).catch(() => {});
    }
    await pt.hover('#v');
    await pt.waitForSelector('#__vpip_hover_btn', { visible: true, timeout: 5000 });
    await pt.click('#__vpip_hover_btn');
    await pt.waitForFunction(() => window.documentPictureInPicture && documentPictureInPicture.window, { timeout: 8000 });
    await sleep(600);
    await pt.evaluate(() => { const b = documentPictureInPicture.window.document.querySelector('.vp-apply'); if (b) b.click(); });
    await sleep(300);
    const beforeM = new Set(fs.readdirSync(DLDIR).filter((f) => !f.endsWith('.crdownload')));
    await pt.evaluate(() => { documentPictureInPicture.window.document.querySelector('#vp-dl').click(); });
    // 等待 offscreen 启动 + 分片下载合并 + 文件落盘(按名字差集识别新产物);同时采集 toast 序列定位分支
    let outFile = null;
    const toasts = [];
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      await sleep(500);
      const tt = await pt.evaluate(() => {
        const t1 = document.querySelector('.__vpip_toast');
        return t1 && t1.style.display !== 'none' ? t1.textContent : '';
      }).catch(() => '');
      if (tt && (!toasts.length || toasts[toasts.length - 1] !== tt)) toasts.push(tt);
      const fresh = fs.readdirSync(DLDIR).filter((f) => !f.endsWith('.crdownload') && !beforeM.has(f));
      if (fresh.length) {
        const f = fresh[fresh.length - 1];
        const fp = path.join(DLDIR, f);
        const st = fs.statSync(fp);
        if (st.size > 0) { outFile = fp; break; }
      }
    }
    await sleep(500);
    let pass = false, detail = { outFile, toasts };
    if (outFile) {
      const b = fs.readFileSync(outFile);
      pass = !!mc.expect(b);
      detail.size = b.length;
      if (!pass) detail.head = [...b.slice(0, 4)].join(',');
    }
    check(mc.name, pass, detail);
    await pt.evaluate(() => { if (window.documentPictureInPicture && documentPictureInPicture.window) documentPictureInPicture.window.close(); }).catch(() => {});
    await sleep(300);
    await pt.close();
  }

  const fails = results.filter((r) => !r.pass);
  restoreManifest();
  console.log(`\n=== SUMMARY: ${results.length - fails.length}/${results.length} passed ===`);
  if (fails.length) console.log('FAILED:', fails.map((f) => f.name).join(', '));

  await browser.close();
  server.close();
  restoreManifest();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(3); });
