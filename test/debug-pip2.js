// 调试2:requestWindow 参数是否生效 / activation 传播 / resizeTo clamp 行为
const path = require('path');
const http = require('http');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const EXT = path.join(__dirname, '..', 'extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'page.html')).pipe(res);
  });
  await new Promise((r) => server.listen(8933, '127.0.0.1', r));

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
  await page.goto('http://127.0.0.1:8933/page.html', { waitUntil: 'load' });
  await sleep(800);

  async function findPipPage() {
    for (let i = 0; i < 20; i++) {
      for (const t of browser.targets()) {
        if (t.type() !== 'page') continue;
        try {
          const p = await t.page();
          const isPip = await p.evaluate(() => window === (window.documentPictureInPicture && documentPictureInPicture.window)).catch(() => false);
          if (isPip) return p;
        } catch {}
      }
      await sleep(300);
    }
    return null;
  }

  // A: requestWindow({512,320}) 立即读 + 1.5s 后读
  const a = await page.evaluate(async () => {
    const w = await documentPictureInPicture.requestWindow({ width: 512, height: 320 });
    return [w.innerWidth, w.innerHeight, w.outerWidth, w.outerHeight];
  });
  console.log('A {512,320} immediate:', JSON.stringify(a));
  await sleep(1500);
  const a2 = await page.evaluate(() => {
    const w = documentPictureInPicture.window;
    return [w.innerWidth, w.innerHeight];
  });
  console.log('A after 1.5s:', JSON.stringify(a2));
  await page.evaluate(() => documentPictureInPicture.window.close());
  await sleep(600);

  // D: requestWindow({800,500})
  const d = await page.evaluate(async () => {
    const w = await documentPictureInPicture.requestWindow({ width: 800, height: 500 });
    return [w.innerWidth, w.innerHeight];
  });
  console.log('D {800,500}:', JSON.stringify(d));
  await page.evaluate(() => documentPictureInPicture.window.close());
  await sleep(600);

  // B: 真实点击 pip 窗口 → (无 CDP 手势的异步 task 中) resizeTo(600,400)
  const b = await page.evaluate(async () => {
    await documentPictureInPicture.requestWindow({});
    return true;
  });
  console.log('B opened:', b);
  await sleep(500);
  const pipPage = await findPipPage();
  console.log('pip page found:', !!pipPage);
  if (pipPage) {
    await pipPage.mouse.click(300, 200); // 真实点击激活 pip 文档
    await sleep(200);
    await page.evaluate(() => {
      const w = documentPictureInPicture.window;
      setTimeout(() => {
        try { w.resizeTo(600, 400); window.__bres = { ok: true }; }
        catch (e) { window.__bres = { ok: false, err: String(e) }; }
      }, 120);
    });
    await sleep(700);
    const b2 = await page.evaluate(() => ({
      res: window.__bres,
      size: [documentPictureInPicture.window.innerWidth, documentPictureInPicture.window.innerHeight],
    }));
    console.log('B real-click resizeTo(600,400):', JSON.stringify(b2));

    // C: 超大尺寸 clamp 行为
    await pipPage.mouse.click(300, 200);
    await sleep(200);
    await page.evaluate(() => {
      const w = documentPictureInPicture.window;
      setTimeout(() => {
        try { w.resizeTo(1600, 900); window.__cres = { ok: true }; }
        catch (e) { window.__cres = { ok: false, err: String(e) }; }
      }, 120);
    });
    await sleep(700);
    const c = await page.evaluate(() => ({
      res: window.__cres,
      size: [documentPictureInPicture.window.innerWidth, documentPictureInPicture.window.innerHeight],
    }));
    console.log('C real-click resizeTo(1600,900):', JSON.stringify(c));
  }

  await page.evaluate(() => { if (documentPictureInPicture.window) documentPictureInPicture.window.close(); });
  await browser.close();
  server.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
