/**
 * check.mjs — 页面功能自测（CDP 驱动真实浏览器）
 *
 * 覆盖：真实取数、地区切换、表格排序、图表油品切换、主题切换、
 *       接口失败时的错误态、以及本地快照兜底。
 *
 * 运行： node tools/check.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:4180';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function assert(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `  -> ${detail}` : ''}`);
  }
}

async function withPage(url, fn, { blockApi = false, width = 1280, height = 1400 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'oil-check-'));
  const port = 9800 + (process.pid % 100) * 20 + Math.floor(Math.random() * 20);
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
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      });
      return r.result.value;
    };

    await send('Page.enable');
    await send('Network.enable');
    await send('Emulation.setUserAgentOverride', { userAgent: CHROME_UA });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

    if (blockApi) {
      await send('Network.setBlockedURLs', {
        urls: ['*datacenter.cngold.org*'],
      });
    }

    await send('Page.navigate', { url });
    await sleep(6000);
    return await fn({ evaluate, send, sleep });
  } finally {
    proc.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* noop */ }
  }
}

console.log('正常态：真实取数 + 默认上海');
await withPage(BASE, async ({ evaluate }) => {
  const s = await evaluate(`(() => ({
    errorHidden: document.getElementById('error-panel').hidden,
    contentHidden: document.getElementById('content').hidden,
    region: document.getElementById('hero-region').textContent,
    price: document.getElementById('hero-price').textContent,
    next: document.getElementById('stat-next').textContent,
    avg: document.getElementById('stat-avg').textContent,
    regionOptions: document.getElementById('region-select').options.length,
    fuelSegs: document.querySelectorAll('.seg--fuel .seg__btn').length,
    fuelCards: document.querySelectorAll('.fuel').length,
    rows: document.querySelectorAll('#nation-body tr').length,
    chartPaths: document.querySelectorAll('#trend-chart svg path').length,
    source: document.getElementById('source-line').textContent,
    docTitle: document.title,
    heroTitle: document.getElementById('hero-title').textContent,
  }))()`);
  console.log('   ', JSON.stringify(s, null, 2).replace(/\n/g, '\n    '));
  assert('未进入错误态', s.errorHidden === true);
  assert('内容区可见', s.contentHidden === false);
  assert('默认地区是上海市', s.region === '上海市', s.region);
  assert('默认油品是 92#', s.heroTitle === '92# 汽油', s.heroTitle);
  assert('油品切换器有 6 项', s.fuelSegs === 6, String(s.fuelSegs));
  assert('92# 价格是数字', /^\d+\.\d{2}$/.test(s.price), s.price);
  assert('全国均价是数字', /^\d+\.\d{2}$/.test(s.avg), s.avg);
  assert('下个调价窗口有值', /^\d+\/\d+$/.test(s.next), s.next);
  assert('地区下拉 31 项', s.regionOptions === 31, String(s.regionOptions));
  assert('6 个油品卡', s.fuelCards === 6, String(s.fuelCards));
  assert('表格 31 行', s.rows === 31, String(s.rows));
  assert('图表已绘制', s.chartPaths >= 2, String(s.chartPaths));
  assert('标题含品牌', s.docTitle.includes('油价看板'), s.docTitle);
});

console.log('\n交互：切换地区');
await withPage(BASE, async ({ evaluate }) => {
  const before = await evaluate(`document.getElementById('hero-price').textContent`);
  const after = await evaluate(`(() => {
    const sel = document.getElementById('region-select');
    sel.value = '海南省';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      region: document.getElementById('hero-region').textContent,
      price: document.getElementById('hero-price').textContent,
      fuelsNote: document.getElementById('fuels-note').textContent,
      currentRow: document.querySelector('#nation-body tr.is-current td').textContent,
    };
  })()`);
  assert('地区已切换', after.region === '海南省', after.region);
  assert('价格随之变化', after.price !== before, `${before} -> ${after.price}`);
  assert('说明文案同步', after.fuelsNote.includes('海南省'), after.fuelsNote);
  assert('表格当前行高亮', after.currentRow.includes('海南省'), after.currentRow);
});

console.log('\n交互：表格排序');
await withPage(BASE, async ({ evaluate }) => {
  const r = await evaluate(`(() => {
    const names = () => Array.from(document.querySelectorAll('#nation-body tr'))
      .map((tr) => tr.children[0].textContent.trim().replace(/当前$/, ''));
    const btn = document.querySelector('.th-sort[data-sort="name"]');
    btn.click();
    const asc = names();
    btn.click();
    const desc = names();
    const p = document.querySelector('.th-sort[data-sort="n92"]');
    p.click();
    const byPrice = Array.from(document.querySelectorAll('#nation-body tr'))
      .map((tr) => parseFloat(tr.children[1].textContent));
    // 升序应与 localeCompare('zh-CN') 一致（拼音序）
    const expectAsc = [...asc].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    return {
      ascFirst: asc[0],
      descFirst: desc[0],
      matchesLocale: JSON.stringify(asc) === JSON.stringify(expectAsc),
      reverse: JSON.stringify(desc) === JSON.stringify([...asc].reverse()),
      sorted: byPrice.every((v, i) => i === 0 || byPrice[i - 1] >= v),
    };
  })()`);
  assert('地区按拼音序升序', r.matchesLocale === true, r.ascFirst);
  assert('再点变降序且完全反序', r.reverse === true, r.descFirst);
  assert('按价格降序排列正确', r.sorted === true);
});

console.log('\n交互：油品切换');
await withPage(BASE, async ({ evaluate }) => {
  const r = await evaluate(`(() => {
    const snap = () => ({
      title: document.getElementById('hero-title').textContent,
      price: document.getElementById('hero-price').textContent,
      avg: document.getElementById('stat-avg').textContent,
      avgSub: document.getElementById('stat-avg-sub').textContent,
      cap: document.getElementById('trend-cap').textContent,
      segOn: document.querySelector('.seg--fuel .seg__btn.is-on')?.dataset.fuel,
      cardOn: document.querySelector('.fuel.is-on')?.dataset.fuel,
      pressed: document.querySelector('.seg--fuel .seg__btn[data-fuel="n0"]')?.getAttribute('aria-pressed'),
    });
    const before = snap();
    document.querySelector('.seg--fuel .seg__btn[data-fuel="n0"]').click();
    const after = snap();
    // 再点油品卡切回 95#
    document.querySelector('.fuel[data-fuel="n95"]').click();
    const viaCard = snap();
    return { before, after, viaCard };
  })()`);
  assert('切换前是 92#', r.before.segOn === 'n92' && r.before.title === '92# 汽油', JSON.stringify(r.before));
  assert('主标题跟随切换', r.after.title === '0# 柴油', r.after.title);
  assert('主价格跟随切换', r.after.price !== r.before.price, `${r.before.price} -> ${r.after.price}`);
  assert('全国均价跟随切换', r.after.avg !== r.before.avg, `${r.before.avg} -> ${r.after.avg}`);
  assert('趋势图跟随切换', r.after.cap.includes('0# 柴油'), r.after.cap);
  assert('油品卡高亮同步', r.after.cardOn === 'n0', String(r.after.cardOn));
  assert('选中态用 aria-pressed', r.after.pressed === 'true', String(r.after.pressed));
  assert('点油品卡也能切换', r.viaCard.segOn === 'n95' && r.viaCard.title === '95# 汽油', JSON.stringify(r.viaCard));
});

console.log('\n交互：主题切换');
await withPage(BASE, async ({ evaluate }) => {
  const r = await evaluate(`(() => {
    const out = [];
    for (let i = 0; i < 3; i += 1) {
      document.getElementById('theme-toggle').click();
      out.push(document.documentElement.getAttribute('data-theme'));
    }
    return out;
  })()`);
  assert('主题在 auto/light/dark 间循环', JSON.stringify(r) === JSON.stringify(['light', 'dark', 'auto']), JSON.stringify(r));
});

console.log('\n国际原油');
await withPage(BASE, async ({ evaluate }) => {
  const r = await evaluate(`(() => new Promise((resolve) => setTimeout(() => {
    const sec = document.getElementById('crude-section');
    resolve({
      hidden: sec.hidden,
      cards: Array.from(document.querySelectorAll('.crude')).map((c) => ({
        name: c.querySelector('.crude__name').textContent,
        price: c.querySelector('.crude__price').textContent,
        meta: c.querySelector('.crude__meta').textContent,
      })),
    });
  }, 3000)))()`);
  assert('原油区块已显示', r.hidden === false);
  assert('有 WTI 与布伦特两张卡', r.cards.length === 2, JSON.stringify(r.cards.map((c) => c.name)));
  assert('WTI 价格是数字', /^\d+\.\d{2}/.test(r.cards[0]?.price || ''), r.cards[0]?.price);
  assert('布伦特价格是数字', /^\d+\.\d{2}/.test(r.cards[1]?.price || ''), r.cards[1]?.price);
  assert('带涨跌与时间戳', /\d{4}-\d{2}-\d{2}/.test(r.cards[0]?.meta || ''), r.cards[0]?.meta);
});

console.log('\n记忆：刷新后恢复上次看的');
await withPage(BASE, async ({ evaluate, send, sleep }) => {
  const snap = `({
    region: document.getElementById('hero-region').textContent,
    fuel: document.querySelector('.seg--fuel .seg__btn.is-on')?.dataset.fuel,
    stored: localStorage.getItem('oil-board-prefs'),
  })`;
  const first = await evaluate(`(${snap})`);
  assert('首次访问是默认上海', first.region === '上海市', first.region);
  assert('首次访问油品是 92#', first.fuel === 'n92', String(first.fuel));

  await evaluate(`(() => {
    const sel = document.getElementById('region-select');
    sel.value = '浙江省';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('.seg--fuel .seg__btn[data-fuel="n0"]').click();
  })()`);
  await sleep(400);
  const switched = await evaluate(`(${snap})`);
  assert('切换后地区变为浙江省', switched.region === '浙江省', switched.region);
  assert('切换后油品变为 0# 柴油', switched.fuel === 'n0', String(switched.fuel));
  assert('偏好已写入 localStorage', !!switched.stored, String(switched.stored));

  await send('Page.reload');
  await sleep(5000);
  const reloaded = await evaluate(`(${snap})`);
  assert('刷新后恢复上次看的地区', reloaded.region === '浙江省', reloaded.region);
  assert('刷新后恢复上次看的油品', reloaded.fuel === 'n0', String(reloaded.fuel));
});

console.log('\n异常态：接口不可用');
await withPage(BASE, async ({ evaluate }) => {
  const s = await evaluate(`(() => ({
    errorHidden: document.getElementById('error-panel').hidden,
    contentHidden: document.getElementById('content').hidden,
    message: document.getElementById('error-message').textContent,
  }))()`);
  assert('显示错误面板', s.errorHidden === false);
  assert('内容区隐藏', s.contentHidden === true);
  assert('错误信息有内容', s.message.length > 5, s.message);
}, { blockApi: true });

console.log('\n兜底：使用本地快照');
await withPage(BASE, async ({ evaluate }) => {
  const s = await evaluate(`(() => {
    document.getElementById('use-snapshot').click();
    return new Promise((resolve) => setTimeout(() => resolve({
      contentHidden: document.getElementById('content').hidden,
      errorHidden: document.getElementById('error-panel').hidden,
      region: document.getElementById('hero-region').textContent,
      price: document.getElementById('hero-price').textContent,
      rows: document.querySelectorAll('#nation-body tr').length,
      source: document.getElementById('source-line').textContent,
    }), 2500));
  })()`);
  assert('快照模式渲染出内容', s.contentHidden === false);
  assert('错误面板已隐藏', s.errorHidden === true);
  assert('地区仍正确', s.region === '上海市', s.region);
  assert('价格有值', /^\d+\.\d{2}$/.test(s.price), s.price);
  assert('表格 31 行', s.rows === 31, String(s.rows));
  assert('说明标注为本地快照', s.source.includes('快照'), s.source);
}, { blockApi: true });

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
