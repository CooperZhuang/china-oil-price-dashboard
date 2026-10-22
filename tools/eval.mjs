/**
 * eval.mjs — 在页面里执行一段表达式并打印结果（开发自检用）
 *
 * 与 shot.mjs 一样需要覆盖 User-Agent，否则上游 WAF 会拦截无头浏览器（HTTP 666）。
 * 用法： node tools/eval.mjs <url> <expr-file>
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [, , url, exprFile] = process.argv;
if (!url || !exprFile) {
  console.error('usage: node tools/eval.mjs <url> <expr-file>');
  process.exit(1);
}
const EXPR = readFileSync(exprFile, 'utf8');

const profile = mkdtempSync(join(tmpdir(), 'oil-eval-'));
const port = 9700 + Math.floor(Math.random() * 200);
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1500, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  await sleep(9000);
  const out = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify(out.result.value ?? out.result, null, 2));
  ws.close();
} finally {
  proc.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* noop */ }
}
process.exit(0);
