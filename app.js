/* ==========================================================================
   油价看板 - 交互与渲染
   零依赖，原生 ES2020。数据源见 README。
   ========================================================================== */
(() => {
  'use strict';

  /* ---------------- 常量 ---------------- */
  const API_URL = 'https://datacenter.cngold.org/city_oil/all_price_by_year/';
  const SNAPSHOT_URL = 'data/snapshot.json';

  /** 油品定义：字段名、显示名、是否柴油 */
  const FUELS = [
    { key: 'n89', label: '89# 汽油', short: '89#' },
    { key: 'n92', label: '92# 汽油', short: '92#' },
    { key: 'n95', label: '95# 汽油', short: '95#' },
    { key: 'n98', label: '98# 汽油', short: '98#' },
    { key: 'n0', label: '0# 柴油', short: '0#柴油' },
    { key: 'n10', label: '-10# 柴油', short: '-10#柴油' },
  ];
  const DEFAULT_FUEL = 'n92';
  /** 记住上次看的地区与油品 */
  const STORE_KEY = 'oil-board-prefs';

  const DEFAULT_REGION = '上海';

  /** 数据里的地区名后缀不统一（上海 / 上海市 / 广西 / 广西壮族自治区），统一归一化后匹配 */
  const stripSuffix = (name) => {
    let s = String(name || '').trim();
    // 一轮可能剥不掉叠加的后缀（广西壮族自治区 -> 广西壮族 -> 广西）
    for (let i = 0; i < 3; i += 1) {
      const next = s.replace(/(壮族|回族|维吾尔族|特别行政区|自治区|省|市)$/, '');
      if (next === s) break;
      s = next;
    }
    return s;
  };

  /* ---------------- 状态 ---------------- */
  const state = {
    rows: [],
    dates: [],
    latestDate: null,
    byRegion: new Map(),   // 省名 -> { date -> row }
    region: DEFAULT_REGION,
    fuel: DEFAULT_FUEL,
    sort: { key: 'n92', dir: 'desc' },
    sourceLabel: '金投网 城市油价',
    offline: false,
    regionByNorm: new Map(),
    nextWindow: null,
  };

  /* ---------------- DOM ---------------- */
  const $ = (id) => document.getElementById(id);
  const el = {
    content: $('content'),
    skeleton: $('skeleton'),
    errorPanel: $('error-panel'),
    errorMessage: $('error-message'),
    retry: $('retry'),
    useSnapshot: $('use-snapshot'),
    refresh: $('refresh'),
    themeToggle: $('theme-toggle'),
    regionSelect: $('region-select'),
    heroRegion: $('hero-region'),
    heroTitle: $('hero-title'),
    heroPrice: $('hero-price'),
    heroDelta: $('hero-delta'),
    statAvg: $('stat-avg'),
    statAvgSub: $('stat-avg-sub'),
    statChg: $('stat-chg'),
    statChgSub: $('stat-chg-sub'),
    statNext: $('stat-next'),
    statNextSub: $('stat-next-sub'),
    fuelGrid: $('fuel-grid'),
    trendChart: $('trend-chart'),
    trendCap: $('trend-cap'),
    fuelSeg: $('fuel-seg'),
    trendNote: $('trend-note'),
    nationBody: $('nation-body'),
    tableNote: $('table-note'),
    fuelsNote: $('fuels-note'),
    sourceLine: $('source-line'),
    crudeSection: $('crude-section'),
    crudeGrid: $('crude-grid'),
    crudeNote: $('crude-note'),
  };

  /* ---------------- 工具 ---------------- */
  const fmt = (v, d = 2) => (typeof v === 'number' && !Number.isNaN(v) ? v.toFixed(d) : '--');
  const signed = (v) => {
    if (typeof v !== 'number' || Number.isNaN(v)) return '--';
    if (v > 0) return `+${v.toFixed(2)}`;
    if (v < 0) return v.toFixed(2);
    return '0.00';
  };
  const dirClass = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
  const dirArrow = (v) => (v > 0 ? '↑' : v < 0 ? '↓' : '→');
  const shortDate = (d) => {
    const [y, m, day] = d.split('-');
    return `${Number(m)}/${Number(day)}`;
  };
  const fullDate = (d) => {
    const [y, m, day] = d.split('-');
    return `${y} 年 ${Number(m)} 月 ${Number(day)} 日`;
  };

  /* ---------------- 偏好持久化 ---------------- */
  function readPrefs() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return {};
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }

  function writePrefs(patch) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...readPrefs(), ...patch }));
    } catch { /* 隐私模式或存储被禁用时忽略 */ }
  }

  /* ---------------- 数据加载 ---------------- */
  async function fetchJson(url, timeoutMs = 12000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`上游返回 HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function loadLive() {
    const payload = await fetchJson(API_URL);
    if (!payload || payload.returnCode !== 0 || !Array.isArray(payload.data)) {
      throw new Error('上游返回了预期之外的结构');
    }
    return payload.data;
  }

  async function loadSnapshot() {
    // 优先用 script 引入的快照（file:// 下也能用），否则回退到 fetch
    if (window.OIL_SNAPSHOT && Array.isArray(window.OIL_SNAPSHOT.rows)) {
      return window.OIL_SNAPSHOT.rows;
    }
    const payload = await fetchJson(SNAPSHOT_URL);
    if (!payload || !Array.isArray(payload.rows)) throw new Error('本地快照不可用');
    return payload.rows;
  }

  /* ---------------- 数据整形 ---------------- */
  function indexRows(rows) {
    const dates = [...new Set(rows.map((r) => r.date))].sort();
    const byRegion = new Map();
    for (const r of rows) {
      if (!byRegion.has(r.regionName)) byRegion.set(r.regionName, new Map());
      byRegion.get(r.regionName).set(r.date, r);
    }
    state.rows = rows;
    state.dates = dates;
    state.latestDate = dates[dates.length - 1] || null;
    state.byRegion = byRegion;

    // 归一化名 -> 数据里的原名
    state.regionByNorm = new Map();
    for (const name of byRegion.keys()) {
      state.regionByNorm.set(stripSuffix(name), name);
    }
  }

  /** 把「上海」「上海市」这类写法解析成数据里实际存在的地区名 */
  function resolveRegion(name) {
    if (!name) return null;
    if (state.byRegion.has(name)) return name;
    return state.regionByNorm.get(stripSuffix(name)) || null;
  }

  /** 最新一轮的各省数据 */
  function latestRows() {
    if (!state.latestDate) return [];
    const out = [];
    for (const [region, byDate] of state.byRegion) {
      const row = byDate.get(state.latestDate);
      if (row) out.push({ ...row, regionName: region });
    }
    return out;
  }

  /** 某省某油品的历史序列 */
  function historySeries(region, fuelKey) {
    const byDate = state.byRegion.get(region);
    if (!byDate) return [];
    return state.dates
      .map((d) => {
        const row = byDate.get(d);
        return row ? { date: d, value: row[fuelKey], change: row[fuelKey + 'Change'] } : null;
      })
      .filter((p) => p && typeof p.value === 'number');
  }

  /** 下一个调价窗口：按 10 个工作日推算，跳过周末 */
  function nextWindow(fromDate) {
    const d = new Date(`${fromDate}T00:00:00Z`);
    let added = 0;
    while (added < 10) {
      d.setUTCDate(d.getUTCDate() + 1);
      const wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6) added += 1;
    }
    return d.toISOString().slice(0, 10);
  }

  /* ---------------- 国际原油 ---------------- */
  /**
   * 腾讯财经行情接口，返回形如
   *   v_hf_CL="最新价,涨跌幅%,买价,卖价,最高,最低,时间,昨收,开盘,持仓,买量,卖量,日期,名称"
   * 注意第 1 个字段是「涨跌幅百分比」不是涨跌额，涨跌额要用 最新价 - 昨收 自己算。
   * 响应是 GBK 编码，res.text() 会按 UTF-8 解出乱码，所以走 arrayBuffer + TextDecoder('gbk')。
   */
  const CRUDE_CODES = [
    { code: 'hf_CL', label: 'WTI 原油', unit: '美元/桶' },
    { code: 'hf_OIL', label: '布伦特原油', unit: '美元/桶' },
  ];

  async function loadCrude() {
    const res = await fetch(`https://qt.gtimg.cn/q=${CRUDE_CODES.map((c) => c.code).join(',')}`, {
      headers: { Accept: 'text/plain, */*' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);
    const out = [];
    for (const { code, label, unit } of CRUDE_CODES) {
      const m = text.match(new RegExp(`v_${code}="([^"]*)"`));
      if (!m) continue;
      const f = m[1].split(',');
      const price = parseFloat(f[0]);
      const prevClose = parseFloat(f[7]);
      if (!Number.isFinite(price)) continue;
      const change = Number.isFinite(prevClose) ? price - prevClose : null;
      const changePct = parseFloat(f[1]);
      out.push({
        label,
        unit,
        price,
        change,
        // 接口给的就是百分比，直接用；缺失时用涨跌额反算
        changePct: Number.isFinite(changePct)
          ? changePct
          : (change != null && prevClose ? (change / prevClose) * 100 : null),
        date: f[12] || '',
        time: f[6] || '',
      });
    }
    return out;
  }

  function renderCrude(list) {
    if (!list || !list.length) {
      el.crudeSection.hidden = true;
      return;
    }
    el.crudeSection.hidden = false;
    el.crudeNote.textContent = '外盘期货连续合约，延时报价，仅作国际油价参考';

    const cards = list.map((c) => {
      const card = document.createElement('div');
      card.className = 'crude';

      const name = document.createElement('p');
      name.className = 'crude__name';
      name.textContent = c.label;
      card.appendChild(name);

      const price = document.createElement('p');
      price.className = 'crude__price num';
      price.textContent = fmt(c.price);
      const unit = document.createElement('small');
      unit.textContent = c.unit;
      price.appendChild(unit);
      card.appendChild(price);

      const meta = document.createElement('div');
      meta.className = 'crude__meta';
      const chg = document.createElement('span');
      chg.className = dirClass(c.change);
      chg.textContent = `${dirArrow(c.change)} ${signed(c.change)}`
        + (c.changePct == null ? '' : ` (${c.changePct >= 0 ? '+' : ''}${c.changePct.toFixed(2)}%)`);
      const when = document.createElement('span');
      when.textContent = c.date ? `${c.date} ${c.time}` : '';
      meta.append(chg, when);
      card.appendChild(meta);

      return card;
    });

    el.crudeGrid.replaceChildren(...cards);
  }

  /**
   * 下一个调价窗口。
   * 优先用金投网的 near_time 端点（data[0] 是上次调价日，data[1] 是下次生效日），
   * 它已经把法定假日的顺延算进去了；取不到再退回按 10 个工作日推算。
   */
  async function loadNextWindow() {
    try {
      const payload = await fetchJson('https://datacenter.cngold.org/city_oil/near_time/', 8000);
      const list = Array.isArray(payload?.data) ? payload.data : [];
      if (list.length >= 2 && list[1].date) {
        return { date: list[1].date, exact: true };
      }
    } catch { /* 退回推算 */ }
    return { date: state.latestDate ? nextWindow(state.latestDate) : null, exact: false };
  }

  /* ---------------- 渲染 ---------------- */
  function renderRegionOptions() {
    const regions = [...state.byRegion.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    el.regionSelect.replaceChildren();
    for (const r of regions) {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = r;
      if (r === state.region) opt.selected = true;
      el.regionSelect.appendChild(opt);
    }
  }

  /** 最新一轮是否全国搁浅（各省涨跌额都恰好是 0，说明调价幅度未达 50 元/吨门槛） */
  function isStalledRound(fuelKey = 'n92') {
    const rows = latestRows();
    return rows.length > 0 && rows.every((r) => r[fuelKey + 'Change'] === 0);
  }

  /** 最近一次「真的动了价格」的调价日，搁浅时用它补充说明 */
  function lastRealChange(region, fuelKey = 'n92') {
    const byDate = state.byRegion.get(region);
    if (!byDate) return null;
    for (let i = state.dates.length - 1; i >= 0; i -= 1) {
      const row = byDate.get(state.dates[i]);
      if (row && row[fuelKey + 'Change']) {
        return { date: state.dates[i], change: row[fuelKey + 'Change'] };
      }
    }
    return null;
  }

  function renderHero() {
    const byDate = state.byRegion.get(state.region);
    const row = byDate && byDate.get(state.latestDate);
    const rows = latestRows();
    const fuel = FUELS.find((f) => f.key === state.fuel) || FUELS[1];
    const price = row ? row[fuel.key] : null;
    const chgRaw = row ? row[fuel.key + 'Change'] : null;
    const stalled = isStalledRound(fuel.key);
    const avg = (key) => {
      const vals = rows.map((r) => r[key]).filter((v) => typeof v === 'number');
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };

    el.heroRegion.textContent = state.region;
    el.heroTitle.textContent = fuel.label;
    el.heroPrice.textContent = fmt(price);

    if (row && typeof chgRaw === 'number') {
      const c = chgRaw;
      el.heroDelta.className = `hero__delta ${dirClass(c)}`;
      if (c === 0) {
        // 发改委「不作调整」时涨跌额全是 0，补一句上次实际调价，避免信息空洞
        const last = lastRealChange(state.region, fuel.key);
        el.heroDelta.textContent = stalled
          ? `本轮全国搁浅，价格未变（生效日期 ${fullDate(state.latestDate)}）`
            + (last ? `，上次实际调价 ${shortDate(last.date)} ${dirArrow(last.change)} ${signed(last.change)} 元/升` : '')
          : `与上一轮持平（生效日期 ${fullDate(state.latestDate)}）`;
      } else {
        el.heroDelta.textContent = `${dirArrow(c)} 较上一轮 ${signed(c)} 元/升（生效日期 ${fullDate(state.latestDate)}）`;
      }
    } else {
      el.heroDelta.className = 'hero__delta';
      el.heroDelta.textContent = `生效日期 ${fullDate(state.latestDate || '')}`;
    }

    const a = avg(fuel.key);
    el.statAvg.textContent = a == null ? '--' : fmt(a);
    el.statAvgSub.textContent = `${rows.length} 省市算术平均`;

    const chg = chgRaw;
    el.statChg.textContent = chg == null ? '--' : signed(chg);
    el.statChg.className = `stat__v num ${chg == null ? 'flat' : dirClass(chg)}`;
    el.statChgSub.textContent = chg == null
      ? '较上一调价窗口'
      : chg === 0
        ? (stalled ? '本轮全国搁浅' : '本轮持平')
        : chg > 0 ? '本轮上调' : '本轮下调';

    const nxt = state.nextWindow;
    el.statNext.textContent = nxt ? shortDate(nxt.date) : '--';
    el.statNextSub.textContent = !nxt
      ? '按 10 个工作日推算'
      : nxt.exact
        ? `${fullDate(nxt.date)} 24 时生效`
        : `预计 ${fullDate(nxt.date)} 24 时（按 10 个工作日推算）`;
  }

  function renderFuels() {
    const byDate = state.byRegion.get(state.region);
    const row = byDate && byDate.get(state.latestDate);
    el.fuelsNote.textContent = row
      ? `${state.region}，${fullDate(state.latestDate)} 起执行，单位元/升`
      : `${state.region}，暂无数据`;

    const cards = FUELS.map((f) => {
      const price = row ? row[f.key] : null;
      const change = row ? row[f.key + 'Change'] : null;
      const prev = typeof price === 'number' && typeof change === 'number' ? price - change : null;
      const on = f.key === state.fuel;

      const card = document.createElement('button');
      card.type = 'button';
      card.className = `fuel${on ? ' is-on' : ''}`;
      card.dataset.fuel = f.key;
      card.setAttribute('aria-pressed', String(on));

      const head = document.createElement('div');
      head.className = 'fuel__head';
      const name = document.createElement('span');
      name.className = 'fuel__name';
      name.textContent = f.label;
      head.appendChild(name);
      if (f.key === 'n98') {
        const tag = document.createElement('span');
        tag.className = 'fuel__tag';
        tag.textContent = '市场调节价';
        head.appendChild(tag);
      }
      card.appendChild(head);

      const priceEl = document.createElement('p');
      priceEl.className = 'fuel__price num';
      priceEl.textContent = fmt(price);
      const unit = document.createElement('small');
      unit.textContent = '元/升';
      priceEl.appendChild(unit);
      card.appendChild(priceEl);

      const meta = document.createElement('div');
      meta.className = 'fuel__meta';
      const chg = document.createElement('span');
      chg.className = dirClass(change);
      chg.innerHTML = change == null ? '--' : `${dirArrow(change)} ${signed(change)}`;
      const prevEl = document.createElement('span');
      prevEl.textContent = prev == null ? '上轮 --' : `上轮 ${fmt(prev)}`;
      meta.append(chg, prevEl);
      card.appendChild(meta);

      return card;
    });

    el.fuelGrid.replaceChildren(...cards);
  }

  /** 切换当前展示的油品：主价格、统计、趋势图、表格涨跌列同步 */
  function selectFuel(key) {
    if (!FUELS.some((f) => f.key === key)) return;
    state.fuel = key;
    writePrefs({ fuel: key });
    renderFuelSeg();
    renderHero();
    renderFuels();
    renderTable();
    renderChart();
  }

  /** 渲染油品切换器 */
  function renderFuelSeg() {
    const buttons = FUELS.map((f) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `seg__btn${f.key === state.fuel ? ' is-on' : ''}`;
      btn.dataset.fuel = f.key;
      btn.textContent = f.short || f.label;
      btn.setAttribute('aria-pressed', String(f.key === state.fuel));
      return btn;
    });
    el.fuelSeg.replaceChildren(...buttons);
  }

  function renderTable() {
    const rows = latestRows();
    const tableFuel = FUELS.find((f) => f.key === state.fuel) || FUELS[1];
    const { key, dir } = state.sort;
    const sorted = [...rows].sort((a, b) => {
      if (key === 'name') {
        const r = a.regionName.localeCompare(b.regionName, 'zh-CN');
        return dir === 'asc' ? r : -r;
      }
      const av = typeof a[key] === 'number' ? a[key] : -Infinity;
      const bv = typeof b[key] === 'number' ? b[key] : -Infinity;
      return dir === 'asc' ? av - bv : bv - av;
    });

    const body = sorted.map((r) => {
      const tr = document.createElement('tr');
      if (r.regionName === state.region) tr.className = 'is-current';

      const th = document.createElement('td');
      th.className = 'ta-l';
      const wrap = document.createElement('span');
      wrap.className = 'cell-name';
      wrap.appendChild(document.createTextNode(r.regionName));
      if (r.regionName === state.region) {
        const tag = document.createElement('span');
        tag.className = 'cell-tag';
        tag.textContent = '当前';
        wrap.appendChild(tag);
      }
      th.appendChild(wrap);
      tr.appendChild(th);

      for (const key2 of ['n92', 'n95', 'n98', 'n0']) {
        const td = document.createElement('td');
        td.className = 'num';
        td.textContent = fmt(r[key2]);
        tr.appendChild(td);
      }

      const chgValue = r[tableFuel.key + 'Change'];
      const tdChg = document.createElement('td');
      tdChg.className = `num ${dirClass(chgValue)}`;
      tdChg.textContent = signed(chgValue);
      tr.appendChild(tdChg);

      return tr;
    });

    el.nationBody.replaceChildren(...body);
    el.tableNote.textContent = `${state.latestDate} 生效，单位元/升，点击表头排序`;
  }

  /* ---------------- 图表（内联 SVG，无第三方库） ---------------- */
  function renderChart() {
    const series = historySeries(state.region, state.fuel);
    const fuel = FUELS.find((f) => f.key === state.fuel) || FUELS[1];
    const host = el.trendChart;
    host.replaceChildren();

    if (series.length < 2) {
      const p = document.createElement('p');
      p.className = 'chart-figure__cap';
      p.textContent = '历史数据不足，无法绘制趋势。';
      host.appendChild(p);
      el.trendCap.textContent = `${state.region}，${fuel.label}`;
      return;
    }

    // viewBox 与容器实际像素 1:1，缩放时坐标轴文字不会被压小
    const W = Math.max(280, Math.round(host.clientWidth || 900));
    const H = W < 560 ? 230 : 300;
    const pad = { top: 16, right: 18, bottom: 30, left: 46 };
    const iw = W - pad.left - pad.right;
    const ih = H - pad.top - pad.bottom;

    const values = series.map((p) => p.value);
    let min = Math.min(...values);
    let max = Math.max(...values);
    const span = max - min || 1;
    min -= span * 0.18;
    max += span * 0.18;

    const x = (i) => pad.left + (iw * i) / (series.length - 1);
    const y = (v) => pad.top + ih - ((v - min) / (max - min)) * ih;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label',
      `${state.region} ${fuel.label} 自 ${series[0].date} 至 ${series[series.length - 1].date} 的历史调价趋势`);

    const ns = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs) => {
      const e = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      return e;
    };

    // 横向网格与 Y 轴刻度
    const ticks = 4;
    for (let i = 0; i <= ticks; i += 1) {
      const v = min + ((max - min) * i) / ticks;
      const yy = y(v);
      svg.appendChild(mk('line', {
        class: 'chart__grid', x1: pad.left, x2: W - pad.right, y1: yy, y2: yy,
      }));
      const label = mk('text', {
        class: 'chart__axis-label', x: pad.left - 8, y: yy + 4, 'text-anchor': 'end',
      });
      label.textContent = v.toFixed(2);
      svg.appendChild(label);
    }

    // 面积
    const areaPts = series.map((p, i) => `${x(i)},${y(p.value)}`);
    const area = mk('path', {
      class: 'chart__area',
      d: `M${pad.left},${pad.top + ih} L${areaPts.join(' L')} L${W - pad.right},${pad.top + ih} Z`,
    });
    svg.appendChild(area);

    // 折线
    const line = mk('path', {
      class: 'chart__line',
      d: `M${areaPts.join(' L')}`,
    });
    svg.appendChild(line);

    // X 轴标签（首、中、尾，避免拥挤）
    const idxs = series.length > 2
      ? [0, Math.floor((series.length - 1) / 2), series.length - 1]
      : [0, series.length - 1];
    for (const i of [...new Set(idxs)]) {
      const label = mk('text', {
        class: 'chart__axis-label', x: x(i), y: H - 10, 'text-anchor': 'middle',
      });
      label.textContent = shortDate(series[i].date);
      svg.appendChild(label);
    }

    // 数据点（密集时抽样）
    const step = series.length > 40 ? 4 : series.length > 22 ? 2 : 1;
    series.forEach((p, i) => {
      if (i % step !== 0 && i !== series.length - 1) return;
      svg.appendChild(mk('circle', { class: 'chart__dot', cx: x(i), cy: y(p.value), r: 3 }));
    });

    // 悬停层
    const hoverLine = mk('line', {
      class: 'chart__hover-line', y1: pad.top, y2: pad.top + ih, x1: 0, x2: 0, opacity: 0,
    });
    svg.appendChild(hoverLine);
    const hoverDot = mk('circle', { class: 'chart__dot', r: 4, cx: 0, cy: 0, opacity: 0 });
    svg.appendChild(hoverDot);

    const tip = document.createElement('div');
    tip.className = 'chart__tip';
    host.appendChild(tip);

    svg.addEventListener('pointermove', (ev) => {
      const box = svg.getBoundingClientRect();
      const px = ((ev.clientX - box.left) / box.width) * W;
      let idx = Math.round(((px - pad.left) / iw) * (series.length - 1));
      idx = Math.max(0, Math.min(series.length - 1, idx));
      const p = series[idx];
      const cx = x(idx);
      const cy = y(p.value);
      hoverLine.setAttribute('x1', cx);
      hoverLine.setAttribute('x2', cx);
      hoverLine.setAttribute('opacity', 1);
      hoverDot.setAttribute('cx', cx);
      hoverDot.setAttribute('cy', cy);
      hoverDot.setAttribute('opacity', 1);
      tip.innerHTML = `<b>${p.date}</b><br>${fuel.label} ${fmt(p.value)} 元/升`
        + (typeof p.change === 'number' ? `<br>涨跌 ${signed(p.change)}` : '');
      tip.style.left = `${(cx / W) * 100}%`;
      tip.style.top = `${(cy / H) * 100}%`;
      tip.classList.add('is-on');
    });
    svg.addEventListener('pointerleave', () => {
      hoverLine.setAttribute('opacity', 0);
      hoverDot.setAttribute('opacity', 0);
      tip.classList.remove('is-on');
    });

    host.appendChild(svg);

    const last = series[series.length - 1];
    const first = series[0];
    const diff = last.value - first.value;
    el.trendCap.textContent = `${state.region}，${fuel.label}，共 ${series.length} 次调价，`
      + `区间 ${fmt(first.value)} → ${fmt(last.value)} 元/升（${signed(diff)}）`;
  }

  function renderAll() {
    renderRegionOptions();
    renderFuelSeg();
    renderHero();
    renderFuels();
    renderTable();
    renderChart();
    el.sourceLine.textContent = state.offline
      ? '当前显示的是本地快照数据（data/snapshot.json），联网刷新后可获取最新一轮。'
      : `数据取自 ${state.sourceLabel}公开接口，共 ${state.rows.length} 条记录，`
        + `覆盖 ${state.dates.length} 个调价窗口（${state.dates[0]} 至 ${state.latestDate}）。`;
  }

  /* ---------------- 状态切换 ---------------- */
  function showState(name) {
    el.skeleton.hidden = name !== 'loading';
    el.errorPanel.hidden = name !== 'error';
    el.content.hidden = name !== 'ready';
  }

  function showError(message) {
    el.errorMessage.textContent = message;
    showState('error');
  }

  /* ---------------- 流程 ---------------- */
  async function boot(useSnapshotFallback = false) {
    el.refresh.classList.add('is-busy');
    showState('loading');

    let rows;
    try {
      rows = await loadLive();
      state.offline = false;
    } catch (err) {
      if (useSnapshotFallback) {
        try {
          rows = await loadSnapshot();
          state.offline = true;
        } catch (e2) {
          el.refresh.classList.remove('is-busy');
          showError(`实时接口不可用（${err.message}），本地快照也读取失败（${e2.message}）。`);
          return;
        }
      } else {
        el.refresh.classList.remove('is-busy');
        showError(`实时接口请求失败：${err.message}。可点「使用本地快照」离线查看最近一次抓取的数据。`);
        return;
      }
    }

    indexRows(rows);

    // 地区：URL 参数 > 上次看的 > 默认上海
    const params = new URLSearchParams(location.search);
    const prefs = readPrefs();
    const wanted = resolveRegion(params.get('region'));
    const remembered = resolveRegion(prefs.region);
    if (wanted) {
      state.region = wanted;
    } else if (remembered) {
      state.region = remembered;
    } else if (!state.byRegion.has(state.region)) {
      state.region = resolveRegion(DEFAULT_REGION)
        || [...state.byRegion.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'))[0];
    }

    // 油品：上次看的优先
    if (FUELS.some((f) => f.key === prefs.fuel)) {
      state.fuel = prefs.fuel;
    }

    state.nextWindow = await loadNextWindow();

    // 先显示再渲染：图表要按容器实际像素画，隐藏状态下 clientWidth 会是 0
    showState('ready');
    renderAll();
    lastChartWidth = Math.round(el.trendChart.clientWidth);
    el.refresh.classList.remove('is-busy');

    // 国际原油是补充信息，取不到就整块隐藏，不影响主内容
    loadCrude()
      .then(renderCrude)
      .catch(() => renderCrude([]));
  }

  /* ---------------- 事件绑定 ---------------- */
  el.regionSelect.addEventListener('change', (e) => {
    state.region = e.target.value;
    writePrefs({ region: state.region });
    renderAll();
  });

  // 图表按容器像素绘制，窗口尺寸变化后要重绘
  let resizeTimer = null;
  let lastChartWidth = 0;
  window.addEventListener('resize', () => {
    if (el.content.hidden) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const w = Math.round(el.trendChart.clientWidth);
      if (Math.abs(w - lastChartWidth) < 8) return;
      lastChartWidth = w;
      renderChart();
    }, 150);
  });

  el.refresh.addEventListener('click', () => boot(false));
  el.retry.addEventListener('click', () => boot(false));
  el.useSnapshot.addEventListener('click', () => boot(true));

  el.fuelGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.fuel');
    if (!card) return;
    selectFuel(card.dataset.fuel);
  });

  el.fuelSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg__btn');
    if (!btn) return;
    selectFuel(btn.dataset.fuel);
  });

  for (const btn of document.querySelectorAll('.th-sort')) {
    btn.addEventListener('click', () => {
      const key = btn.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort.key = key;
        state.sort.dir = key === 'name' ? 'asc' : 'desc';
      }
      for (const b of document.querySelectorAll('.th-sort')) {
        b.removeAttribute('aria-sort');
        if (b.dataset.sort === state.sort.key) {
          b.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending');
        }
      }
      renderTable();
    });
  }

  // 主题：auto -> light -> dark 循环，写入 localStorage
  const THEME_KEY = 'oil-board-theme';
  const applyTheme = (t) => {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch { /* 隐私模式忽略 */ }
  };
  let theme = 'auto';
  try { theme = localStorage.getItem(THEME_KEY) || 'auto'; } catch { /* ignore */ }
  applyTheme(theme);
  el.themeToggle.addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    theme = order[(order.indexOf(theme) + 1) % order.length];
    applyTheme(theme);
    el.themeToggle.setAttribute('title', `主题：${{ auto: '跟随系统', light: '亮色', dark: '暗色' }[theme]}`);
  });

  boot(false);
})();
