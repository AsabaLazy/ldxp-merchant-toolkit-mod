# 链动小铺商家增强工具·改

面向链动小铺商家后台（`wzyp.cn` / `ldxp.cn`）的零依赖 Tampermonkey / Violentmonkey 增强脚本，聚焦货源选品风控、热度排序、商品说明安全预览与店铺商品批量运营。

## 核心特性

### 货源广场增强选品
- **多维筛选**：按关键词、结果内二次筛选词、指定供货商、排除 0 元引流项、价格区间、上架状态、库存、对接状态及“仅店内热销”过滤。
- **商家风控与热度排序**：支持按供货商保证金、实名认证状态筛选，支持点击表头或下拉框按成本、店铺总成交量、保证金、店内热销优先、单品热度或平台默认权重排序。
- **统计概览与点击下钻**：自动汇总商家数、有保商家数与成本均值区间，生成价格分段胶囊与标题高频热词胶囊，点击即可一键二次下钻。
- **详情抽屉与一键对接**：不离开当前页即可在右侧抽屉安全预览商品封面、售价/市场价/成本对比、商家资质（实名、保证金、省份、开店日期、QQ）与富文本说明，支持单个或批量一键对接。
- **防风控限速与会话缓存**：全局双层滑动窗口 + 随机抖动限流（单次间隔 800~1100ms、每分钟 ≤35 次、每 20 次自动休眠冷却，遇 520/444/429 触发 120 秒全局熔断锁，切换页面标签时自动避让宿主请求），已查询的店铺资质与热度持久缓存于当前会话。

### 商品管理批量工具
- **筛选与排序**：按商品名称、类型、是否上架、分类、库存和排除 0 元筛选，表格直观展示上架状态、库存与销量，支持点击表头按销量或价格升/降序排列。
- **批量编辑与报表**：支持批量修改商品分类、售价（统一价 / 按比例 / 加减额）和上下架状态，一键生成并复制精简文字报表，并提供货源广场快捷跳转按钮。

## 安装

1. 浏览器安装 Tampermonkey 或 Violentmonkey。
2. 点击 [直装链接（Raw）](https://raw.githubusercontent.com/AsabaLazy/ldxp-merchant-toolkit-mod/main/ldxp-merchant-toolkit.user.js)，或在仓库打开 [`ldxp-merchant-toolkit.user.js`](./ldxp-merchant-toolkit.user.js) 点击 Raw 安装。
3. 登录链动小铺商家后台并刷新页面。

## 适用页面

- 货源广场：`https://wzyp.cn/merchant/my_parent/source_square`（兼容 `ldxp.cn`）
- 商品管理：`https://wzyp.cn/merchant/goods/list?is_proxy=1`（兼容 `ldxp.cn`）

批量修改会直接保存到店铺，首次使用建议仅勾选 1 个测试商品验证效果。

## 隐私与安全

- 脚本零外部依赖，仅请求当前域名（`wzyp.cn` / `ldxp.cn`）同源的 `/merchantApi/` 与 `/shopApi/` 接口，且仅对 `/merchantApi/` 携带 `Merchant-Token`，绝不向第三方发送令牌或业务数据。
- 供货商富文本商品说明经浏览器原生 Sanitizer / DOM 白名单消毒后渲染，阻断脚本注入。

## 仓库与许可

- GitHub：[AsabaLazy/ldxp-merchant-toolkit-mod](https://github.com/AsabaLazy/ldxp-merchant-toolkit-mod)
- 许可证：[MIT](./LICENSE)
