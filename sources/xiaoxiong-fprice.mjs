#!/usr/bin/env node
/**
 * 源 3（交叉校验 + 调价倒计时）：小熊油耗「今日油价」
 *   https://www.xiaoxiongyouhao.com/fprice/          —— 全国各省市 92#/95#/0#柴（服务端渲染 HTML）
 *   https://www.xiaoxiongyouhao.com/fprice/cityprice.php?city=北京市   —— 单市历史页
 *
 * - GET、无需登录、无需 Referer
 * - **没有 CORS 响应头** → 浏览器不能跨域直连，只能服务端抓（或走代理）
 * - **没有 JSON 接口**：省份表是服务端渲染进 HTML 的 <table class="price-table">
 *   省��� | 92# | 95# | 0#柴   （注意：此表不含 98#）
 * - 页面里带「上次调价 / 还有 N 天 / 下次调价」倒计时条
 *
 * 运行：node xiaoxiong-fprice.mjs
 */

const URL = 'https://www.xiaoxiongyouhao.com/fprice/';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  Referer: 'https://www.xiaoxiongyouhao.com/',
};

const stripTags = (s) =>
  s
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const num = (s) => {
  const m = String(s).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

export async function fetchXiaoxiong() {
  const res = await fetch(URL, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} <- ${URL}`);
  const html = await res.text();

  const rows = [];
  // <tr><td class="region-name"><a href="/fprice/cityprice.php?city=北京市">北京市</a></td><td>8.61</td><td>9.17</td><td>8.36</td></tr>
  const trRe = /<tr[^>]*>\s*<td[^>]*class="region-name"[^>]*>([\s\S]*?)<\/td>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const province = stripTags(m[1]);
    const tds = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => stripTags(x[1]));
    if (!province || tds.length < 3) continue;
    rows.push({
      province,                                   // 北京市 / 河北省 / 内蒙古自治区 …
      shortName: province.replace(/(省|市)$/, ''), // 北京 / 河北 / 内蒙古（去后缀，便于匹配）
      p92: num(tds[0]),
      p95: num(tds[1]),
      p0: num(tds[2]),
      p98: null, // 该表不提供 98#
    });
  }

  // 调价倒计时条
  let lastAdjust = null, nextAdjust = null, daysLeft = null;
  const adjBlock = html.match(/price-adj-progress[\s\S]{0,1200}?<\/div>\s*<\/div>/i);
  if (adjBlock) {
    const t = stripTags(adjBlock[0]);
    lastAdjust = (t.match(/上次调价：(\d{1,2}-\d{1,2})/) || [])[1] || null;
    nextAdjust = (t.match(/下次调价：(\d{1,2}-\d{1,2})/) || [])[1] || null;
    daysLeft = num((t.match(/还有(\d+)天/) || [])[1]);
  }

  // 页面标题里的日期：<title>2026年10月22日全国各省市今日油价查询｜...</title>
  const titleDate = (html.match(/<title>(\d{4})年(\d{1,2})月(\d{1,2})日/) || []);
  const pageDate = titleDate.length
    ? `${titleDate[1]}-${String(titleDate[2]).padStart(2, '0')}-${String(titleDate[3]).padStart(2, '0')}`
    : null;

  // 「今日油价（2026-10-22）」小标题
  const todayDate = (html.match(/今日油价（(\d{4}-\d{2}-\d{2})）/) || [])[1] || pageDate;

  return {
    ok: rows.length > 0,
    source: URL,
    updatedAt: todayDate,
    lastAdjust,
    nextAdjust,
    daysLeft,
    provinces: rows.length,
    rows,
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    const data = await fetchXiaoxiong();
    console.log(JSON.stringify(data, null, process.argv.includes('--pretty') ? 2 : 0));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String(e?.message || e), source: URL }, null, 2));
    process.exitCode = 1;
  }
}
