/**
 * shot.mjs — 用 CDP 在精确视口下截图（开发自检用）
 *
 * 两个关键点：
 * 1. headless Edge 的 --window-size 在本机不生效（请求 430x932 实际视口 492x848），
 *    必须用 Emulation.setDeviceMetricsOverride 才能得到确定尺寸。
 * 2. 上游 WAF 会拦截 HeadlessChrome 的 User-Agent（返回 HTTP 666），
 *    所以这里用 Emulation.setUserAgentOverride 换成普通 Chrome UA。
 *
 * 用法： node tools/shot.mjs <url> <out.png> [width] [height] [theme] [dsf]
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function capture({
  url, out, width = 1280, height = 1400, theme = 'dark', dsf = 1, waitMs = 12000,
}) {
  const profile = mkdtempSync(join(tmpdir(), 'oil-shot-'));
  const port = 9500 + Math.floor(Math.random() * 400);
  const proc = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let target = null;
    for (let i = 0; i < 200; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && !t.url.startsWith('edge://'))
          || list.find((t) => t.type === 'page');
        if (target) break;
      } catch { /* 还没起来 */ }
      await sleep(150);
    }
    if (!target) throw new Error('CDP 未就绪，未找到 page target');
    if (!target) throw new Error('no CDP page target');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

    await send('Page.enable');
    await send('Network.enable');
    await send('Emulation.setUserAgentOverride', { userAgent: CHROME_UA });
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: dsf, mobile: width < 700,
    });
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: theme }],
    });
    await send('Page.navigate', { url });

    // 等页面稳定：无图片的页面用 readyState 判定，有图片则等 decode
    const deadline = Date.now() + waitMs;
    let settled = false;
    while (Date.now() < deadline) {
      await sleep(250);
      try {
        const probe = await send('Runtime.evaluate', {
          expression: `(async () => {
            if (document.readyState !== 'complete') return false;
            const imgs = [...document.images];
            if (!imgs.length) return true;
            if (!imgs.every((i) => i.complete && i.naturalWidth > 0)) return false;
            await Promise.all(imgs.map((i) => (i.decode ? i.decode().catch(() => {}) : null)));
            return true;
          })()`,
          returnByValue: true,
          awaitPromise: true,
        });
        if (probe.result.value === true) { settled = true; break; }
      } catch { /* 页面可能正在导航 */ }
    }
    if (!settled) console.warn('  ! 页面未在时限内稳定');
    await sleep(600);

    // headless 渲染器不主动出帧：先截一次强制出帧，等两拍 rAF 再截第二次取用，
    // 否则大图可能只画占位底色
    await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await send('Runtime.evaluate', {
      expression: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))',
      awaitPromise: true,
    }).catch(() => {});
    await sleep(400);

    const shot = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false, fromSurface: true,
    });
    writeFileSync(out, Buffer.from(shot.data, 'base64'));
    ws.close();
    return out;
  } finally {
    proc.kill();
    await sleep(300);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch { /* 临时目录残留无妨 */ }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , url, out, w, h, theme, dsf] = process.argv;
  if (!url || !out) {
    console.error('usage: node tools/shot.mjs <url> <out.png> [width] [height] [theme] [dsf]');
    process.exit(1);
  }
  const file = await capture({
    url, out,
    width: Number(w ?? 1280),
    height: Number(h ?? 1400),
    theme: theme ?? 'dark',
    dsf: Number(dsf ?? 1),
  });
  console.log('written', file);
}
