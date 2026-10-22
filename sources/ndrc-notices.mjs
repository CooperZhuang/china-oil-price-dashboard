#!/usr/bin/env node
/**
 * 源 4（权威口径 / 交叉校验）：国家发改委「新闻发布」栏目里的成品油调价公告
 *   https://www.ndrc.gov.cn/xwdt/xwfb/index.html   （列表页，可分页 index_1.html …）
 *   单篇公告：/xwdt/xwfb/202610/t20261015_1408170.html
 *
 * 能拿到（结构化 HTML，GET，无 Referer 要求）：
 *   - 调价公告标题 + 发布时间（标题即含「上调 / 下调 / 不作调整」+ 日期）
 *   - 公告正文里的「汽、柴油（标准品）价格每吨分别应上调 XXXX 元」
 *   - 生效时间「自 X 月 X 日 24 时起」
 *   - 「各省（区、市）汽、柴油最高零售价格」**附件是一张 JPG 图片**（需 OCR，不是结构化数据）
 * 不能拿到：
 *   - 下一次调价窗口日期（发改委从不预告具体日期，只能按 10 个工作日规则推算）
 *   - 结构化的各省最高零售价格表（只有图片）
 *
 * 运行：node ndrc-notices.mjs
 */

const LIST_BASE = 'https://www.ndrc.gov.cn/xwdt/xwfb/';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
};

const stripTags = (s) =>
  s
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const abs = (href, base) => {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
};

/** 从标题判定方向：上调 / 下调 / 不作调整 */
function classify(title) {
  if (/不作调整|不作上调|不作下调|暂缓调整/.test(title)) return 'none';
  if (/下调|降低/.test(title)) return 'down';
  if (/上调|提高|适当调整/.test(title)) return 'up';
  return 'unknown';
}

/** 列表页 -> 公告条目 */
export async function fetchNotices(pages = 3) {
  const items = [];
  const seen = new Set();

  for (let i = 0; i < pages; i++) {
    const url = i === 0 ? `${LIST_BASE}index.html` : `${LIST_BASE}index_${i}.html`;
    const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
    if (!res.ok) continue;
    const html = await res.text();

    // <a href="./202610/t20261015_1408170.html">2026年10月15日国内成品油价格不作调整</a>
    const aRe = /<a[^>]+href="([^"]*t(\d{8})_\d+\.html)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = aRe.exec(html)) !== null) {
      const href = abs(m[1], url);
      const title = stripTags(m[3]);
      if (!href || !title) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      const d = m[2]; // YYYYMMDD
      items.push({
        title,
        date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
        url: href,
        action: classify(title),
      });
    }
  }

  items.sort((a, b) => (a.date < b.date ? 1 : -1));
  const oilItems = items.filter((it) => /成品油价格/.test(it.title));
  return { all: items, oil: oilItems };
}

/** 抓单篇公告正文 */
export async function fetchNoticeDetail(item) {
  const res = await fetch(item.url, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} <- ${item.url}`);
  const html = await res.text();

  const m = html.match(/<div class=TRS_Editor>([\s\S]*?)<\/div>\s*<\/div>/i);
  const body = m ? m[1] : html;
  const text = stripTags(body);

  // 「自X月X日24时起」/「X月X日24时起」—— 注意「24 时起」= 当天结束 => 生效日是次日 0 点
  const eff = text.match(/(?:自)?(\d{1,2})月(\d{1,2})日24时起/);
  const year = item.date.slice(0, 4);
  const effDate = eff
    ? `${year}-${String(eff[1]).padStart(2, '0')}-${String(eff[2]).padStart(2, '0')}`
    : null;
  const effectiveAt = effDate ? `${effDate} 24:00` : null;
  // 实际生效的日历日：公告日 + 1 天（与 cngold 的 date 字段口径一致）
  //   2026-09-24 公告「自9月24日24时起」 -> 生效 2026-09-25（cngold date=2026-09-25）
  //   2026-10-15 公告「不作调整」        -> 生效 2026-10-16（cngold date=2026-10-16）
  const effectiveDate = new Date(
    new Date(item.date + 'T00:00:00Z').getTime() + 86400000
  ).toISOString().slice(0, 10);

  // 「汽、柴油（标准品）价格每吨分别应上调830元、800元」
  const perTon = text.match(/汽、柴油(?:（标准品）)?价格每吨分别应(上调|下调)(?:约)?(\d+)\s*元、\s*(\d+)\s*元/);
  // 「本次汽、柴油价格不作调整」
  const noChange = /不作调整|暂不调整/.test(text);

  // 「各省（区、市）…最高零售价格」附件：JPG 图片（需 OCR，非结构化）
  const images = [...body.matchAll(/<img[^>]+src="([^"]+)"[^>]*>/g)].map((x) => abs(x[1], item.url));
  const hasProvinceTable = /各省.{0,12}(最高零售价格|汽、?柴油最高零售价格)/.test(text);

  return {
    ...item,
    effectiveAt,
    effectiveDate,                        // 实际生效日（cngold 的 date 字段口径）
    action: noChange ? 'none' : perTon ? (perTon[1] === '上调' ? 'up' : 'down') : classify(item.title),
    perTon: perTon
      ? { gasoline: Number(perTon[2]), diesel: Number(perTon[3]) }
      : null,
    hasProvinceTable,
    provinceTableImages: hasProvinceTable ? images : [],
    bodyText: text.slice(0, 600),
  };
}

/**
 * 推算下一次调价窗口：上一次调价日 + 10 个工作日（发改委《石油价格管理办法》）
 * 注意：这里只跳过周末；遇法定节假日顺延需要额外的节假日日历，脚本未内置。
 * 实测：2026-10-16(周五) + 10 个工作日 = 2026-10-30(周五)，与 cngold near_time 一致。
 */
export function deriveNextWindow(lastAdjustDate, holidayDates = new Set()) {
  if (!lastAdjustDate) return null;
  // 纯 UTC 运算：混用 +08:00 偏移和 getUTCDay() 会把周六/周日算错（曾导致 off-by-one）
  const d = new Date(lastAdjustDate + 'T00:00:00Z');
  let added = 0;
  while (added < 10) {
    d.setUTCDate(d.getUTCDate() + 1);
    const ds = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (holidayDates.has(ds)) continue;
    added++;
  }
  return d.toISOString().slice(0, 10);
}

export async function fetchNdrc() {
  const { oil } = await fetchNotices(3);
  const details = [];
  for (const it of oil.slice(0, 3)) {
    try {
      details.push(await fetchNoticeDetail(it));
    } catch (e) {
      details.push({ ...it, error: String(e?.message || e) });
    }
  }

  const latest = details.find((d) => !d.error) || null;
  // 生效日 = 公告日 + 1 天（「24 时起」）。发改委从不预告下一个窗口，只能按 10 个工作日推算。
  const lastAdjustDate = latest?.effectiveDate ?? latest?.date ?? null;

  return {
    ok: details.length > 0,
    source: LIST_BASE,
    updatedAt: latest?.date ?? null,
    lastAdjustDate,
    nextAdjustDate: deriveNextWindow(lastAdjustDate),
    nextAdjustDateNote:
      '由「生效日 + 10 个工作日」推算（发改委不预告具体日期；与 cngold near_time 交叉核对一致）',
    notices: details.map((d) => ({
      date: d.date,
      title: d.title,
      url: d.url,
      action: d.action,
      effectiveAt: d.effectiveAt,
      effectiveDate: d.effectiveDate,
      perTon: d.perTon,
      hasProvinceTable: d.hasProvinceTable,
      provinceTableImages: d.provinceTableImages,
    })),
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    const data = await fetchNdrc();
    console.log(JSON.stringify(data, null, process.argv.includes('--pretty') ? 2 : 0));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: String(e?.message || e), source: LIST_BASE }, null, 2));
    process.exitCode = 1;
  }
}
