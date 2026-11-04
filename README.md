# 链动小铺商家增强工具

适用于链动小铺商家后台的 Tampermonkey / Violentmonkey 用户脚本。

## 功能

- 货源广场增强搜索：支持价格、排除 0 元、指定商家、保证金/实名风控、是否上架、库存、对接状态及“仅店内热销”筛选；提供成本区间与标题热词点击下钻、详情抽屉安全预览（含富文本说明与商家资质）、表头点击排序（成本/单品热度/店铺总销/保证金），并可单个或批量一键对接。
- 商品管理批量工具：按名称、类型、是否上架、分类、库存和排除 0 元筛选，条目展示上架状态、库存与销量，支持表头点击按销量或价格升/降序展示。
- 商品管理页提供货源广场快捷跳转按钮。
- 商品按销量或价格升序、降序展示。
- 批量修改商品分类、价格和上下架状态。
- 一键生成商品名称、库存、价格、链接的文字报表并复制；商品之间使用横线分隔，不产生多余空行。

## 安装

1. 安装 Tampermonkey 或 Violentmonkey。
2. 点击 [直装链接（Raw）](https://raw.githubusercontent.com/AsabaLazy/ldxp-merchant-toolkit/main/ldxp-merchant-toolkit.user.js)，或在仓库打开 [`ldxp-merchant-toolkit.user.js`](./ldxp-merchant-toolkit.user.js) 后点击 Raw 安装。
3. 登录链动小铺商家后台并刷新页面。

## 仓库地址

- [GitHub](https://github.com/AsabaLazy/ldxp-merchant-toolkit)

## 使用页面

- 货源广场：`https://wzyp.cn/merchant/my_parent/source_square`（兼容 `www.ldxp.cn`）
- 商品管理：`https://wzyp.cn/merchant/goods/list?is_proxy=1`（兼容 `www.ldxp.cn`）

批量修改会直接保存到店铺。首次使用建议只选择一个测试商品。

## 隐私与安全

脚本仅请求当前域名（`wzyp.cn` / `ldxp.cn`）的站内 `/merchantApi/` 与 `/shopApi/` 接口，不会向第三方发送登录令牌或商品数据。

## 许可证

[MIT](./LICENSE)
