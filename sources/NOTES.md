# 油价看板 · 公开数据源实测报告

> 实测环境：macOS / Node v26.12.0 / 实测时间 2026-10-22 09:25 ~ 09:45 (Asia/Shanghai)
> 约束：只用 node: 内置模块，零第三方依赖。

---

## 0. 一句话结论

| 需求 | 可用源 | 浏览器直连 | 服务端可用 |
|---|---|---|---|
| 全国各省 92/95/98/0# 价格 + 涨跌 + 日期 | **cngold `city_oil/all_price_by_year/`** | ✅ `ACAO: *` | ✅ |
| 下次调价窗口日期 | **cngold `city_oil/near_time/`** | ✅ `ACAO: *` | ✅ |
| 国际原油 WTI/Brent 实时 | **腾讯 `qt.gtimg.cn/q=hf_CL,hf_OIL`** | ✅ `ACAO: *` | ✅ |
| 国际原油 WTI/Brent 实时（带 showName/unit/digits） | jijinhao `quoteCenter/realTime.htm` | ❌ 防盗链 666 | ✅ |
| 国际原油日线历史 | jijinhao `sQuoteCenter/kDataList.htm` | ❌ 防盗链 666 | ✅ |
| 各省今日价交叉校验 | 小熊油耗 `/fprice/` | ❌ 无 CORS | ✅ |
| 调价公告权威口径 | 发改委 `/xwdt/xwfb/` | ❌ 无 CORS | ✅ |

**没有任何一个源需要注册 key / 登录态 / 验证码。**

---

## 1. 源 A（主源）：金投网 cngold 城市油价数据中心

### 1.1 请求命令原文

```bash
# 全国 31 省 × 45 个调价窗口的全量历史（一次返回，忽略分页参数）
curl -sS -L --max-time 25 \
  -H 'Accept: application/json, text/javascript, */*; q=0.01' \
  -H 'Referer: https://quote.cngold.org/oil/youjia.html' \
  -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' \
  'https://datacenter.cngold.org/city_oil/all_price_by_year/' \
  -o dc_all_price.json
```

### 1.2 响应样本（前 1.4KB，原文）

```json
{"returnCode":0,"message":"success!","data":[{"createdAt":null,"updatedAt":null,"creator":null,"modifier":null,"changeLog":null,"id":13083,"currentPage":1,"pageSize":30,"pageStart":0,"queryBeginTime":null,"queryEndTime":null,"orderBy":null,"queryKeyword":null,"fields":null,"version":null,"command":null,"regionId":441,"regionName":"青海省","date":"2026-10-16","n89":8.04,"n89Change":0.00,"n92":8.57,"n92Change":0.00,"n95":9.19,"n95Change":0.00,"n98":10.01,"n98Change":0.00,"n0":8.22,"n0Change":0.00,"n10":8.71,"n10Change":0.00,"n20":9.12,"n20Change":0.00,"n35":9.45,"n35Change":0.00,"time":1792116345000,"strids":null,"ids":null,"new":false},{"createdAt":null,...
```

响应体 838,479 字节，1395 条记录 = 31 省 × 45 个调价日（2025-01-03 → 2026-10-16）。

CORS 头（`OPTIONS` 预检 204）：

```
access-control-allow-origin: *
access-control-allow-methods: GET,POST,PUT,OPTIONS
access-control-allow-headers: Authorization,Origin,X-Requested-With,Cache-Control,Content-Type,...
```

### 1.3 字段映射

| 源字段 | 含义 | 看板字段 |
|---|---|---|
| `regionName` | 省份名（北京市 / 浙江省 / 内蒙古自治区 …） | `province` |
| `regionId` | 省份 id（浙江=12，北京=2，天津=3…） | `regionId` |
| `date` | **该价格的调价日（生效日）** | `updatedAt` / 数据日期 |
| `n89` / `n92` / `n95` / `n98` | 89/92/95/98 号汽油 元/升 | `p89` / `p92` / `p95` / `p98` |
| `n0` / `n10` / `n20` / `n35` | 0/-10/-20/-35 号柴油 元/升 | `p0` / `p10` / `p20` / `p35` |
| `n92Change` … | **该调价日的涨跌额**（元/升，负数=下调） | `change` |
| `time` | 该行写入时间戳（ms） | 辅助 |

### 1.4 ⚠️ 最大的坑：「不调价」也会写一行、涨跌全 0

`2026-10-16` 这一行，31 个省所有 `*Change` **全是 0**，价格和 `2026-09-25` 那一行一字不差。
原因：发改委 2026-10-15 发文《[2026年10月15日国内成品油价格不作调整](https://www.ndrc.gov.cn/xwdt/xwfb/202610/t20261015_1408170.html)》，窗口开着但不调价，cngold 就把日期往前滚了一天。

**后果**：如果直接取「最新一行」的 `n92Change`，页面上永远显示「涨跌 0.00」。
**正确做法**：
- 当前价 = 最新一行的 `n92`
- 涨跌额 = **最近一次 change ≠ 0 的那一行**的 `n92Change`
- 前值 = 那一行的前一条记录的 `n92`

`cngold-provinces.mjs` 已经按这个口径实现，输出 `lastAdjust: { date, chg, before }`。

验证：浙江 `lastAdjust.date=2026-09-25`，`chg.p92=0.32`，`before.p92=8.29` → 当前 8.58 = 8.29 + 0.32 ✓
与小熊油耗加油站成交价页的 `8.58` 一致（它的 prev 8.26 对应 cngold `2026-09-12` 那条，即再往前一轮）。

### 1.5 单省历史端点

```bash
curl -sS -L --max-time 25 -H 'Referer: https://quote.cngold.org/oil/youjia_p12.html' \
  -A 'Mozilla/5.0 ... Chrome/124.0 Safari/537.36' \
  'https://datacenter.cngold.org/city_oil/price_history/?regionId=12'
```

→ 265KB JSON，442 条，从 2012-11-09 到 2026-10-16（浙江）。**同样有 CORS `*`。**

### 1.6 下次调价窗口端点（省掉自己算 10 个工作日）

```bash
curl -sS -L --max-time 25 -H 'Referer: https://quote.cngold.org/oil/youjia.html' \
  -A 'Mozilla/5.0 ... Chrome/124.0 Safari/537.36' \
  'https://datacenter.cngold.org/city_oil/near_time/'
```

```json
{"returnCode":0,"message":"success!","data":[
 {"date":"2026-10-16","new":true,...},
 {"date":"2026-10-30","id":198,"createdAt":1766475639000,"new":false,...}
],"metadata":null}
```

- `data[0].date` = 最近一次调价窗口（**生效日**口径）= `2026-10-16`
- `data[1].date` = **下一个调价窗口（生效日）= `2026-10-30`**

> **日期口径提醒（重要）**
> 发改委公告日 = 生效日 − 1 天（公告写「自 X 月 X 日 24 时起」= 次日 0 点生效）。
> cngold 用的是**生效日**（2026-10-16），发改委公告日是 2026-10-15。
> 所以下一个窗口：生效日 **2026-10-30**，发改委公告会在 **2026-10-29（周四）**发。
> 小熊油耗页面上的「下次调价 10-30」也是生效日口径。三个口径实测一致。
> （有的渠道标的日期是 `2026年10月29日 24:00（周四）` —— 那是**公告日**，
>  换算成生效日同样是 10-30，不是矛盾。但如果页面上要显示「下次调价」，建议统一用 **10-30**。）

### 1.7 其它 city_oil 路径探测结果

`price_by_year/` `price_by_date/` `by_date/` `price_list/` `price/` `all_price/` `price_by_city/`
`tzsj/` `adjust/` `schedule/` `all/` `price_all/` `region/` `regions/` `now/` `current/`
`price_history/12/`（缺 `?regionId=`）`all_price_by_year/2025/`
→ **全部 404**。`all_price_by_year/`（全量）+ `price_history/?regionId=`（单省全量）+ `near_time/`（窗口日期）
就是 cngold 城市油价的**全部**可用端点。

---

## 2. 源 B（国际原油 · 浏览器可直连）：腾讯财经行情

### 2.1 请求命令原文

```bash
curl -sS -L --max-time 15 \
  -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' \
  'https://qt.gtimg.cn/q=hf_CL,hf_OIL'
```

### 2.2 响应样本（原文，GBK）

```
v_hf_CL="98.27,1.15,98.24,98.26,98.39,97.72,09:35:02,97.15,97.78,0,10,2,2026-10-22,纽约原油";
v_hf_OIL="110.25,1.31,110.22,110.25,110.47,109.81,09:34:46,108.82,110.04,0,3,3,2026-10-22,布伦特原油";
```

HTTP 头：

```
HTTP/2 200
content-type: text/html; charset=GBK
access-control-allow-origin: *
```

### 2.3 字段映射（腾讯外盘期货，已与 jijinhao 逐字段比对校准）

| 下标 | 含义 | WTI 实际值 |
|---|---|---|
| 0 | 最新价 | 98.27 |
| 1 | 涨跌幅（%） | 1.15 |
| 2 | 买价 | 98.24 |
| 3 | 卖价 | 98.26 |
| 4 | 最高价 | 98.39 |
| 5 | 最低价 | 97.72 |
| 6 | 时间 HH:mm:ss | 09:35:02 |
| 7 | 昨收盘 | 97.15 |
| 8 | 开盘价 | 97.78 |
| 9 | 持仓量 | 0 |
| 10 | 买量 | 10 |
| 11 | 卖量 | 2 |
| 12 | 日期 YYYY-MM-DD | 2026-10-22 |
| 13 | 品种名（GBK） | 纽约原油 |

- `hf_CL` = 纽约原油 WTI，`hf_OIL` = 布伦特原油 Brent
- 涨跌额自己算：`price - 昨收盘`（下标 1 是百分比，不是金额）
- 单位 美元/桶，2 位小数

### 2.4 浏览器直连注意事项

1. **必须用 `TextDecoder('gbk')`**。`Response.text()` 按 Fetch 规范**永远按 UTF-8 解码**，会忽略
   `Content-Type` 里的 `charset=GBK` → 中文名乱码。正确写法：
   ```js
   const buf = await (await fetch('https://qt.gtimg.cn/q=hf_CL,hf_OIL')).arrayBuffer();
   const text = new TextDecoder('gbk').decode(buf);
   ```
   数字字段全是 ASCII，即使乱码也不影响；中文名建议直接硬编码 `hf_CL→纽约原油 / hf_OIL→布伦特原油`。
2. **HeadlessChrome UA 不会被拦**。实测普通 Chrome UA / HeadlessChrome UA / curl UA 三种都是
   `HTTP 200 + access-control-allow-origin: *`，**没有 666**。腾讯这路没有 WAF 防盗链。
3. 不带 `Origin` 头请求时同样返回 `access-control-allow-origin: *`，服务端直连也行。

---

## 3. 源 C（国际原油 · 服务端专用）：金投网 jijinhao

### 3.1 请求命令原文

```bash
# 实时行情（JSON，自带 showName/unit/digits）
curl -sS -L --max-time 18 \
  -H 'Referer: https://quote.cngold.org/' \
  -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' \
  'https://api.jijinhao.com/quoteCenter/realTime.htm?codes=JO_92272,JO_108878'
```

```json
var quote_json = {"flag":true,"JO_92272":{"code":"JO_92272","time":1792633329000,"q64":108.82,"q193":1.0,"q1":110.04,"q2":110.02,"q3":110.47,"q4":109.81,"q5":110.16,"q6":110.18,"q70":0.14000702,"q7":3.0,"q8":2.0,"q9":0.0,"q60":3708.0,"q62":390597.0,"q63":110.16,"unit":"美元/桶","showName":"布伦特原油连续","showCode":"BOIL","digits":2,"status":100},"JO_108878":{...,"showName":"美原油连续","showCode":"NECLA0",...},"errorCode":...}
```

### 3.2 字段映射

| 字段 | 含义 |
|---|---|
| `showName` / `showCode` / `unit` / `digits` | 布伦特原油连续 / BOIL / 美元/桶 / 2　　（与 cngold 前端口径一致） |
| `q1` | 开盘价 |
| `q2` | 昨结算 |
| `q3` / `q4` | 最高价 / 最低价 |
| `q5` | 最新价 |
| `q6` | 卖价 |
| `q64` | 昨收盘 |
| `q70` | 涨跌额（元） |
| `q80` | 涨跌幅（%，源里已是百分数：0.1454 = 0.1454%） |
| `q60` / `q62` | 成交量 / 持仓量 |
| `time` | 行情时间（ms） |

代码字典：`JO_92272` = 布伦特原油连续，`JO_108878` = 纽约原油连续（WTI）。

### 3.3 ⚠️ 防盗链实测（决定性）

| Referer | 结果 |
|---|---|
| `https://quote.cngold.org/` | **200** + `access-control-allow-origin: *` |
| 不带 Referer | **HTTP 666** |
| `http://localhost:5173/` | **HTTP 666** |

⇒ 浏览器跨域 fetch 必然带自己站点的 Referer → 666。**这个源只能服务端用。**
（`kDataList.htm` 日线接口同样 666。）

### 3.4 日线历史

```bash
curl -sS -L --max-time 30 -H 'Referer: https://quote.cngold.org/' \
  -A 'Mozilla/5.0 ... Chrome/124.0.0.0 Safari/537.36' \
  'https://api.jijinhao.com/sQuoteCenter/kDataList.htm?code=JO_92272'
```

→ 972KB，`data[0]` = 日线 3250 根（2014-05-19 → 2026-10-22），`data[1]` = 月线 150 根，`data[2]` = 周线 655 根。
最后一根是**当日未收盘的进行中 K 线**（成交量很小），倒数第二根是上一交易日收盘。

| 品种 | 2026/10/21 收盘 | 2026/10/22 进行中 |
|---|---|---|
| 布伦特 JO_92272 | 109.92 | 110.03（open 110.04 / high 110.47 / low 109.81） |
| WTI JO_108878 | 97.71 | 98.15（open 97.78 / high 98.39 / low 97.72） |

`pageSize` 参数**无效**（加不加都是 972KB）。

---

## 4. 源 D：发改委官网（权威口径，但只有「公告」没有「结构化价格表」）

### 4.1 请求命令原文

```bash
# 新闻发布栏目列表页（公告标题即含 上调/下调/不作调整 + 日期）
curl -sS -L --max-time 20 -A 'Mozilla/5.0 ... Chrome/124.0 Safari/537.36' \
  'https://www.ndrc.gov.cn/xwdt/xwfb/index.html'

# 单篇公告
curl -sS -L --max-time 20 -A 'Mozilla/5.0 ... Chrome/124.0 Safari/537.36' \
  'https://www.ndrc.gov.cn/xwdt/xwfb/202610/t20261015_1408170.html'
```

### 4.2 响应样本（正文节选）

> 9月24日国内成品油价格调整以来，中东地缘局势复杂多变，国际市场原油价格短暂回落后又出现较大幅度上涨。根据国际市场油价变化情况，**本次汽、柴油价格不作调整**。……

> 9月11日国内成品油价格调整以来，……根据现行价格机制计算，**自9月24日24时起，国内汽、柴油（标准品）价格每吨分别应上调830元、800元，调控后实际上调395元、385元**。……
> 附：各省（区、市）和中心城市汽、柴油最高零售价格

### 4.3 能拿到 / 拿不到

| 想要 | 现实 |
|---|---|
| 调价公告标题 + 日期 + 方向（上调/下调/不作调整） | ✅ 列表页结构化 HTML，可正则抓 |
| 每吨调整幅度（汽/柴） | ✅ 正文正则 `汽、柴油…价格每吨分别应上调(\d+)元、(\d+)元` |
| 生效时间 | ✅ 正文 `自X月X日24时起`（生效日 = 公告日 + 1 天） |
| **各省最高零售价格** | ❌ **附件是一张 JPG 图片**（`W020260924535183752075.jpg`），要 OCR，不是结构化数据 |
| **下次调价窗口日期** | ❌ 发改委**从不预告**具体日期，只能按「10 个工作日」规则推算（且要处理国庆等假期顺延） |

### 4.4 发改委其它栏目实测

| URL | 结果 |
|---|---|
| `https://www.ndrc.gov.cn/xwdt/ztzl/gncpyjg/index.html`（国内成品油价格专题） | 200，但**列表停更在 2021-12-03**，已废弃 |
| `https://www.ndrc.gov.cn/xxgk/zcfb/tz/`（通知公告） | 200，**不含**成品油调价公告 |
| `https://www.ndrc.gov.cn/fggz/jggl/yjgl/` | 404 |
| `https://www.ndrc.gov.cn/fggz/jggl/` | 200 但只有 52 字节（空壳/跳转） |
| `https://so.ndrc.gov.cn/s?qt=成品油` | 200 但返回「不存在的站点」——站内搜索不可用 |

**结论：发改委适合当「权威口径校验源」（上调/下调/不作调整 + 每吨幅度），
不适合当价格数据源。下次调价窗口请直接用 cngold `near_time`。**

---

## 5. 源 E：小熊油耗（交叉校验源）

```bash
curl -sS -L --max-time 20 -A 'Mozilla/5.0 ... Chrome/124.0 Safari/537.36' \
  'https://www.xiaoxiongyouhao.com/fprice/'
```

- 205,111 字节，服务端渲染 HTML，`<title>2026年10月22日全国各省市今日油价查询｜…</title>`
- 表结构：`<table class="price-table">` → 31 行 × `省份 | 92# | 95# | 0#柴`
  （**没有 98#**，没有涨跌额）
- 页面带倒计时条：`上次调价：10-16 │ 还有 8 天 │ 下次调价：10-30`
- **没有 CORS 响应头**（`content-type: text/html` 而已）→ 浏览器跨域 fetch 会被拦，只能服务端抓
- **没有 JSON 接口**：省份表是服务端渲染进 HTML 的；单市历史页是
  `https://www.xiaoxiongyouhao.com/fprice/cityprice.php?city=北京市`
- 数据与 cngold **完全一致**（北京 92#=8.61 / 95#=9.17 / 0#=8.36 —— 与 cngold 的
  `{name:'北京',p92:8.61,p95:9.17,p98:10.67,p0:8.36}` 逐位吻合）

---

## 6. 源 F：小熊油耗 / IP 定位（IP 判省）

| URL | 实测 |
|---|---|
| `https://ipapi.co/json/` | **HTTP 403**，Cloudflare 挑战页（`Just a moment...`）→ 不可用 |
| `https://ipinfo.io/json` | **HTTP 200**，`access-control-allow-origin: *`，返回 `region`/`city`（上海）→ **可用** |

实测仍然有效，可用于按 IP 粗判省份。

---

## 7. 明确排除的源（诚实报告）

| 源 | 实测结果 | 原因 |
|---|---|---|
| `www.jinjiage.com` / `jinjiage.com` | DNS `SERVFAIL`，HTTP 000 | 整站本机不可达（DNS 层） |
| `api.oioweb.cn/api/common/OilPrice` | curl 报 SSL `self signed certificate` | 自签证书，Node 需关校验（不建议） |
| `api.jijinhao.com/*`（浏览器） | HTTP 666 | Referer 防盗链 |
| `api.oilpriceapi.com/v1/prices/latest` | HTTP 403 + Cloudflare 挑战 | 要 key + 反爬 |
| `api.marketdata.app/v1/stocks/quotes/CL:COM/` | HTTP 401 | 要 token（CORS 倒是 `*`） |
| `www.alphavantage.co/query?function=WTI` | 200 但 `apikey is invalid or missing` | 要注册 key |
| `stooq.com/q/l/?s=cl.f&e=csv` | HTTP 404 | stooq 已下线该 CSV 端点 |
| `stooq.com/q/d/l/?s=cl.f&i=d` | 200 但返回 JS 验证页 | 反爬 |
| `api.frankfurter.app/latest` | 200 + CORS `*` | **只有外汇，没有原油** |
| `finance.pae.baidu.com/...` | 403 `hit risk` | 风控 |
| `hq.sinajs.cn/list=hf_CL` | 200（需 `Referer: https://finance.sina.com.cn/`） | **无 CORS**，且防盗链 → 浏览器不可用（curl 可用） |
| `push2.eastmoney.com/api/qt/...` 外盘原油 | 200 + CORS `*` 但 `data:null` | secid 取不到外盘原油（试过 101.CL00Y / 102.OIL00Y / 101.CLmain 全 null） |
| `api.alphavantage.co` / `frankfurter` / `marketdata` | — | 见上，均需 key 或不含原油 |
| `web.ifzq.gtimg.cn/appstock/app/kline/mkline` | 301 → Cloudflare 挑战 | 反爬 |

---

## 8. 脚本清单

| 文件 | 作用 | 运行 |
|---|---|---|
| **`browser-snippet-crude.js`** | **浏览器端可直接粘贴**的国际原油 fetch（GBK 解码 + 字段映射已写好） | 复制进页面即可 |
| `cngold-provinces.mjs` | 全国 31 省价格 + 涨跌 + 调价窗口（含「不调价行」修正） | `node cngold-provinces.mjs --pretty` |
| `cngold-provinces.mjs --province=浙江省` | 单省 + 历史 | 同上 |
| `tencent-crude.mjs` | WTI/Brent 实时（**浏览器可直连**） | `node tencent-crude.mjs --pretty` |
| `crude-jijinhao.mjs` | WTI/Brent 实时 + 日线（服务端，带 showName/unit/digits） | `node crude-jijinhao.mjs --pretty` |
| `xiaoxiong-fprice.mjs` | 小熊油耗 HTML 解析 + 倒计时（交叉校验） | `node xiaoxiong-fprice.mjs --pretty` |
| `ndrc-notices.mjs` | 发改委调价公告 + 方向 + 每吨幅度 + 推算窗口 | `node ndrc-notices.mjs --pretty` |

统一输出结构：

```jsonc
{
  "ok": true,
  "source": "https://…",
  "updatedAt": "2026-10-16",
  "lastAdjustDate": "2026-10-16",
  "nextAdjustDate": "2026-10-30",
  "nextAdjustInDays": 8,
  "provinces": 31,
  "rows": [
    {
      "province": "浙江省", "regionId": 12,
      "p89": 7.95, "p92": 8.58, "p95": 9.12, "p98": 10.62,
      "p0": 8.28, "p10": 8.78, "p20": 0, "p35": 0,
      "change": { "p92": 0, "p95": 0, "p98": 0, "p0": 0 },
      "prev":  { "p92": 8.58, "p95": 9.12, "p98": 10.62, "p0": 8.28 },
      "lastAdjust": {
        "date": "2026-09-25",
        "chg":   { "p92": 0.32, "p95": 0.33, "p98": 0.33, "p0": 0.33 },
        "before":{ "p92": 8.29, "p95": 8.83, "p98": 10.33, "p0": 8.02 }
      },
      "unchanged": true
    }
  ]
}
```

国际原油（`tencent-crude.mjs`）：

```jsonc
{
  "ok": true,
  "source": "https://qt.gtimg.cn/q=hf_CL,hf_OIL",
  "updatedAt": "2026-10-22 09:35:02",
  "rows": [{
    "code": "hf_CL", "showName": "纽约原油(WTI)", "unit": "美元/桶", "digits": 2,
    "price": 98.27, "changePct": 1.15, "change": 1.12,
    "prevClose": 97.15, "open": 97.78, "high": 98.39, "low": 97.72,
    "bid": 98.24, "ask": 98.26, "time": "09:35:02", "date": "2026-10-22"
  }]
}
```

---

## 9. 刷新频率与稳定性

| 源 | 刷新频率 | 反爬 | Referer | CORS |
|---|---|---|---|---|
| cngold `all_price_by_year` | 每次调价（10 工作日一次）才变；调价当天 24 时后落库 | 无 | 不需要（有也行） | `*` |
| cngold `near_time` | 同上 | 无 | 不需要 | `*` |
| cngold `price_history` | 同上 | 无 | 不需要 | `*` |
| 腾讯 `qt.gtimg.cn` | **实时**（盘中 ~3~5 秒延迟） | 无 WAF，HeadlessChrome 也放行 | 不需要 | `*` |
| jijinhao `realTime` / `kDataList` | 实时 / 每日 | **有防盗链**（非 cngold Referer → 666） | **必须 `https://quote.cngold.org/`** | `*`（但 Referer 先拦） |
| 小熊油耗 `/fprice/` | 每日（写死在 HTML） | 无 | 不需要 | **无** |
| 发改委 `/xwdt/xwfb/` | 每次调价一篇 | 无 | 不需要 | 无 |
| `ipinfo.io/json` | 实时 | 无 | 不需要 | `*` |

**稳定性排序（做看板主源的建议）**

1. `cngold datacenter` —— 官方口径的结构化 JSON、CORS 开放、一次给全 45 个历史窗口，可做本地缓存，
   断网时回退到缓存。**唯一缺点**：只有「调价日」粒度，窗口内价格不变是正常的。
2. 腾讯 `qt.gtimg.cn` —— 实时原油，CORS 开放，无 Referer，无 key，最稳。
3. 小熊油耗 `/fprice/` —— 每日 HTML，可做**校验源**（和 cngold 对不上就告警），但要服务端抓。
4. 发改委 —— 只做**口径校验**（上调/下调/不作调整），不做数据源。

---

## 10. 抓取踩到的坑（汇总）

1. **「不调价」也会写一行且涨跌为 0**（cngold）→ 必须回溯到最近一次 `change≠0` 的行才拿得到真实涨跌额。
2. **公告日 ≠ 生效日**。发改委公告写「自 X 月 X 日 24 时起」= **次日 0 点**生效。
   cngold 的 `date` 用生效日，发改委公告日 = 生效日 − 1。
   下次窗口：生效日 **2026-10-30**，公告日 **2026-10-29**。
3. **自己按 10 个工作日推算会漏掉法定节假日顺延**。
   反例：2026-09-25 → 2026-10-15 这轮里跨了国庆（10/1~10/7），实际第 10 个工作日是 10/15。
   → 直接用 cngold `near_time`，别自己算。
   （另外：`new Date('2026-10-16T00:00:00+08:00')` + `getDate()` + `getUTCDay()` 这种混用会差一天，
   纯 UTC 运算才准。`ndrc-notices.mjs` 已按纯 UTC 实现，输出 2026-10-30，与 cngold 一致。）
4. **腾讯行情是 GBK**。`Response.text()` 一律按 UTF-8 解码 → 中文乱码；必须 `TextDecoder('gbk')`。
5. **`api.jijinhao.com` 的 Referer 必须是 `https://quote.cngold.org/`（精确匹配）**，
   带 `http://localhost:5173/` 或不带都是 666。
6. **`api.oioweb.cn` 是自签证书**，curl 默认报 SSL 错误。
7. **stooq 的 CSV 端点已下线**（404），且 `/q/d/l/` 返回 JS 验证页。
8. **`ipapi.co` 现在要 Cloudflare 挑战**（403），别再用；`ipinfo.io/json` 仍可用且 CORS `*`。
9. **cngold `all_price_by_year` 会忽略分页参数**，一次吐 838KB —— 建议浏览器端抓完缓存到
   localStorage / IndexedDB，不要每次刷新都拉。
10. **小熊油耗 `/fprice/` 表里没有 98#**，需要 98# 只能靠 cngold 或 cngold 单省历史。
