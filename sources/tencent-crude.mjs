#!/usr/bin/env node
/**
 * 源 2（国际原油 WTI/Brent）：腾讯财经行情
 *   https://qt.gtimg.cn/q=hf_CL,hf_OIL
 *
 * - GET、无需登录、无需 Referer
 * - 响应头 access-control-allow-origin: *  → 浏览器可直连
 * - Content-Type: text/html; charset=GBK → Node 必须用 TextDecoder('gbk') 解码
 * - 非 JSON，是 JS 赋值语句：v_hf_CL="..."; 需要自己切字段
 *
 * 字段顺序（腾讯外盘期货，实测校准）：
 *   0 当前价 1 涨跌幅(%) 2 买价 3 卖价 4 最高 5 最低 6 时间(HH:mm:ss)
 *   7 昨收 8 开盘 9 持仓量 10 买量 11 卖量 12 日期(YYYY-MM-DD) 13 品种名
 *
 * 运行：node tencent-crude.mjs
 */

const URL = 'https://qt.gtimg.cn/q=hf_CL,hf_OIL';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Referer: 'https://gu.qq.com/',
};

// 品种代码 -> 展示名 / 单位 / 小数位（对齐 cngold 的 showName / unit / digits 风格）
const META = {
  hf_CL: { showName: '纽约原油(WTI)', unit: '美元/桶', digits: 2 },
  hf_OIL: { showName: '布伦特原油(Brent)', unit: '美元/桶', digits: 2 },
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

export async function fetchCrude() {
  const res = await fetch(URL, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} <- ${URL}`);

  const buf = Buffer.from(await res.arrayBuffer());
  // 腾讯行情返回 GBK；Node 内置 TextDecoder 支持 gbk（需 full-icu，Node 14+ 官方包默认带）
  let text;
  try {
    text = new TextDecoder('gbk').decode(buf);
  } catch {
    text = buf.toString('utf8');
  }

  const rows = [];
  const re = /v_([A-Za-z0-9_]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const code = m[1];
    const f = m[2].split(',');
    if (f.length < 14) continue;
    const meta = META[code] || { showName: code, unit: '美元/桶', digits: 2 };
    const price = num(f[0]);
    const prevClose = num(f[7]);
    rows.push({
      code,
      showName: meta.showName,
      unit: meta.unit,
      digits: meta.digits,
      price,
      changePct: num(f[1]),        // 腾讯给的涨跌幅(%)
      change: prevClose != null && price != null ? r2(price - prevClose) : null, // 自己算涨跌额
      prevClose,
      open: num(f[8]),
      high: num(f[4]),
      low: num(f[5]),
      bid: num(f[2]),
      ask: num(f[3]),
      time: f[6],                 // HH:mm:ss
      date: f[12],                // YYYY-MM-DD
      raw: m[2],
    });
  }

  if (!rows.length) throw new Error(`未解析出行情，原始响应：${text.slice(0, 200)}`);

  const updatedAt = rows[0]?.date
    ? `${rows[0].date} ${rows[0].time}`
    : new Date().toISOString();

  return {
    ok: true,
    source: URL,
    updatedAt,
    rows,
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    const data = await fetchCrude();
    console.log(JSON.stringify(data, null, process.argv.includes('--pretty') ? 2 : 0));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String(e?.message || e), source: URL }, null, 2));
    process.exitCode = 1;
  }
}
