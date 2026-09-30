// 调试 Document PiP requestWindow 尺寸行为
const path = require('path');
const http = require('http');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const EXT = path.join(__dirname, '..', 'extension');

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'page.html')).pipe(res);
  });
  await new Promise((r) => server.listen(8932, '127.0.0.1', r));

  const browser = await puppeteer.launch({
    executablePath: path.join(__dirname, 'chrome', 'chrome-win64', 'chrome.exe'),
    headless: false,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-first-run', '--no-default-browser-check', '--noerrdialogs',
      '--window-size=1360,850', '--window-position=20,20',
    ],
    defaultViewport: null,
  });

  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8932/page.html', { waitUntil: 'load' });
  await sleep(1000);

  const env = await page.evaluate(() => ({
    dpr: window.devicePixelRatio,
    screen: [screen.width, screen.height, screen.availWidth, screen.availHeight],
    opener: [window.innerWidth, window.innerHeight, window.outerWidth, window.outerHeight],
  }));
  console.log('env:', JSON.stringify(env));

  // 无参数开启
  const d1 = await page.evaluate(async () => {
    const w = await documentPictureInPicture.requestWindow({});
    const r = { inner: [w.innerWidth, w.innerHeight], outer: [w.outerWidth, w.outerHeight], pos: [w.screenX, w.screenY], dpr: w.devicePixelRatio };
    w.close();
    return r;
  });
  await sleep(500);
  console.log('requestWindow({}):', JSON.stringify(d1));

  // 小尺寸
  const d2 = await page.evaluate(async () => {
    const w = await documentPictureInPicture.requestWindow({ width: 320, height: 200 });
    const r = { inner: [w.innerWidth, w.innerHeight], outer: [w.outerWidth, w.outerHeight] };
    // 立即 resizeTo 看是否受限
    w.resizeTo(500, 400);
    await new Promise((res) => setTimeout(res, 300));
    r.afterResize = [w.innerWidth, w.innerHeight];
    // moveTo
    w.moveTo(80, 80);
    await new Promise((res) => setTimeout(res, 300));
    r.afterMove = [w.screenX, w.screenY];
    // resizeBy
    w.resizeBy(100, 50);
    await new Promise((res) => setTimeout(res, 300));
    r.afterResizeBy = [w.innerWidth, w.innerHeight];
    w.close();
    return r;
  });
  await sleep(500);
  console.log('requestWindow({320,200}) + resize tests:', JSON.stringify(d2));

  // 大于 opener 的请求
  const d3 = await page.evaluate(async () => {
    const w = await documentPictureInPicture.requestWindow({ width: 1000, height: 700 });
    const r = { inner: [w.innerWidth, w.innerHeight] };
    w.close();
    return r;
  });
  await sleep(500);
  console.log('requestWindow({1000,700}):', JSON.stringify(d3));

  await browser.close();
  server.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
