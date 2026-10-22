#!/usr/bin/env node
/**
 * 国际原油（备用源 / 服务端专用）：金投网行情中心 jijinhao
 *   实时：https://api.jijinhao.com/quoteCenter/realTime.htm?codes=JO_92272,JO_108878
 *   日线：https://api.jijinhao.com/sQuoteCenter/kDataList.htm?code=JO_92272
 *
 * 代码字典：
 *   JO_92272  = 布伦特原油连续 (showCode BOIL)
 *   JO_108878 = 纽约原油连续   (showCode WCL)
 *
 * ⚠️ 重要限制：**防盗链**。Referer 必须严格等于 https://quote.cngold.org/ ，否则 HTTP 666。
 *    浏览器跨域 fetch 会带自己的 Referer（http://localhost:5173/）→ 666。
 *    ⇒ 这个源**只能在服务端用**（Node / curl），不能浏览器直连。
 *    响应头本身是 access-control-allow-origin: *，但 Referer 校验先把它拦掉了。
 *
 * 好处：返回标准 JSON，且自带 showName / unit / digits（和金投网前端口径一致）。
 * 实时字段映射（已与腾讯行情逐字段比对校准）：
 *   q1=开盘价  q2=昨结算  q3=最高价  q4=最低价  q5=最新价  q6=卖价
 *   q64=昨收盘  q70=涨跌额  q80=涨跌幅(%)  q60=成交量  q62=持仓量
 *   unit=单位  showName=显示名  showCode=品种码  digits=小数位  time=行情时间(ms)
 *
 * 运行：node crude-jijinhao.mjs
 */

const REFERER = 'https://quote.cngold.org/';
const RT_URL = 'https://api.jijinhao.com/quoteCenter/realTime.htm?codes=JO_92272,JO_108878';
const KD_URL = 'https://api.jijinhao.com/sQuoteCenter/kDataList.htm?code=';

const HEADERS = {
  Referer: REFERER,
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: '*/*',
};

const CODES = {
  JO_92272: { showName: '布伦特原油连续', symbol: 'Brent', en: 'Brent' },
  JO_108878: { showName: '纽约原油连续', symbol: 'WTI', en: 'WTI' },
};

const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

/** 从 `var xxx = {...};` 里抠出 JSON */
function extractJson(text) {
  const m = text.match(/=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!m) throw new Error(`响应不是预期的 JS 赋值格式：${text.slice(0, 120)}`);
  return JSON.parse(m[1]);
}

async function text(url) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} <- ${url}（666 = Referer 防盗链没通过）`);
  return res.text();
}

export async function fetchCrudeRealtime() {
  const json = extractJson(await text(RT_URL));
  const rows = [];
  for (const [code, raw] of Object.entries(json)) {
    if (code === 'flag' || !raw || typeof raw !== 'object') continue;
    if (!/^JO_\d+$/.test(code)) continue; // 过滤 errorCode 之类的附加字段
    const meta = CODES[code] || {};
    rows.push({
      code,
      showName: raw.showName || meta.showName || code,
      showCode: raw.showCode || null,
      symbol: meta.symbol || code,
      unit: raw.unit || '美元/桶',
      digits: raw.digits ?? 2,
      price: r2(raw.q5),
      change: r2(raw.q70),        // 涨跌额（相对昨结算）
      changePct: r2(raw.q80 * 100) / 100, // 涨跌幅 %（源里就是小数）
      prevClose: r2(raw.q2),      // 昨结算
      prevSettle: r2(raw.q64),    // 昨收盘
      open: r2(raw.q1),
      high: r2(raw.q3),
      low: r2(raw.q4),
      ask: r2(raw.q6),
      volume: raw.q60 ?? null,
      hold: raw.q62 ?? null,
      time: raw.time ? new Date(raw.time).toISOString() : null,
    });
  }
  if (!rows.length) throw new Error('realTime 未解析出行情');
  return { ok: true, source: RT_URL, updatedAt: rows[0].time, rows };
}

/** 日线历史（data[0]=日线, data[1]=月线, data[2]=周线） */
export async function fetchCrudeDaily(code = 'JO_92272', days = 30) {
  const json = extractJson(await text(KD_URL + code));
  const daily = json?.data?.[0] || [];
  const bars = daily.slice(-days).map((b) => ({
    date: b.day,
    open: r2(b.open),
    high: r2(b.high),
    low: r2(b.low),
    close: r2(b.close),
    change: r2(b.change),
    changePct: r2(b.percent * 100),
    volume: b.volume ?? null,
  }));
  return {
    ok: true,
    source: KD_URL + code,
    code,
    showName: CODES[code]?.showName ?? code,
    unit: '美元/桶',
    digits: 2,
    bars,
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    const rt = await fetchCrudeRealtime();
    const daily = await fetchCrudeDaily('JO_92272', 8);
    console.log(
      JSON.stringify(
        { ...rt, dailyBrent: { showName: daily.showName, unit: daily.unit, bars: daily.bars } },
        null,
        process.argv.includes('--pretty') ? 2 : 0
      )
    );
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2));
    process.exitCode = 1;
  }
}
