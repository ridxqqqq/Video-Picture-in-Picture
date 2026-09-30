// 视频画中画 Plus - offscreen 文档:m3u8 解析、分片下载、AES-128 解密与合并
// 在这里拥有完整 DOM(URL.createObjectURL)与扩展级 fetch(不受页面 CORS 限制)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'vpip:m3u8-ping') { sendResponse({ pong: true }); return; }
  if (msg && msg.type === 'vpip:m3u8-start') {
    runM3u8(msg).catch((err) => {
      report(msg.dlId, false, msg.filename, String((err && err.message) || err));
    });
  }
});

// 加载完成上报:后台等到该握手后才派发任务,避免消息早于监听器注册而丢失
try { chrome.runtime.sendMessage({ type: 'vpip:offscreen-ready' }); } catch {}

function report(dlId, ok, filename, message) {
  try { chrome.runtime.sendMessage({ type: 'vpip:m3u8-done', dlId, ok, filename, message }); } catch {}
}

async function fetchBuf(u, retries = 2) {
  for (let a = 0; ; a++) {
    try {
      const r = await fetch(u);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.arrayBuffer();
    } catch (e) {
      if (a >= retries) throw e;
      await new Promise((res) => setTimeout(res, 500 * (a + 1)));
    }
  }
}
async function fetchText(u) { return new TextDecoder().decode(await fetchBuf(u)); }

// HLS 默认 IV = 64bit 大端 media sequence number;或显式 0x hex
function ivFrom(ivHex, seq) {
  const iv = new Uint8Array(16);
  if (ivHex) {
    const h = String(ivHex).toLowerCase().padStart(32, '0').slice(-32);
    for (let i = 0; i < 16; i++) iv[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16) || 0;
  } else {
    let v = BigInt(seq);
    for (let i = 15; i >= 0; i--) { iv[i] = Number(v & 255n); v >>= 8n; }
  }
  return iv;
}

// master playlist:取 BANDWIDTH 最高的变体
function pickBestVariant(text, base) {
  let best = null, bestBw = -1;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF/i.test(lines[i].trim())) continue;
    const bwM = /BANDWIDTH=(\d+)/i.exec(lines[i]);
    const bw = bwM ? parseInt(bwM[1], 10) : 0;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t) continue;
      if (t.startsWith('#')) continue;
      if (bw > bestBw) { bestBw = bw; best = new URL(t, base).href; }
      break;
    }
  }
  if (!best) throw new Error('master playlist 中未找到可用的子播放列表');
  return best;
}

async function runM3u8(job) {
  const { url, dlId } = job;
  const filename = job.filename || 'video.ts';
  const dbg = (t) => { try { chrome.runtime.sendMessage({ type: 'vpip:m3u8-debug', dlId, text: t }); } catch {} };
  dbg('step1 fetch playlist: ' + url.slice(0, 60));

  let text = await fetchText(url);
  dbg('step2 playlist len=' + text.length + (text.includes('EXT-X-STREAM-INF') ? ' (master)' : ''));
  if (/EXT-X-STREAM-INF/i.test(text)) {
    const sub = pickBestVariant(text, url);
    dbg('step2b sub=' + sub.slice(0, 60));
    text = await fetchText(sub);
    dbg('step2c sub len=' + text.length);
  }
  if (!/#EXTINF/i.test(text)) throw new Error('未找到媒体分片');
  if (!/#EXT-X-ENDLIST/i.test(text)) throw new Error('该 m3u8 是直播流(无结束标记),不支持下载');

  const mediaSeqM = /#EXT-X-MEDIA-SEQUENCE:(\d+)/i.exec(text);
  const mediaSeq = mediaSeqM ? parseInt(mediaSeqM[1], 10) : 0;

  // 加密信息(支持 AES-128;SAMPLE-AES 等 DRM 类不支持)
  let cryptoInfo = null;
  const keyM = /#EXT-X-KEY:([^\r\n]*)/i.exec(text);
  if (keyM) {
    const attrs = keyM[1];
    const methodM = /METHOD=([A-Za-z0-9-]+)/.exec(attrs);
    const method = methodM ? methodM[1].toUpperCase() : 'NONE';
    if (method === 'AES-128') {
      const uriM = /URI="([^"]+)"/i.exec(attrs);
      if (!uriM) throw new Error('无法解析解密 KEY 地址');
      const ivM = /IV=0[xX]([0-9a-fA-F]+)/.exec(attrs);
      cryptoInfo = { keyUrl: new URL(uriM[1], url).href, ivHex: ivM ? ivM[1] : null };
    } else if (method !== 'NONE') {
      throw new Error('不支持的加密方式:' + method);
    }
  }

  // fMP4 初始化段
  const mapM = /#EXT-X-MAP:([^\r\n]*)/i.exec(text);
  let initBuf = null;
  if (mapM) {
    const uriM = /URI="([^"]+)"/i.exec(mapM[1]);
    if (uriM) initBuf = await fetchBuf(new URL(uriM[1], url).href);
  }

  let ckey = null;
  if (cryptoInfo) {
    const kd = await fetchBuf(cryptoInfo.keyUrl);
    ckey = await crypto.subtle.importKey('raw', kd, { name: 'AES-CBC' }, false, ['decrypt']);
  }

  // 分片 URL(忽略标签行)
  const segUrls = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('#')) segUrls.push(new URL(t, url).href);
  }
  if (!segUrls.length) throw new Error('未找到媒体分片');
  dbg('step3 segs=' + total_placeholder());
  function total_placeholder() { return segUrls.length; }

  // 并发下载(保序),AES-128 解密
  const total = segUrls.length;
  const bufs = new Array(total);
  let done = 0, next = 0;
  const CONC = 4;
  dbg('step4 start segments x' + total + (cryptoInfo ? ' (AES-128)' : ''));
  async function worker() {
    while (next < total) {
      const i = next++;
      let seg = await fetchBuf(segUrls[i], 2);
      if (ckey) {
        seg = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFrom(cryptoInfo.ivHex, mediaSeq + i) }, ckey, seg);
      }
      bufs[i] = seg;
      done++;
      if (done % 2 === 0 || done === total) {
        try { chrome.runtime.sendMessage({ type: 'vpip:m3u8-progress', dlId, done, total }); } catch {}
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, total) }, worker));
  dbg('step5 all fetched, merging');

  // 合并(含 init 段)并触发保存
  const parts = [];
  if (initBuf) parts.push(initBuf);
  for (const b of bufs) parts.push(b);
  const blob = new Blob(parts, { type: 'video/mp2t' });
  dbg('step6 blob=' + blob.size);

  // 通过后台 downloads API 落盘(offscreen 里 a.click 自动下载会被多文件拦截)
  const objUrl = URL.createObjectURL(blob);
  try { chrome.runtime.sendMessage({ type: 'vpip:save-blob', url: objUrl, filename }); } catch {}
  setTimeout(() => { try { URL.revokeObjectURL(objUrl); } catch {} }, 180000);
  dbg('step7 handed to downloads api');

  report(dlId, true, filename);
}
