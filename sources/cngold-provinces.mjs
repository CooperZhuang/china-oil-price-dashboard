#!/usr/bin/env node
/**
 * 源 1（主源）：金投网 cngold「城市油价」数据中心
 *   https://datacenter.cngold.org/city_oil/all_price_by_year/   —— 全国 31 省调价表（JSON）
 *   https://datacenter.cngold.org/city_oil/near_time/            —— 上次/下次调价窗口（JSON）
 *   https://datacenter.cngold.org/city_oil/price_history/?regionId=12  —— 单省历史（JSON）
 *
 * 特性：GET、无需登录、无需 Referer、响应头 access-control-allow-origin: *（浏览器可直连）
 * 零依赖：只用 node: 内置模块（global fetch / TextDecoder）
 *
 * 运行：node cngold-provinces.mjs            # 打印 JSON
 *      node cngold-provinces.mjs --pretty    # 美化输出
 *      node cngold-provinces.mjs --province=浙江省   # 只抓某个省（含历史）
 */

const BASE = 'https://datacenter.cngold.org';
const ALL_URL = `${BASE}/city_oil/all_price_by_year/`;
const NEAR_URL = `${BASE}/city_oil/near_time/`;
const HIST_URL = `${BASE}/city_oil/price_history/`;

const HEADERS = {
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Referer: 'https://quote.cngold.org/oil/youjia.html',
};

const OIL = {
  n89: 'p89', n92: 'p92', n95: 'p95', n98: 'p98',
  n0: 'p0', n10: 'p10', n20: 'p20', n35: 'p35',
};

async function getJSON(url) {
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} <- ${url}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`响应不是合法 JSON <- ${url}: ${text.slice(0, 200)}`);
  }
  if (json.returnCode !== 0) throw new Error(`returnCode=${json.returnCode} ${json.message} <- ${url}`);
  return json;
}

const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

/**
 * 把 all_price_by_year 的扁平历史行 -> 每省「当前价 / 上一次调价价 / 涨跌幅」
 *
 * 重要语义（实测踩坑）：
 *  cngold 在「本次窗口不调价」时也会写一条 date 新的记录，且 *Change 全为 0、价格与上一条完全相同。
 *  例：2026-10-16 那一行 31 个省 n92Change 全是 0，价格与 2026-09-25 一字不差
 *      —— 因为发改委当天发文「不作调整」（见 ndrc-notices.mjs）。
 *  所以「当前价」取最新一条；而「涨跌额」必须取**最近一次真正调价**那条记录，
 *  否则页面上永远显示「涨跌 0.00」。
 */
function buildRows(all) {
  const byRegion = new Map();
  for (const r of all) {
    if (!byRegion.has(r.regionName)) byRegion.set(r.regionName, []);
    byRegion.get(r.regionName).push(r);
  }

  const rows = [];
  for (const [province, list] of byRegion) {
    list.sort((a, b) => (a.date < b.date ? 1 : -1)); // date desc
    const cur = list[0];
    const prevRow = list[1] || null;

    // 最近一次「真正调价」的记录（任一油品 change 非 0）
    const adj = list.find((r) =>
      Object.keys(OIL).some((k) => r[`${k}Change`] && Math.abs(r[`${k}Change`]) > 0.0001)
    ) || null;
    // 调价前的上一轮记录 -> 「前值」
    const adjIdx = adj ? list.indexOf(adj) : -1;
    const beforeAdj = adjIdx >= 0 ? list[adjIdx + 1] || null : null;

    const prices = {};
    const changes = {};
    const prevPrices = {};
    for (const [k, key] of Object.entries(OIL)) {
      prices[key] = r2(cur[k]);
      changes[key] = r2(cur[`${k}Change`]);
      prevPrices[key] = prevRow ? r2(prevRow[k]) : null;
    }

    rows.push({
      province,
      regionId: cur.regionId,
      // 当前价（生效中）
      ...prices,
      // 本轮窗口的官方涨跌额（不调价时为 0）
      change: { ...changes },
      // 上一条历史记录的价格（用于自校验 current - prev）
      prev: prevPrices,
      // 最近一次「实际调价」的信息：这就是看板该显示的涨跌额
      lastAdjust: adj
        ? {
            date: adj.date,
            chg: Object.fromEntries(
              Object.keys(OIL).map((k) => [OIL[k], r2(adj[`${k}Change`])])
            ),
            // 调价前一轮的价格（= 看板里的「前值」）
            before: beforeAdj
              ? Object.fromEntries(Object.keys(OIL).map((k) => [OIL[k], r2(beforeAdj[k])]))
              : null,
          }
        : null,
      // 本轮窗口是否「不调价」
      unchanged: prevRow
        ? Object.keys(OIL).every((k) => Math.abs((cur[k] ?? 0) - (prevRow[k] ?? 0)) < 0.0001)
        : null,
    });
  }

  // 按官方顺序大致排：直辖市/省按拼音无所谓，这里按 regionId 升序保证稳定
  rows.sort((a, b) => (a.regionId ?? 0) - (b.regionId ?? 0));
  return rows;
}

export async function fetchProvinces() {
  const [allJson, nearJson] = await Promise.all([getJSON(ALL_URL), getJSON(NEAR_URL)]);
  const all = allJson.data || [];
  if (!all.length) throw new Error('all_price_by_year 返回空 data');

  const rows = buildRows(all);
  const dates = [...new Set(all.map((r) => r.date))].sort();
  const latestDate = dates[dates.length - 1];

  // near_time: data[0] = 最近一次调整日, data[1] = 下一次调整窗口日
  const near = nearJson.data || [];
  const lastAdjustDate = near[0]?.date ?? null;
  const nextAdjustDate = near[1]?.date ?? null;

  return {
    ok: true,
    source: ALL_URL,
    updatedAt: latestDate,               // 当前价格对应的调价日
    lastAdjustDate,                      // 最近一次调整（可能是「不作调整」）
    nextAdjustDate,                      // 下一次调整窗口日
    nextAdjustInDays: nextAdjustDate
      ? Math.max(
          0,
          Math.round(
            (new Date(nextAdjustDate + 'T00:00:00+08:00') - new Date(Date.now())) / 86400000
          )
        )
      : null,
    provinces: rows.length,
    rows,
  };
}

/** 单省历史（可选），regionId 取自 rows[].regionId；浙江=12 */
export async function fetchProvinceHistory(regionId) {
  const j = await getJSON(`${HIST_URL}?regionId=${regionId}`);
  const list = (j.data || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  return {
    ok: true,
    source: `${HIST_URL}?regionId=${regionId}`,
    regionId: Number(regionId),
    regionName: list[0]?.regionName ?? null,
    updatedAt: list[0]?.date ?? null,
    history: list.map((r) => ({
      date: r.date,
      p89: r2(r.n89), p92: r2(r.n92), p95: r2(r.n95), p98: r2(r.n98),
      p0: r2(r.n0), p10: r2(r.n10),
      chg92: r2(r.n92Change), chg95: r2(r.n95Change), chg98: r2(r.n98Change), chg0: r2(r.n0Change),
    })),
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const provArg = args.find((a) => a.startsWith('--province='));
  try {
    if (provArg) {
      const name = provArg.split('=')[1];
      const base = await fetchProvinces();
      const row = base.rows.find((r) => r.province === name || r.province.includes(name));
      if (!row) throw new Error(`未找到省份：${name}`);
      const hist = await fetchProvinceHistory(row.regionId);
      console.log(JSON.stringify({ ...base, rows: undefined, target: row, history: hist.history.slice(0, 8) }, null, 2));
    } else {
      const data = await fetchProvinces();
      const pretty = args.includes('--pretty');
      console.log(JSON.stringify(data, null, pretty ? 2 : 0));
    }
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String(e?.message || e), source: ALL_URL }, null, 2));
    process.exitCode = 1;
  }
}
