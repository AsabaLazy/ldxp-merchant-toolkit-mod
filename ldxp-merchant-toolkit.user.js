// ==UserScript==
// @name         链动小铺商家增强工具
// @namespace    https://www.ldxp.cn/
// @version      1.2.1
// @description  货源广场增强搜索、店铺销量/保证金风控、热词与价格下钻、详情预览与一键对接；商品管理支持销量排序、批量改价改分类及复制报表。
// @author       miku1130
// @license      MIT
// @homepageURL  https://github.com/miku1130/ldxp-merchant-toolkit
// @supportURL   https://github.com/miku1130/ldxp-merchant-toolkit/issues
// @match        https://wzyp.cn/merchant
// @match        https://wzyp.cn/merchant/*
// @match        https://*.wzyp.cn/merchant
// @match        https://*.wzyp.cn/merchant/*
// @match        https://ldxp.cn/merchant
// @match        https://ldxp.cn/merchant/*
// @match        https://*.ldxp.cn/merchant
// @match        https://*.ldxp.cn/merchant/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const APP_ID = "ldxp-merchant-toolkit";
  const STYLE_ID = `${APP_ID}-style`;
  const SOURCE_PATH = "/merchant/my_parent/source_square";
  const GOODS_PATH = "/merchant/goods/list";

  const API = {
    sourceSearch: "/merchantApi/MyParent/searchGoodsList",
    sourceConnect: "/merchantApi/MyParent/fetchConnectGoods",
    shopGoodsInfo: "/shopApi/Shop/goodsInfo",
    shopInfo: "/shopApi/Shop/info",
    goodsList: "/merchantApi/Goods/list",
    goodsInfo: "/merchantApi/Goods/info",
    goodsUpdate: "/merchantApi/Goods/update",
    goodsStatus: "/merchantApi/Goods/statusUpdate",
    categoryList: "/merchantApi/GoodsCategory/listAll",
    goodsLink: "/merchantApi/Goods/getLink",
  };

  const GOODS_TYPES = {
    card: "卡密",
    article: "知识",
    resource: "资源",
    equity: "权益",
  };

  const sourceState = {
    raw: [],
    filtered: [],
    selected: new Set(),
    salesById: new Map(),
    detailById: new Map(),
    shopBySupplier: new Map(),
    shopByToken: new Map(),
    enriching: false,
    loading: false,
  };

  const goodsState = {
    rawItems: [],
    items: [],
    selected: new Set(),
    categories: [],
    categoriesType: "",
    infoById: new Map(),
    loading: false,
    goodsType: "card",
  };

  const CACHE_STORAGE_KEY = `${APP_ID}-cache-v1`;
  let routeEpoch = 0;
  let cacheSaveTimer = 0;

  function loadSessionCache() {
    try {
      const raw = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(CACHE_STORAGE_KEY) : null;
      if (!raw) return;
      const parsed = JSON.parse(raw);
      Object.entries(parsed?.shops || {}).forEach(([token, s]) => {
        sourceState.shopByToken.set(token, {
          ...s,
          hotKeys: new Set(Array.isArray(s.hotKeys) ? s.hotKeys : []),
          hotIds: new Set(Array.isArray(s.hotIds) ? s.hotIds : []),
        });
      });
      Object.entries(parsed?.suppliers || {}).forEach(([supplierKey, token]) => {
        if (token && sourceState.shopByToken.has(token)) {
          sourceState.shopBySupplier.set(supplierKey, sourceState.shopByToken.get(token));
        }
      });
      Object.entries(parsed?.sales || {}).forEach(([id, val]) => {
        sourceState.salesById.set(id, val === null ? null : toNumber(val));
      });
      Object.entries(parsed?.goodsCat || {}).forEach(([id, categoryId]) => {
        goodsState.infoById.set(id, { id: Number(id) || id, category_id: categoryId });
      });
    } catch (_) {}
  }

  function scheduleSaveSessionCache() {
    if (typeof sessionStorage === "undefined") return;
    clearTimeout(cacheSaveTimer);
    cacheSaveTimer = setTimeout(() => {
      try {
        const shops = {};
        sourceState.shopByToken.forEach((val, token) => {
          if (!token) return;
          shops[token] = { ...val, hotKeys: [...val.hotKeys], hotIds: [...val.hotIds] };
        });
        const suppliers = {};
        sourceState.shopBySupplier.forEach((val, key) => {
          if (val?.token) suppliers[key] = val.token;
        });
        const sales = {};
        let salesCount = 0;
        sourceState.salesById.forEach((val, id) => {
          if (salesCount < 1500) {
            sales[id] = val;
            salesCount += 1;
          }
        });
        const goodsCat = {};
        let catCount = 0;
        goodsState.infoById.forEach((info, id) => {
          const cid = info?.category_id ?? info?.goods_category_id ?? info?.category?.id;
          if (cid !== undefined && catCount < 1500) {
            goodsCat[id] = cid;
            catCount += 1;
          }
        });
        sessionStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify({ shops, suppliers, sales, goodsCat }));
      } catch (_) {}
    }, 350);
  }

  function getToken() {
    try {
      const raw = localStorage.getItem("auth-token");
      if (!raw) return "";
      try {
        const parsed = JSON.parse(raw);
        return parsed?.value || parsed?.token || "";
      } catch (_) {
        return raw;
      }
    } catch (_) {
      return "";
    }
  }

  const TEST_FAST = typeof window !== "undefined" && Boolean(window.__LDXP_TEST_FAST__);
  const MAX_REQ_PER_SEC = 3;
  const MIN_GAP_MS = TEST_FAST ? 0 : 350;
  const WINDOW_MS = 1050;
  const HOST_QUIET_MS = TEST_FAST ? 0 : 700;
  const recentRequestTimes = [];
  let lastHostActivityAt = 0;
  let requestChain = Promise.resolve();

  function sleep(ms) {
    return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
  }

  function recordRequestTime(now = Date.now()) {
    recentRequestTimes.push(now);
    while (recentRequestTimes.length && now - recentRequestTimes[0] > WINDOW_MS) {
      recentRequestTimes.shift();
    }
  }

  function installHostTrafficObserver() {
    if (typeof XMLHttpRequest !== "undefined" && !XMLHttpRequest.prototype.__ldxpObserved) {
      const origSend = XMLHttpRequest.prototype.send;
      if (typeof origSend === "function") {
        XMLHttpRequest.prototype.__ldxpObserved = true;
        XMLHttpRequest.prototype.send = function (...args) {
          const now = Date.now();
          lastHostActivityAt = now;
          recordRequestTime(now);
          return origSend.apply(this, args);
        };
      }
    }
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) lastHostActivityAt = Date.now();
      });
    }
  }

  async function waitRequestSlot(shouldCancel, isBackground) {
    if (TEST_FAST) {
      if (shouldCancel?.()) return false;
      recordRequestTime();
      return true;
    }
    while (true) {
      if (shouldCancel?.()) return false;
      if (isBackground && typeof document !== "undefined" && document.hidden) {
        await sleep(350);
        continue;
      }
      const now = Date.now();
      while (recentRequestTimes.length && now - recentRequestTimes[0] > WINDOW_MS) {
        recentRequestTimes.shift();
      }
      const lastAny = recentRequestTimes.length ? recentRequestTimes[recentRequestTimes.length - 1] : 0;
      const gapWait = lastAny ? MIN_GAP_MS - (now - lastAny) : 0;
      const hostWait = isBackground && lastHostActivityAt ? HOST_QUIET_MS - (now - lastHostActivityAt) : 0;
      const windowWait = recentRequestTimes.length >= MAX_REQ_PER_SEC ? WINDOW_MS - (now - recentRequestTimes[0]) + 25 : 0;
      const wait = Math.max(gapWait, hostWait, windowWait);
      if (wait <= 0) {
        recordRequestTime(Date.now());
        return true;
      }
      await sleep(Math.min(wait, 200));
    }
  }

  function acquireRequestSlot(shouldCancel, isBackground = false) {
    const task = () => waitRequestSlot(shouldCancel, isBackground);
    const next = requestChain.then(task, task);
    requestChain = next.then(() => {}, () => {});
    return next;
  }

  async function postJson(url, body, options = {}) {
    const isMerchant = url.startsWith("/merchantApi/");
    if (!isMerchant && !url.startsWith("/shopApi/")) {
      throw new Error("已阻止非站内接口请求");
    }
    const allowed = await acquireRequestSlot(options.shouldCancel, Boolean(options.background));
    if (!allowed) {
      const cancelled = new Error("请求已取消");
      cancelled.cancelled = true;
      throw cancelled;
    }
    const token = isMerchant ? getToken() : "";
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/plain, */*",
        ...(token ? { "Merchant-Token": token } : {}),
      },
      body: JSON.stringify(body || {}),
    });
    recordRequestTime(Date.now());
    if (response.status === 520 || response.status === 429 || response.status === 503) {
      const err = new Error(`触发站点高频保护（HTTP ${response.status}），已自动停止后续请求；请等待几分钟或切换网络/节点后重试`);
      err.rateLimited = true;
      throw err;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (result.code !== 1) throw new Error(result.msg || "接口请求失败");
    return result.data;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function toNumber(value) {
    if (value === "" || value === null || value === undefined) return null;
    const number = Number(String(value).replace(/[^\d.-]/g, ""));
    return Number.isFinite(number) ? number : null;
  }

  function money(value) {
    const number = toNumber(value);
    return number === null ? "-" : `¥${number.toFixed(2)}`;
  }

  function listedState(item) {
    const value = item.is_listed ?? item.is_on_sale ?? item.is_on_shelf ?? item.on_sale ?? item.on_shelf ?? item.status;
    if (value === true || value === 1 || value === "1") return true;
    if (value === false || value === 0 || value === "0") return false;
    const normalized = String(value ?? "").trim().toLowerCase();
    if (["listed", "on_sale", "on_shelf", "sale", "selling", "active", "已上架", "上架", "销售中"].includes(normalized)) return true;
    if (["unlisted", "off_sale", "off_shelf", "warehouse", "inactive", "已下架", "下架", "仓库中"].includes(normalized)) return false;
    return null;
  }

  function listedLabel(item) {
    const state = listedState(item);
    if (state === true) return { text: "已上架", className: "ok" };
    if (state === false) return { text: "未上架", className: "warn" };
    return { text: "未知", className: "warn" };
  }

  function safeUrl(value) {
    if (!value || !String(value).trim()) return "#";
    try {
      const url = new URL(String(value), location.origin);
      if (url.protocol !== "https:" && url.protocol !== "http:") return "#";
      return url.href;
    } catch (_) {
      return "#";
    }
  }

  function notify(message, type = "info") {
    let toast = document.getElementById(`${APP_ID}-toast`);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = `${APP_ID}-toast`;
      document.body.appendChild(toast);
    }
    toast.className = `ldxp-toolkit-toast ${type}`;
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => {
      toast.hidden = true;
    }, 3500);
  }

  function setBusy(button, busy, text = "处理中...") {
    if (!(button instanceof HTMLButtonElement)) return;
    if (busy) {
      button.dataset.oldText = button.textContent || "";
      button.textContent = text;
      button.disabled = true;
    } else {
      button.textContent = button.dataset.oldText || button.textContent;
      button.disabled = false;
    }
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .ldxp-toolkit-launcher {
        position: fixed; right: 22px; bottom: 24px; z-index: 2147483646;
        height: 42px; padding: 0 18px; border: 0; border-radius: 22px;
        color: #fff; background: #165dff; box-shadow: 0 10px 28px rgba(22,93,255,.3);
        font-size: 14px; font-weight: 700; cursor: pointer;
      }
      .ldxp-toolkit-launcher.goto {
        bottom: 76px; background: #344054;
        box-shadow: 0 10px 28px rgba(52,64,84,.28);
      }
      .ldxp-toolkit-panel {
        position: fixed; top: 76px; right: 22px; z-index: 2147483647;
        width: min(1120px, calc(100vw - 44px)); height: min(760px, calc(100vh - 100px));
        min-height: min(420px, calc(100vh - 100px)); max-height: calc(100vh - 100px);
        display: flex; flex-direction: column; overflow: hidden; resize: both;
        color: #1d2939; background: #fff; border: 1px solid #d0d5dd; border-radius: 10px;
        box-shadow: 0 20px 60px rgba(15,23,42,.24); font: 14px/1.45 Arial,"Microsoft YaHei",sans-serif;
      }
      .ldxp-toolkit-panel[hidden] { display: none !important; }
      .ldxp-toolkit-panel > [data-panel-body] {
        flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
      }
      .ldxp-toolkit-head {
        display: flex; align-items: center; gap: 12px; padding: 12px 14px;
        flex: 0 0 auto; background: #f8fafc; border-bottom: 1px solid #eaecf0; user-select: none;
      }
      .ldxp-toolkit-title { font-size: 16px; font-weight: 700; white-space: nowrap; }
      .ldxp-toolkit-contact { color: #475467; font-size: 12px; white-space: nowrap; }
      .ldxp-toolkit-contact strong { color: #165dff; }
      .ldxp-toolkit-status { flex: 1; min-width: 0; color: #667085; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ldxp-toolkit-controls {
        display: grid; grid-template-columns: repeat(6,minmax(125px,1fr)); gap: 10px;
        flex: 0 0 auto; max-height: 38vh; overflow-y: auto;
        padding: 12px 14px; border-bottom: 1px solid #eaecf0;
      }
      .ldxp-toolkit-controls label { display: flex; flex-direction: column; gap: 4px; color: #667085; font-size: 12px; }
      .ldxp-toolkit-controls input, .ldxp-toolkit-controls select, .ldxp-toolkit-report textarea {
        box-sizing: border-box; width: 100%; min-height: 34px; padding: 6px 9px;
        color: #1d2939; background: #fff; border: 1px solid #d0d5dd; border-radius: 6px; outline: none;
      }
      .ldxp-toolkit-actions { display: flex; align-items: end; gap: 8px; flex-wrap: wrap; }
      .ldxp-toolkit-actions.span-3 { grid-column: span 3; }
      .ldxp-toolkit-panel button {
        min-height: 32px; padding: 0 12px; color: #344054; background: #fff;
        border: 1px solid #d0d5dd; border-radius: 6px; cursor: pointer;
      }
      .ldxp-toolkit-panel button.mini { min-height: 26px; padding: 0 8px; font-size: 12px; }
      .ldxp-toolkit-panel button.primary { color: #fff; border-color: #165dff; background: #165dff; }
      .ldxp-toolkit-panel button.success { color: #fff; border-color: #079455; background: #079455; }
      .ldxp-toolkit-panel button.danger { color: #b42318; border-color: #fda29b; background: #fff; }
      .ldxp-toolkit-panel button:disabled { opacity: .55; cursor: not-allowed; }
      .ldxp-toolkit-summary {
        display: flex; flex-direction: column; gap: 6px; flex: 0 0 auto;
        padding: 8px 14px; background: #f8fafc; border-bottom: 1px solid #eaecf0; font-size: 12px; color: #475467;
      }
      .ldxp-toolkit-summary[hidden] { display: none !important; }
      .ldxp-toolkit-summary-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .ldxp-toolkit-chip {
        display: inline-flex; align-items: center; gap: 4px; min-height: 24px; padding: 0 9px;
        font-size: 12px; color: #344054; background: #fff; border: 1px solid #d0d5dd; border-radius: 999px; cursor: pointer;
      }
      .ldxp-toolkit-chip.active, .ldxp-toolkit-chip:hover { color: #165dff; border-color: #165dff; background: #eff4ff; }
      .ldxp-toolkit-table-wrap { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
      .ldxp-toolkit-table { width: 100%; min-width: 980px; border-collapse: collapse; }
      .ldxp-toolkit-table th, .ldxp-toolkit-table td { padding: 9px 8px; border-bottom: 1px solid #eaecf0; text-align: left; vertical-align: top; }
      .ldxp-toolkit-table th { position: sticky; top: 0; z-index: 1; color: #667085; background: #f8fafc; font-size: 12px; user-select: none; }
      .ldxp-toolkit-table th.sortable { cursor: pointer; white-space: nowrap; }
      .ldxp-toolkit-table th.sortable:hover { color: #165dff; }
      .ldxp-toolkit-table a { color: #165dff; text-decoration: none; }
      .ldxp-toolkit-table .name { min-width: 240px; max-width: 400px; word-break: break-word; }
      .ldxp-toolkit-op-row { display: flex; gap: 6px; white-space: nowrap; }
      .ldxp-toolkit-muted { color: #98a2b3; }
      .ldxp-toolkit-sub { margin-top: 3px; font-size: 12px; color: #667085; display: flex; gap: 4px; flex-wrap: wrap; }
      .ldxp-toolkit-badge { display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 12px; white-space: nowrap; }
      .ldxp-toolkit-badge.ok { color: #067647; background: #ecfdf3; }
      .ldxp-toolkit-badge.warn { color: #b54708; background: #fffaeb; }
      .ldxp-toolkit-badge.hot { color: #c4320a; background: #fff6ed; margin-left: 6px; }
      .ldxp-toolkit-badge.info { color: #175cd3; background: #eff8ff; }
      .ldxp-toolkit-empty { padding: 36px; color: #667085; text-align: center; }
      .ldxp-toolkit-footer { display: flex; flex: 0 0 auto; align-items: center; gap: 8px; padding: 10px 14px; background: #fff; border-top: 1px solid #eaecf0; }
      .ldxp-toolkit-footer .spacer { flex: 1; }
      .ldxp-toolkit-drawer {
        margin: 0 0 0 auto; padding: 0; width: min(540px, 92vw); height: 100dvh; max-height: 100dvh;
        border: 0; border-left: 1px solid #d0d5dd; background: #fff; color: #1d2939;
        box-shadow: -12px 0 36px rgba(15,23,42,.22); font: 14px/1.55 Arial,"Microsoft YaHei",sans-serif;
      }
      .ldxp-toolkit-drawer[open] { display: flex; flex-direction: column; }
      .ldxp-toolkit-drawer:modal { overscroll-behavior: contain; }
      .ldxp-toolkit-drawer::backdrop { background: rgba(15,23,42,.38); overflow: hidden; overscroll-behavior: contain; }
      .ldxp-toolkit-drawer-head {
        display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 12px 16px; background: #f8fafc; border-bottom: 1px solid #eaecf0;
      }
      .ldxp-toolkit-drawer-head h2 { margin: 0; font-size: 15px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ldxp-toolkit-drawer-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; overscroll-behavior: contain; }
      .ldxp-toolkit-drawer-cover { max-width: 200px; max-height: 200px; border-radius: 8px; border: 1px solid #eaecf0; margin-bottom: 12px; display: block; }
      .ldxp-toolkit-drawer-kv { display: grid; grid-template-columns: 88px 1fr; gap: 6px 12px; margin-bottom: 14px; font-size: 13px; }
      .ldxp-toolkit-drawer-kv .k { color: #667085; }
      .ldxp-toolkit-drawer-desc { padding: 12px; background: #f8fafc; border: 1px solid #eaecf0; border-radius: 8px; word-break: break-word; }
      .ldxp-toolkit-drawer-desc img { max-width: 100%; height: auto; border-radius: 6px; }
      .ldxp-toolkit-drawer-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px; border-top: 1px solid #eaecf0; background: #fff; }
      .ldxp-toolkit-drawer button { min-height: 32px; padding: 0 12px; color: #344054; background: #fff; border: 1px solid #d0d5dd; border-radius: 6px; cursor: pointer; }
      .ldxp-toolkit-drawer button.success { color: #fff; border-color: #079455; background: #079455; }
      .ldxp-toolkit-report { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; background: rgba(15,23,42,.4); }
      .ldxp-toolkit-report[hidden] { display: none; }
      .ldxp-toolkit-report-box { width: min(720px,calc(100vw - 40px)); padding: 16px; background: #fff; border-radius: 10px; box-shadow: 0 20px 60px rgba(15,23,42,.3); }
      .ldxp-toolkit-report textarea { height: min(60vh,520px); margin: 12px 0; resize: vertical; font: 13px/1.65 Consolas,"Microsoft YaHei",monospace; }
      .ldxp-toolkit-report-actions { display: flex; justify-content: flex-end; gap: 8px; }
      .ldxp-toolkit-toast { position: fixed; left: 50%; top: 26px; transform: translateX(-50%); z-index: 2147483647; padding: 10px 16px; color: #fff; background: #344054; border-radius: 7px; box-shadow: 0 8px 24px rgba(15,23,42,.22); }
      .ldxp-toolkit-toast.success { background: #067647; }
      .ldxp-toolkit-toast.error { background: #b42318; }
      @media (max-width: 1000px) { .ldxp-toolkit-controls { grid-template-columns: repeat(3,minmax(125px,1fr)); } }
    `;
    document.head.appendChild(style);
  }

  function createLauncher(text, onClick) {
    const button = document.createElement("button");
    button.className = "ldxp-toolkit-launcher";
    button.textContent = text;
    button.addEventListener("click", onClick);
    document.body.appendChild(button);
    return button;
  }

  function createPanel(title) {
    const panel = document.createElement("section");
    panel.className = "ldxp-toolkit-panel";
    panel.innerHTML = `
      <div class="ldxp-toolkit-head">
        <div class="ldxp-toolkit-title">${escapeHtml(title)}</div>
        <div class="ldxp-toolkit-contact">QQ交流群：<strong>1076144676</strong></div>
        <div class="ldxp-toolkit-status">准备就绪</div>
        <button type="button" data-close>关闭</button>
      </div>
      <div data-panel-body></div>
    `;
    panel.querySelector("[data-close]").addEventListener("click", () => {
      panel.hidden = true;
    });
    document.body.appendChild(panel);
    return panel;
  }

  function setPanelStatus(panel, message) {
    const status = panel.querySelector(".ldxp-toolkit-status");
    if (status) status.textContent = message;
  }

  function getSourceCost(item) {
    const candidates = [item.cost_price, item.agent_price_limit, item.agent_price1, item.agent_price2, item.agent_price3]
      .map(toNumber)
      .filter((value) => value !== null && value >= 0);
    return candidates.length ? candidates[0] : null;
  }

  function getSourceStock(item) {
    if (item.goods_type !== "card") return null;
    return toNumber(item.stock_count ?? item.extend?.stock_count);
  }

  function extractGoodsKey(item) {
    if (item.goods_key) return String(item.goods_key).trim();
    const match = String(item.link || "").match(/\/item\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function extractShopToken(user) {
    if (!user) return "";
    if (user.token) return String(user.token).trim();
    const match = String(user.link || "").match(/\/shop\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function getSupplierKey(item) {
    const user = item.user;
    const token = extractShopToken(user);
    if (token) return `token:${token}`;
    const id = user?.id ?? item.user_id ?? user?.agent_key;
    if (id !== undefined && id !== null && id !== "") return `id:${id}`;
    const composite = [user?.nickname, user?.contact_qq, user?.contact_wechat, user?.avatar].filter(Boolean).join("|");
    return composite ? `u:${composite}` : "";
  }

  function getSourceShopInfo(item) {
    if (item._shopToken && sourceState.shopByToken.has(item._shopToken)) {
      return sourceState.shopByToken.get(item._shopToken);
    }
    const key = getSupplierKey(item);
    return key ? sourceState.shopBySupplier.get(key) || null : null;
  }

  function getSourceShopSales(item) {
    const direct = toNumber(item.user?.sell_count ?? item.shop_sell_count);
    if (direct !== null) return direct;
    return getSourceShopInfo(item)?.sellCount ?? null;
  }

  function getSourceShopDeposit(item) {
    const direct = toNumber(item.user?.deposit_money ?? item.deposit_money);
    if (direct !== null) return direct;
    return getSourceShopInfo(item)?.depositMoney ?? null;
  }

  function isSourceShopAuthed(item) {
    const direct = item.user?.auth_status;
    if (direct !== undefined && direct !== null) return Number(direct) === 2;
    return getSourceShopInfo(item)?.authStatus === 2;
  }

  function formatShopDate(raw) {
    if (!raw) return "";
    if (/^\d{9,13}$/.test(String(raw).trim())) {
      const ms = String(raw).trim().length <= 10 ? Number(raw) * 1000 : Number(raw);
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    return String(raw).slice(0, 10);
  }

  function sortMark(currentSort, ascValue, descValue) {
    if (currentSort === ascValue) return " ↑";
    if (currentSort === descValue) return " ↓";
    return " ⇅";
  }

  const SAFE_HTML_TAGS = [
    "p", "br", "div", "span", "b", "strong", "i", "em", "u", "s",
    "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
    "blockquote", "pre", "code", "table", "thead", "tbody", "tr", "th", "td", "hr", "img", "a",
  ];
  const SAFE_HTML_ATTRS = ["href", "src", "alt", "title"];

  function renderSafeHtml(container, html) {
    const raw = String(html || "").trim();
    if (!raw) {
      container.textContent = "暂无商品描述";
      return;
    }
    if (typeof Element !== "undefined" && "setHTML" in Element.prototype) {
      container.setHTML(raw, { sanitizer: { elements: SAFE_HTML_TAGS, attributes: SAFE_HTML_ATTRS } });
    } else if (typeof DOMParser !== "undefined") {
      const allowed = new Set(SAFE_HTML_TAGS);
      const sanitizeNode = (node) => {
        if (node.nodeType === 3) return document.createTextNode(node.textContent || "");
        if (node.nodeType !== 1) return null;
        const tag = node.tagName.toLowerCase();
        if (["script", "style", "iframe", "object", "embed", "svg", "math", "template", "noscript"].includes(tag)) return null;
        const target = allowed.has(tag) ? document.createElement(tag) : document.createDocumentFragment();
        if (target.nodeType === 1) {
          if (tag === "a") {
            const href = safeUrl(node.getAttribute("href"));
            if (href !== "#") {
              target.setAttribute("href", href);
              target.setAttribute("target", "_blank");
              target.setAttribute("rel", "noopener noreferrer");
            }
          } else if (tag === "img") {
            const src = safeUrl(node.getAttribute("src"));
            if (src !== "#") target.setAttribute("src", src);
            if (node.getAttribute("alt")) target.setAttribute("alt", node.getAttribute("alt"));
          }
        }
        Array.from(node.childNodes).forEach((child) => {
          const clean = sanitizeNode(child);
          if (clean) target.appendChild(clean);
        });
        return target;
      };
      const parsed = new DOMParser().parseFromString(raw, "text/html");
      container.textContent = "";
      Array.from(parsed.body.childNodes).forEach((child) => {
        const clean = sanitizeNode(child);
        if (clean) container.appendChild(clean);
      });
    } else {
      container.textContent = raw.replace(/<[^>]+>/g, " ");
    }
    container.querySelectorAll?.("a").forEach((a) => {
      const href = safeUrl(a.getAttribute("href"));
      if (href === "#") a.removeAttribute("href");
      else {
        a.setAttribute("href", href);
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      }
    });
    container.querySelectorAll?.("img").forEach((img) => {
      const src = safeUrl(img.getAttribute("src"));
      if (src === "#") img.remove();
      else img.setAttribute("src", src);
    });
  }

  function enableDialogLightDismiss(dialog) {
    if (typeof HTMLDialogElement === "undefined" || "closedBy" in HTMLDialogElement.prototype) return;
    const outside = (e) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    dialog.addEventListener("pointerdown", (e) => {
      pressedOutside = outside(e);
    });
    dialog.addEventListener("pointerup", (e) => {
      if (pressedOutside && outside(e)) dialog.close();
    });
  }

  function isSourceItemHot(item) {
    if (item.is_hot === 1 || item.is_hot === true) return true;
    const shop = getSourceShopInfo(item);
    if (!shop) return false;
    const goodsKey = extractGoodsKey(item);
    if (goodsKey && shop.hotKeys.has(goodsKey)) return true;
    if (item.id !== undefined && shop.hotIds.has(String(item.id))) return true;
    return false;
  }

  function compareNullableNumbers(a, b, desc) {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return desc ? b - a : a - b;
  }

  function getItemSales(item, cacheMap) {
    const direct = toNumber(item.sell_count ?? item.buyer_count ?? item.sale_count ?? item.sold_count);
    if (direct !== null) return direct;
    if (cacheMap && cacheMap.has(String(item.id))) return cacheMap.get(String(item.id));
    return null;
  }

  function sourceMatches(item, filters) {
    const price = getSourceCost(item);
    const stock = getSourceStock(item);
    const minPrice = toNumber(filters.minPrice);
    const maxPrice = toNumber(filters.maxPrice);
    if (filters.excludeZero === "yes" && (price === null || price <= 0)) return false;
    if (minPrice !== null && (price === null || price < minPrice)) return false;
    if (maxPrice !== null && (price === null || price > maxPrice)) return false;
    if (filters.subKeyword && !String(item.name || "").toLowerCase().includes(filters.subKeyword.toLowerCase())) return false;
    if (filters.supplier && getSupplierKey(item) !== filters.supplier) return false;
    if (filters.stock === "in" && (stock === null || stock <= 0)) return false;
    if (filters.stock === "out" && (stock === null || stock > 0)) return false;
    if (filters.listed === "yes" && listedState(item) !== true) return false;
    if (filters.listed === "no" && listedState(item) !== false) return false;
    if (filters.connect === "yes" && !item.child) return false;
    if (filters.connect === "no" && item.child) return false;
    return true;
  }

  function sourceMatchesPostShop(item, filters) {
    if (filters.hot === "hot" && !isSourceItemHot(item)) return false;
    if (filters.deposit === "yes" && (getSourceShopDeposit(item) ?? 0) <= 0) return false;
    if (filters.deposit === "auth" && !isSourceShopAuthed(item)) return false;
    if (filters.deposit === "both" && ((getSourceShopDeposit(item) ?? 0) <= 0 || !isSourceShopAuthed(item))) return false;
    return true;
  }

  function createSourceDetailDrawer(onConnect) {
    const drawer = document.createElement("dialog");
    drawer.className = "ldxp-toolkit-drawer";
    drawer.setAttribute("closedby", "any");
    drawer.setAttribute("aria-labelledby", `${APP_ID}-drawer-title`);
    drawer.innerHTML = `
      <div class="ldxp-toolkit-drawer-head">
        <h2 id="${APP_ID}-drawer-title" data-drawer-title>商品详情预览</h2>
        <form method="dialog"><button type="submit" autofocus>关闭</button></form>
      </div>
      <div class="ldxp-toolkit-drawer-body">
        <div data-drawer-meta></div>
        <div class="ldxp-toolkit-drawer-desc" data-drawer-desc></div>
      </div>
      <div class="ldxp-toolkit-drawer-foot">
        <a data-drawer-open-link target="_blank" rel="noopener noreferrer" style="align-self:center;margin-right:auto;color:#165dff;text-decoration:none;font-size:13px">打开原站商品页 ↗</a>
        <button type="button" class="success" data-drawer-connect>一键对接</button>
      </div>
    `;
    let currentItemId = "";
    drawer.querySelector("[data-drawer-connect]").addEventListener("click", (event) => {
      if (currentItemId) onConnect(currentItemId, event.currentTarget);
    });
    drawer.addEventListener("close", () => {
      drawer.returnValue = "";
    });
    enableDialogLightDismiss(drawer);
    document.body.appendChild(drawer);
    return {
      drawer,
      setItemId(id) {
        currentItemId = String(id || "");
      },
    };
  }

  function mountSourceTool() {
    const panel = createPanel("货源广场增强搜索");
    const detailRef = createSourceDetailDrawer((id, btn) => connectSourceItems([id], btn));
    const body = panel.querySelector("[data-panel-body]");
    body.innerHTML = `
      <div class="ldxp-toolkit-controls">
        <label>关键词<input data-source="keywords" placeholder="商品名称关键词"></label>
        <label>商品类型<select data-source="goodsType">${Object.entries(GOODS_TYPES).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
        <label>拉取页数<input data-source="maxPages" type="number" min="1" max="50" value="2"></label>
        <label>最低成本<input data-source="minPrice" type="number" min="0" step="0.01" placeholder="不限"></label>
        <label>最高成本<input data-source="maxPrice" type="number" min="0" step="0.01" placeholder="不限"></label>
        <label>默认加价比例（%）<input data-source="addRate" type="number" min="0" step="0.1" value="10"></label>
        <label>结果内筛选词<input data-source="subKeyword" placeholder="二次筛选/点下方热词"></label>
        <label>指定商家<select data-source="supplier"><option value="">全部商家</option></select></label>
        <label>商家风控<select data-source="deposit"><option value="all">全部商家</option><option value="yes">有保证金（>0元）</option><option value="auth">已实名认证</option><option value="both">有保证金且已认证</option></select></label>
        <label>库存<select data-source="stock"><option value="all">全部</option><option value="in">有库存</option><option value="out">缺货</option></select></label>
        <label>是否上架<select data-source="listed"><option value="all">全部</option><option value="yes">已上架</option><option value="no">未上架</option></select></label>
        <label>对接状态<select data-source="connect"><option value="all">全部</option><option value="no">未对接</option><option value="yes">已对接</option></select></label>
        <label>热销筛选<select data-source="hot"><option value="all">全部</option><option value="hot">仅店内热销</option></select></label>
        <label>排除0元<select data-source="excludeZero"><option value="no">保留全部</option><option value="yes">排除0元引流项</option></select></label>
        <label>排序方式<select data-source="sort"><option value="cost_asc" selected>成本从低到高</option><option value="cost_desc">成本从高到低</option><option value="shop_sales_desc">店铺总销从高到低</option><option value="shop_sales_asc">店铺总销从低到高</option><option value="deposit_desc">保证金从高到低</option><option value="deposit_asc">保证金从低到高</option><option value="hot_first">店内热销优先</option><option value="sales_desc">单品热度从高到低</option><option value="sales_asc">单品热度从低到高</option><option value="default">默认热度（平台排序）</option></select></label>
        <div class="ldxp-toolkit-actions span-3">
          <button type="button" class="primary" data-source-action="search">增强搜索</button>
          <button type="button" data-source-action="enrich-shops">加载店铺/热销</button>
          <button type="button" data-source-action="filter">应用筛选</button>
          <button type="button" data-source-action="reset">重置筛选</button>
        </div>
      </div>
      <div class="ldxp-toolkit-summary" data-source-summary hidden></div>
      <div class="ldxp-toolkit-table-wrap" data-source-results><div class="ldxp-toolkit-empty">输入关键词后点击“增强搜索”</div></div>
      <div class="ldxp-toolkit-footer">
        <label><input type="checkbox" data-source-select-all> 全选当前结果</label>
        <span data-source-count>已选 0 项</span>
        <span class="spacer"></span>
        <button type="button" class="success" data-source-action="batch-connect">选中一键对接</button>
      </div>
    `;

    function readSourceFilters() {
      const result = {};
      body.querySelectorAll("[data-source]").forEach((input) => {
        result[input.dataset.source] = input.value.trim();
      });
      result.maxPages = Math.max(1, Math.min(50, Number(result.maxPages) || 1));
      result.addRate = Math.max(0, Number(result.addRate) || 0);
      return result;
    }

    function updateSourceCount() {
      body.querySelector("[data-source-count]").textContent = `已选 ${sourceState.selected.size} 项`;
    }

    function refreshSupplierSelect() {
      const select = body.querySelector('[data-source="supplier"]');
      if (!(select instanceof HTMLSelectElement)) return;
      const oldValue = select.value;
      const counts = new Map();
      sourceState.raw.forEach((item) => {
        const key = getSupplierKey(item);
        if (!key) return;
        const prev = counts.get(key) || { name: item.user?.nickname || "未知商家", count: 0 };
        prev.count += 1;
        counts.set(key, prev);
      });
      const sorted = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
      select.innerHTML =
        '<option value="">全部商家</option>' +
        sorted.map(([key, info]) => `<option value="${escapeHtml(key)}">${escapeHtml(info.name)} (${info.count})</option>`).join("");
      if (sorted.some(([key]) => key === oldValue)) select.value = oldValue;
    }

    function renderSourceSummary(filters) {
      const box = body.querySelector("[data-source-summary]");
      if (!box) return;
      if (!sourceState.raw.length || sourceState.loading) {
        box.hidden = true;
        box.innerHTML = "";
        return;
      }
      const shopKeys = new Set();
      const depositShops = new Set();
      sourceState.raw.forEach((item) => {
        const key = getSupplierKey(item);
        if (!key) return;
        shopKeys.add(key);
        if ((getSourceShopDeposit(item) ?? 0) > 0) depositShops.add(key);
      });
      const prices = sourceState.filtered.map(getSourceCost).filter((v) => v !== null);
      const avg = prices.length ? prices.reduce((s, v) => s + v, 0) / prices.length : null;
      const min = prices.length ? Math.min(...prices) : null;
      const max = prices.length ? Math.max(...prices) : null;

      const buckets = [
        { label: "<10元", min: "0", max: "9.99", count: 0 },
        { label: "10-50元", min: "10", max: "50", count: 0 },
        { label: "50-100元", min: "50", max: "100", count: 0 },
        { label: "≥100元", min: "100", max: "", count: 0 },
      ];
      sourceState.raw.forEach((item) => {
        const p = getSourceCost(item);
        if (p === null) return;
        if (p < 10) buckets[0].count += 1;
        else if (p <= 50) buckets[1].count += 1;
        else if (p <= 100) buckets[2].count += 1;
        else buckets[3].count += 1;
      });

      const stopWords = new Set(["自动", "发货", "自动发货", "商品", "官方", "正版", "质保", String(filters.keywords || "").toLowerCase()]);
      const commonTerms = /月卡|年卡|季卡|周卡|天卡|次卡|直充|代充|秒发|独享|共享|成品|激活码|兑换码|SVIP|VIP/gi;
      const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("zh-CN", { granularity: "word" }) : null;
      const freq = new Map();
      sourceState.raw.forEach((item) => {
        const text = String(item.name || "");
        const segWords = segmenter
          ? Array.from(segmenter.segment(text), (s) => (s.isWordLike ? s.segment.trim() : "")).filter((w) => w.length >= 2 && w.length <= 8)
          : [];
        const parts = text.split(/[^\u4e00-\u9fa5A-Za-z0-9]+/).filter((w) => w.length >= 2 && w.length <= 6);
        const terms = text.match(commonTerms) || [];
        const ascii = text.match(/[A-Za-z][A-Za-z0-9+-]{1,11}/g) || [];
        new Set([...terms, ...segWords, ...parts, ...ascii]).forEach((w) => {
          const norm = w.toLowerCase();
          if (stopWords.has(norm) || /^\d+$/.test(norm)) return;
          freq.set(w, (freq.get(w) || 0) + 1);
        });
      });
      const topWords = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

      box.hidden = false;
      box.innerHTML = `
        <div class="ldxp-toolkit-summary-row">
          <span>概览：商家 <strong>${shopKeys.size}</strong> 家（有保 <strong>${depositShops.size}</strong> 家） · 当前成本均值 <strong>${money(avg)}</strong>（${money(min)} ~ ${money(max)}）</span>
          <span class="ldxp-toolkit-muted">| 价格下钻：</span>
          ${buckets
            .filter((b) => b.count > 0)
            .map((b) => {
              const active = filters.minPrice === b.min && filters.maxPrice === b.max;
              return `<button type="button" class="ldxp-toolkit-chip ${active ? "active" : ""}" data-drill-min="${b.min}" data-drill-max="${b.max}">${b.label} (${b.count})</button>`;
            })
            .join("")}
        </div>
        ${
          topWords.length
            ? `<div class="ldxp-toolkit-summary-row">
                <span class="ldxp-toolkit-muted">标题热词下钻：</span>
                ${topWords
                  .map(([w, c]) => {
                    const active = filters.subKeyword.toLowerCase() === w.toLowerCase();
                    return `<button type="button" class="ldxp-toolkit-chip ${active ? "active" : ""}" data-drill-word="${escapeHtml(w)}">${escapeHtml(w)} (${c})</button>`;
                  })
                  .join("")}
              </div>`
            : ""
        }
      `;
    }

    function renderSourceResults() {
      const wrap = body.querySelector("[data-source-results]");
      const prevTop = wrap.scrollTop || 0;
      const prevLeft = wrap.scrollLeft || 0;
      if (sourceState.loading) {
        wrap.innerHTML = '<div class="ldxp-toolkit-empty">正在拉取货源...</div>';
        return;
      }
      if (!sourceState.filtered.length) {
        wrap.innerHTML = '<div class="ldxp-toolkit-empty">当前条件下没有结果</div>';
        updateSourceCount();
        return;
      }
      const currentSort = body.querySelector('[data-source="sort"]')?.value || "cost_asc";
      wrap.innerHTML = `
        <table class="ldxp-toolkit-table">
          <thead><tr>
            <th>选择</th>
            <th>商品</th>
            <th>类型</th>
            <th class="sortable" data-source-sort="cost">成本${sortMark(currentSort, "cost_asc", "cost_desc")}</th>
            <th class="sortable" data-source-sort="sales">单品热度${sortMark(currentSort, "sales_asc", "sales_desc")}</th>
            <th class="sortable" data-source-sort="shop_sales">店铺总销${sortMark(currentSort, "shop_sales_asc", "shop_sales_desc")}</th>
            <th>上架状态</th>
            <th>库存</th>
            <th class="sortable" data-source-sort="deposit">商家 / 保证金${sortMark(currentSort, "deposit_asc", "deposit_desc")}</th>
            <th>对接状态</th>
            <th>操作</th>
          </tr></thead>
          <tbody>${sourceState.filtered.map((item) => {
            const stock = getSourceStock(item);
            const sales = getItemSales(item, sourceState.salesById);
            const shop = getSourceShopInfo(item);
            const shopSales = getSourceShopSales(item);
            const deposit = getSourceShopDeposit(item);
            const authed = isSourceShopAuthed(item);
            const isHot = isSourceItemHot(item);
            const shopUrl = safeUrl(shop?.link || item.user?.link);
            const nickname = escapeHtml(item.user?.nickname || "-");
            const connected = Boolean(item.child);
            const listed = listedLabel(item);
            const shopBadges = [
              authed ? '<span class="ldxp-toolkit-badge info">已认证</span>' : "",
              deposit !== null && deposit > 0 ? `<span class="ldxp-toolkit-badge ok">保¥${escapeHtml(deposit)}</span>` : "",
            ].filter(Boolean).join("");
            return `<tr>
              <td><input type="checkbox" data-source-id="${escapeHtml(item.id)}" ${sourceState.selected.has(String(item.id)) ? "checked" : ""}></td>
              <td class="name"><a href="${escapeHtml(safeUrl(item.link))}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.name || "-")}</a>${isHot ? '<span class="ldxp-toolkit-badge hot">店内热销</span>' : ""}</td>
              <td>${escapeHtml(GOODS_TYPES[item.goods_type] || item.goods_type || "-")}</td>
              <td>${escapeHtml(money(getSourceCost(item)))}</td>
              <td>${sales === null ? '<span class="ldxp-toolkit-muted">-</span>' : escapeHtml(sales)}</td>
              <td>${shopSales === null ? '<span class="ldxp-toolkit-muted">-</span>' : escapeHtml(shopSales)}</td>
              <td><span class="ldxp-toolkit-badge ${listed.className}">${listed.text}</span></td>
              <td>${item.goods_type !== "card" ? '<span class="ldxp-toolkit-muted">无需库存</span>' : stock === null ? '<span class="ldxp-toolkit-muted">-</span>' : escapeHtml(stock)}</td>
              <td>
                <div>${shopUrl === "#" ? nickname : `<a href="${escapeHtml(shopUrl)}" target="_blank" rel="noopener noreferrer">${nickname}</a>`}</div>
                ${shopBadges ? `<div class="ldxp-toolkit-sub">${shopBadges}</div>` : ""}
              </td>
              <td><span class="ldxp-toolkit-badge ${connected ? "ok" : "warn"}">${connected ? "已对接" : "未对接"}</span></td>
              <td><div class="ldxp-toolkit-op-row">
                <button type="button" class="mini" data-detail-id="${escapeHtml(item.id)}">详情</button>
                <button type="button" class="mini ${connected ? "" : "success"}" data-connect-id="${escapeHtml(item.id)}" ${connected ? "disabled" : ""}>${connected ? "已对接" : "一键对接"}</button>
              </div></td>
            </tr>`;
          }).join("")}</tbody>
        </table>`;
      wrap.scrollTop = prevTop;
      wrap.scrollLeft = prevLeft;
      updateSourceCount();
    }

    const mountedEpoch = routeEpoch;
    let sourceFilterRunId = 0;

    function syncEnrichButton(active, progressText = "") {
      sourceState.enriching = active;
      const btn = body.querySelector('[data-source-action="enrich-shops"]');
      if (btn) btn.textContent = active ? `暂停加载${progressText ? ` (${progressText})` : ""}` : "加载店铺/热销";
    }

    function refreshIncrementalView(baseMatched, filters) {
      const matched = baseMatched.filter((item) => sourceMatchesPostShop(item, filters));
      sourceState.filtered = sortSourceItems(matched, filters.sort);
      renderSourceSummary(filters);
      renderSourceResults();
    }

    async function enrichSourceShops(items, runId, filters) {
      const groups = new Map();
      items.forEach((item) => {
        const key = getSupplierKey(item);
        if (!key || sourceState.shopBySupplier.has(key)) return;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      });
      if (!groups.size) return;
      const entries = [...groups.entries()];
      let completed = 0;
      const shouldCancel = () => runId !== sourceFilterRunId || mountedEpoch !== routeEpoch;
      const emptyShop = () => ({
        token: "",
        sellCount: null,
        depositMoney: null,
        authStatus: 0,
        createTime: "",
        province: "",
        contactQq: "",
        hotKeys: new Set(),
        hotIds: new Set(),
        link: "",
      });
      let abortedError = null;
      syncEnrichButton(true, `0/${entries.length}`);
      try {
        for (let i = 0; i < entries.length; i += 1) {
          if (shouldCancel() || abortedError) break;
          const [supplierKey, groupItems] = entries[i];
          let token = extractShopToken(groupItems[0]?.user);
          if (!token) {
            const candidates = [...groupItems]
              .filter((item) => extractGoodsKey(item))
              .sort((a, b) => Number(listedState(b) === true) - Number(listedState(a) === true))
              .slice(0, 2);
            for (const sample of candidates) {
              try {
                const goodsInfo = await postJson(
                  API.shopGoodsInfo,
                  { goods_key: extractGoodsKey(sample) },
                  { shouldCancel, background: true },
                );
                sourceState.detailById.set(String(sample.id), goodsInfo || {});
                sourceState.salesById.set(String(sample.id), toNumber(goodsInfo?.buyer_count ?? goodsInfo?.sell_count));
                token = extractShopToken(goodsInfo?.user);
                if (token) break;
              } catch (error) {
                if (error?.cancelled) break;
                if (error?.rateLimited) {
                  abortedError = error;
                  break;
                }
                sourceState.salesById.set(String(sample.id), null);
              }
            }
          }
          if (shouldCancel() || abortedError) break;
          let shopData = token ? sourceState.shopByToken.get(token) : null;
          if (token && !shopData) {
            try {
              const info = await postJson(API.shopInfo, { token }, { shouldCancel, background: true });
              const hotList = Array.isArray(info?.hot_sell_goods) ? info.hot_sell_goods : [];
              shopData = {
                token,
                sellCount: toNumber(info?.sell_count),
                depositMoney: toNumber(info?.deposit_money),
                authStatus: Number(info?.auth_status) || 0,
                createTime: formatShopDate(info?.create_time),
                province: String(info?.login_province || ""),
                contactQq: String(info?.contact_qq || ""),
                hotKeys: new Set(hotList.map((entry) => String(entry?.goods_key || "").trim()).filter(Boolean)),
                hotIds: new Set(hotList.map((entry) => (entry?.id !== undefined ? String(entry.id) : "")).filter(Boolean)),
                link: info?.link || `/shop/${encodeURIComponent(token)}`,
              };
              sourceState.shopByToken.set(token, shopData);
            } catch (error) {
              if (error?.cancelled) break;
              if (error?.rateLimited) {
                abortedError = error;
                break;
              }
              shopData = emptyShop();
              sourceState.shopByToken.set(token, shopData);
            }
          }
          if (shouldCancel() || abortedError) break;
          const resolved = shopData || emptyShop();
          if (token) {
            groupItems.forEach((item) => {
              item._shopToken = token;
            });
          }
          sourceState.shopBySupplier.set(supplierKey, resolved);
          scheduleSaveSessionCache();
          completed += 1;
          syncEnrichButton(true, `${completed}/${entries.length}`);
          setPanelStatus(panel, `按 ≤3个/秒安全加载店铺资质与热销榜 ${completed}/${entries.length}...`);
          if (filters && completed % 3 === 0) refreshIncrementalView(items, filters);
        }
      } finally {
        syncEnrichButton(false);
      }
      if (abortedError) notify(abortedError.message, "error");
    }

    async function enrichSourceSales(items, runId, baseMatched, filters) {
      const pending = items.filter(
        (item) => getItemSales(item, sourceState.salesById) === null && !sourceState.salesById.has(String(item.id)) && extractGoodsKey(item),
      );
      if (!pending.length) return;
      let completed = 0;
      let abortedError = null;
      const shouldCancel = () => runId !== sourceFilterRunId || mountedEpoch !== routeEpoch;
      syncEnrichButton(true, `0/${pending.length}`);
      try {
        for (let i = 0; i < pending.length; i += 1) {
          if (shouldCancel() || abortedError) break;
          const item = pending[i];
          try {
            const info = await postJson(
              API.shopGoodsInfo,
              { goods_key: extractGoodsKey(item) },
              { shouldCancel, background: true },
            );
            sourceState.detailById.set(String(item.id), info || {});
            sourceState.salesById.set(String(item.id), toNumber(info?.buyer_count ?? info?.sell_count));
            const token = extractShopToken(info?.user);
            if (token) item._shopToken = token;
          } catch (error) {
            if (error?.cancelled) break;
            if (error?.rateLimited) {
              abortedError = error;
              break;
            }
            sourceState.salesById.set(String(item.id), null);
          }
          scheduleSaveSessionCache();
          completed += 1;
          syncEnrichButton(true, `${completed}/${pending.length}`);
          setPanelStatus(panel, `按 ≤3个/秒安全加载单品热度 ${completed}/${pending.length}...`);
          if (filters && completed % 3 === 0) refreshIncrementalView(baseMatched || items, filters);
        }
      } finally {
        syncEnrichButton(false);
      }
      if (abortedError) notify(abortedError.message, "error");
    }

    // shortcut: sorts within fetched pages (up to maxPages * 50 items), upgrade if backend adds server-side sales sort param
    function sortSourceItems(items, sort) {
      if (sort === "default") return items;
      return [...items].sort((a, b) => {
        if (sort === "hot_first") {
          const hotDiff = Number(isSourceItemHot(b)) - Number(isSourceItemHot(a));
          if (hotDiff !== 0) return hotDiff;
          const shopDiff = compareNullableNumbers(getSourceShopSales(a), getSourceShopSales(b), true);
          if (shopDiff !== 0) return shopDiff;
        } else if (sort === "shop_sales_desc" || sort === "shop_sales_asc") {
          const shopDiff = compareNullableNumbers(getSourceShopSales(a), getSourceShopSales(b), sort === "shop_sales_desc");
          if (shopDiff !== 0) return shopDiff;
          const hotDiff = Number(isSourceItemHot(b)) - Number(isSourceItemHot(a));
          if (hotDiff !== 0) return hotDiff;
        } else if (sort === "deposit_desc" || sort === "deposit_asc") {
          const depDiff = compareNullableNumbers(getSourceShopDeposit(a), getSourceShopDeposit(b), sort === "deposit_desc");
          if (depDiff !== 0) return depDiff;
          const shopDiff = compareNullableNumbers(getSourceShopSales(a), getSourceShopSales(b), true);
          if (shopDiff !== 0) return shopDiff;
        } else if (sort === "sales_desc" || sort === "sales_asc") {
          const salesDiff = compareNullableNumbers(
            getItemSales(a, sourceState.salesById),
            getItemSales(b, sourceState.salesById),
            sort === "sales_desc",
          );
          if (salesDiff !== 0) return salesDiff;
          const hotDiff = Number(isSourceItemHot(b)) - Number(isSourceItemHot(a));
          if (hotDiff !== 0) return hotDiff;
        } else {
          const costDiff = compareNullableNumbers(getSourceCost(a), getSourceCost(b), sort === "cost_desc");
          if (costDiff !== 0) return costDiff;
        }
        return compareNullableNumbers(getSourceCost(a), getSourceCost(b), false);
      });
    }

    function needsShopEnrichment(filters) {
      return (
        filters.hot === "hot" ||
        filters.deposit !== "all" ||
        ["shop_sales_desc", "shop_sales_asc", "deposit_desc", "deposit_asc", "hot_first"].includes(filters.sort)
      );
    }

    async function applySourceFilters(forceShopEnrich = false) {
      const runId = ++sourceFilterRunId;
      const filters = readSourceFilters();
      const baseMatched = sourceState.raw.filter((item) => sourceMatches(item, filters));
      // Render immediately with already-cached data first so switching filters/tags feels instant
      refreshIncrementalView(baseMatched, filters);
      if (forceShopEnrich || needsShopEnrichment(filters)) {
        await enrichSourceShops(baseMatched, runId, filters);
        if (runId !== sourceFilterRunId || mountedEpoch !== routeEpoch) return;
      }
      const matched = baseMatched.filter((item) => sourceMatchesPostShop(item, filters));
      if (filters.sort === "sales_desc" || filters.sort === "sales_asc") {
        await enrichSourceSales(matched, runId, baseMatched, filters);
        if (runId !== sourceFilterRunId || mountedEpoch !== routeEpoch) return;
      }
      sourceState.filtered = sortSourceItems(matched, filters.sort);
      sourceState.selected = new Set([...sourceState.selected].filter((id) => sourceState.filtered.some((item) => String(item.id) === id)));
      renderSourceSummary(filters);
      renderSourceResults();
      setPanelStatus(panel, `共拉取 ${sourceState.raw.length} 条，筛选后 ${sourceState.filtered.length} 条`);
    }

    function resetSourceFilters() {
      const defaults = {
        minPrice: "",
        maxPrice: "",
        subKeyword: "",
        supplier: "",
        deposit: "all",
        stock: "all",
        listed: "all",
        connect: "all",
        hot: "all",
        excludeZero: "no",
        sort: "cost_asc",
      };
      Object.entries(defaults).forEach(([key, val]) => {
        const el = body.querySelector(`[data-source="${key}"]`);
        if (el) el.value = val;
      });
      applySourceFilters();
    }

    async function openSourceDetail(id) {
      const item = sourceState.raw.find((entry) => String(entry.id) === String(id));
      if (!item) return;
      const { drawer, setItemId } = detailRef;
      setItemId(item.id);
      const titleEl = drawer.querySelector("[data-drawer-title]");
      const metaEl = drawer.querySelector("[data-drawer-meta]");
      const descEl = drawer.querySelector("[data-drawer-desc]");
      const linkEl = drawer.querySelector("[data-drawer-open-link]");
      const connectBtn = drawer.querySelector("[data-drawer-connect]");
      titleEl.textContent = item.name || "商品详情预览";
      const url = safeUrl(item.link);
      linkEl.href = url;
      linkEl.hidden = url === "#";
      const connected = Boolean(item.child);
      connectBtn.disabled = connected;
      connectBtn.textContent = connected ? "已对接" : "一键对接";
      metaEl.innerHTML = '<div class="ldxp-toolkit-muted">正在加载商品详情...</div>';
      descEl.textContent = "";
      if (typeof drawer.showModal === "function" && !drawer.open) drawer.showModal();

      let detail = sourceState.detailById.get(String(item.id));
      const goodsKey = extractGoodsKey(item);
      if (!detail && goodsKey) {
        try {
          detail = await postJson(API.shopGoodsInfo, { goods_key: goodsKey });
          sourceState.detailById.set(String(item.id), detail || {});
          sourceState.salesById.set(String(item.id), toNumber(detail?.buyer_count ?? detail?.sell_count));
          const token = extractShopToken(detail?.user);
          if (token) item._shopToken = token;
        } catch (error) {
          if (error?.rateLimited) notify(error.message, "error");
          detail = {};
        }
      }
      if (!getSourceShopInfo(item)) {
        await enrichSourceShops([item], sourceFilterRunId);
        renderSourceResults();
      }
      const shop = getSourceShopInfo(item);
      const coverUrl = safeUrl(detail?.image || item.image);
      const sales = getItemSales(item, sourceState.salesById);
      const shopSales = getSourceShopSales(item);
      const deposit = getSourceShopDeposit(item);
      const authed = isSourceShopAuthed(item);
      const qq = shop?.contactQq || item.user?.contact_qq || "-";
      const shopExtra = [
        authed ? "已实名认证" : "",
        deposit !== null ? `保证金 ¥${deposit}` : "",
        shop?.province ? `来自${shop.province}` : "",
        shop?.createTime ? `开店 ${shop.createTime}` : "",
      ].filter(Boolean).join(" · ");

      metaEl.innerHTML = `
        ${coverUrl !== "#" ? `<img class="ldxp-toolkit-drawer-cover" src="${escapeHtml(coverUrl)}" alt="">` : ""}
        <div class="ldxp-toolkit-drawer-kv">
          <span class="k">对接成本</span><span><strong>${escapeHtml(money(getSourceCost(item)))}</strong>${item.agent_price_limit ? `（限最低售价 ${escapeHtml(money(item.agent_price_limit))}）` : ""}</span>
          <span class="k">零售/市场价</span><span>零售 ${escapeHtml(money(detail?.price ?? item.price))} / 市场价 ${escapeHtml(money(detail?.market_price))}</span>
          <span class="k">单品/店总销</span><span>单品热度 ${escapeHtml(sales ?? "-")} · 店铺总销 ${escapeHtml(shopSales ?? "-")}${isSourceItemHot(item) ? ' <span class="ldxp-toolkit-badge hot">店内热销</span>' : ""}</span>
          <span class="k">类型 / 库存</span><span>${escapeHtml(GOODS_TYPES[item.goods_type] || item.goods_type || "-")} · 库存 ${escapeHtml(item.goods_type !== "card" ? "无需库存" : getSourceStock(item) ?? "-")}</span>
          <span class="k">供货商家</span><span>${escapeHtml(item.user?.nickname || "-")}（QQ：${escapeHtml(qq)}）</span>
          ${shopExtra ? `<span class="k">商家资质</span><span>${escapeHtml(shopExtra)}</span>` : ""}
        </div>
      `;
      renderSafeHtml(descEl, detail?.description || item.description || "");
    }

    async function searchSource(button) {
      const filters = readSourceFilters();
      if (!filters.keywords) {
        notify("请先输入关键词", "error");
        return;
      }
      setBusy(button, true, "搜索中...");
      sourceFilterRunId += 1;
      sourceState.loading = true;
      sourceState.raw = [];
      sourceState.filtered = [];
      sourceState.selected.clear();
      renderSourceSummary(filters);
      renderSourceResults();
      try {
        const pageSize = 50;
        let total = Infinity;
        for (let current = 1; current <= filters.maxPages && sourceState.raw.length < total; current += 1) {
          setPanelStatus(panel, `正在拉取第 ${current}/${filters.maxPages} 页...`);
          const data = await postJson(API.sourceSearch, {
            current,
            pageSize,
            name: "",
            goods_type: filters.goodsType,
            keywords: filters.keywords,
          });
          const list = Array.isArray(data?.list) ? data.list : [];
          total = Number(data?.total) || sourceState.raw.length + list.length;
          sourceState.raw.push(...list);
          if (list.length < pageSize) break;
        }
        sourceState.loading = false;
        refreshSupplierSelect();
        await applySourceFilters();
      } catch (error) {
        sourceState.loading = false;
        renderSourceResults();
        setPanelStatus(panel, error.message || String(error));
        notify(error.message || String(error), "error");
      } finally {
        setBusy(button, false);
      }
    }

    async function connectSourceItems(ids, button) {
      const targets = ids.filter((id) => {
        const item = sourceState.raw.find((entry) => String(entry.id) === String(id));
        return item && !item.child;
      });
      if (!targets.length) {
        notify("没有可对接的未对接商品", "error");
        return;
      }
      const { addRate } = readSourceFilters();
      if (!confirm(`确定对接 ${targets.length} 个商品吗？\n默认按成本价加价 ${addRate}% 建立商品。`)) return;
      setBusy(button, true, "对接中...");
      try {
        const data = await postJson(API.sourceConnect, {
          add_type: 1,
          add_rate: addRate,
          add_price: 0,
          name_sync: 1,
          description_sync: 1,
          goods_ids: targets.map((id) => Number(id)),
        });
        targets.forEach((id) => {
          const item = sourceState.raw.find((entry) => String(entry.id) === String(id));
          if (item) item.child = item.child || { connected: true };
          sourceState.selected.delete(String(id));
        });
        await applySourceFilters();
        notify(typeof data === "string" ? data : `成功对接 ${targets.length} 个商品`, "success");
      } catch (error) {
        notify(error.message || String(error), "error");
      } finally {
        setBusy(button, false);
      }
    }

    body.addEventListener("click", (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target) return;
      const actionButton = target.closest("[data-source-action]");
      if (actionButton?.dataset.sourceAction === "search") searchSource(actionButton);
      if (actionButton?.dataset.sourceAction === "enrich-shops") {
        if (sourceState.enriching) {
          sourceFilterRunId += 1;
          syncEnrichButton(false);
          setPanelStatus(panel, "已暂停加载（已获取数据已缓存）");
        } else {
          applySourceFilters(true);
        }
      }
      if (actionButton?.dataset.sourceAction === "filter") applySourceFilters();
      if (actionButton?.dataset.sourceAction === "reset") resetSourceFilters();
      if (actionButton?.dataset.sourceAction === "batch-connect") connectSourceItems([...sourceState.selected], actionButton);
      const connectButton = target.closest("[data-connect-id]");
      if (connectButton) connectSourceItems([connectButton.dataset.connectId], connectButton);
      const detailButton = target.closest("[data-detail-id]");
      if (detailButton) openSourceDetail(detailButton.dataset.detailId);
      const sortTh = target.closest("[data-source-sort]");
      if (sortTh) {
        const col = sortTh.dataset.sourceSort;
        const select = body.querySelector('[data-source="sort"]');
        const pairs = {
          cost: ["cost_asc", "cost_desc"],
          sales: ["sales_desc", "sales_asc"],
          shop_sales: ["shop_sales_desc", "shop_sales_asc"],
          deposit: ["deposit_desc", "deposit_asc"],
        }[col];
        if (select && pairs) {
          select.value = select.value === pairs[0] ? pairs[1] : pairs[0];
          applySourceFilters();
        }
      }
      const bucketChip = target.closest("[data-drill-min]");
      if (bucketChip) {
        const minInput = body.querySelector('[data-source="minPrice"]');
        const maxInput = body.querySelector('[data-source="maxPrice"]');
        const same = minInput.value === bucketChip.dataset.drillMin && maxInput.value === bucketChip.dataset.drillMax;
        minInput.value = same ? "" : bucketChip.dataset.drillMin;
        maxInput.value = same ? "" : bucketChip.dataset.drillMax;
        applySourceFilters();
      }
      const wordChip = target.closest("[data-drill-word]");
      if (wordChip) {
        const subInput = body.querySelector('[data-source="subKeyword"]');
        const word = wordChip.dataset.drillWord || "";
        subInput.value = subInput.value.toLowerCase() === word.toLowerCase() ? "" : word;
        applySourceFilters();
      }
    });

    body.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
      if (target.matches("[data-source-id]")) {
        const id = String(target.dataset.sourceId);
        target.checked ? sourceState.selected.add(id) : sourceState.selected.delete(id);
        updateSourceCount();
      }
      if (target.matches("[data-source-select-all]")) {
        sourceState.filtered.forEach((item) => {
          const id = String(item.id);
          target.checked ? sourceState.selected.add(id) : sourceState.selected.delete(id);
        });
        renderSourceResults();
      }
      if (
        ["sort", "hot", "supplier", "deposit", "excludeZero", "stock", "listed", "connect"].some((k) =>
          target.matches(`[data-source="${k}"]`),
        )
      ) {
        applySourceFilters();
      }
    });

    body.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.matches('[data-source="keywords"]')) {
        searchSource(body.querySelector('[data-source-action="search"]'));
      } else if (["subKeyword", "minPrice", "maxPrice"].some((k) => target.matches(`[data-source="${k}"]`))) {
        applySourceFilters();
      }
    });

    panel.hidden = true;
    createLauncher("增强货源搜索", () => {
      panel.hidden = !panel.hidden;
    });
  }

  function itemStock(item) {
    if ((item.goods_type || goodsState.goodsType) !== "card") return "无需库存";
    const stock = toNumber(item.extend?.stock_count ?? item.stock_count);
    return stock === null ? "-" : String(stock);
  }

  function createReportModal() {
    const modal = document.createElement("div");
    modal.className = "ldxp-toolkit-report";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="ldxp-toolkit-report-box">
        <strong>商品文字报表</strong>
        <textarea data-report-text readonly></textarea>
        <div class="ldxp-toolkit-report-actions">
          <button type="button" data-report-close>关闭</button>
          <button type="button" class="primary" data-report-copy>复制全部文字</button>
        </div>
      </div>`;
    modal.querySelector("[data-report-close]").addEventListener("click", () => {
      modal.hidden = true;
    });
    modal.querySelector("[data-report-copy]").addEventListener("click", async () => {
      const text = modal.querySelector("[data-report-text]").value;
      try {
        await navigator.clipboard.writeText(text);
        notify("报表文字已复制", "success");
      } catch (_) {
        const textarea = modal.querySelector("[data-report-text]");
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        notify("报表文字已复制", "success");
      }
    });
    document.body.appendChild(modal);
    return modal;
  }

  function mountGoodsTool() {
    const panel = createPanel("商品管理批量工具");
    const reportModal = createReportModal();
    const body = panel.querySelector("[data-panel-body]");
    body.innerHTML = `
      <div class="ldxp-toolkit-controls">
        <label>商品类型<select data-goods="goodsType">${Object.entries(GOODS_TYPES).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
        <label>是否上架<select data-goods="status"><option value="999">全部</option><option value="1">已上架</option><option value="0">未上架</option></select></label>
        <label>筛选分类搜索<input data-goods-filter-category-search placeholder="输入分类名称"></label>
        <label>筛选分类<select data-goods="filterCategory"><option value="">全部分类</option></select></label>
        <label>商品名称<input data-goods="name" placeholder="留空查询全部"></label>
        <label>库存筛选<select data-goods="stockFilter"><option value="all">全部库存</option><option value="in">有库存</option><option value="out">缺货</option></select></label>
        <label>零元过滤<select data-goods="excludeZero"><option value="no">全部价格</option><option value="yes">排除0元商品</option></select></label>
        <label>排序方式<select data-goods="priceSort"><option value="default">默认顺序</option><option value="sales_desc">销量从高到低</option><option value="sales_asc">销量从低到高</option><option value="asc">价格从低到高</option><option value="desc">价格从高到低</option></select></label>
        <label>拉取页数<input data-goods="maxPages" type="number" min="1" max="20" value="1"></label>
        <label>每页数量<select data-goods="pageSize"><option>20</option><option selected>50</option><option>100</option></select></label>
        <div class="ldxp-toolkit-actions"><button type="button" class="primary" data-goods-action="load">加载商品</button></div>
        <label>搜索分类选项<input data-goods-category-search placeholder="输入分类名称"></label>
        <label>修改为分类<select data-goods="category"><option value="">保持不变</option></select></label>
        <label>价格修改<select data-goods="priceMode"><option value="keep">保持不变</option><option value="fixed">统一价格</option><option value="percent">按比例调整</option><option value="add">统一加减金额</option></select></label>
        <label>价格数值<input data-goods="priceValue" type="number" step="0.01" placeholder="如 19.9 / 10 / -2"></label>
        <label>上下架状态<select data-goods="newStatus"><option value="">保持不变</option><option value="1">销售中</option><option value="0">仓库中</option></select></label>
        <div class="ldxp-toolkit-actions"><button type="button" class="success" data-goods-action="batch-edit">保存选中修改</button></div>
      </div>
      <div class="ldxp-toolkit-table-wrap" data-goods-results><div class="ldxp-toolkit-empty">点击“加载商品”后，在这里勾选需要处理的商品</div></div>
      <div class="ldxp-toolkit-footer">
        <label><input type="checkbox" data-goods-select-all> 全选当前结果</label>
        <span data-goods-count>已选 0 项</span>
        <span class="spacer"></span>
        <button type="button" data-goods-action="report">生成并复制文字报表</button>
      </div>`;

    function flattenCategories(categories, parents = []) {
      const result = [];
      (Array.isArray(categories) ? categories : []).forEach((category) => {
        const value = category.value ?? category.id;
        const name = category.label ?? category.name ?? (value !== undefined ? `分类 ${value}` : "未命名分类");
        const path = [...parents, String(name)];
        if (value !== undefined && value !== null && value !== "") {
          result.push({ value: String(value), label: path.join(" / ") });
        }
        const children = category.children ?? category.child ?? category.list;
        if (Array.isArray(children) && children.length) {
          result.push(...flattenCategories(children, path));
        }
      });
      return result;
    }

    function categoryIdForItem(item) {
      const cached = goodsState.infoById.get(String(item.id));
      const categoryString = typeof item.category === "string" ? item.category.trim() : "";
      return (
        item.category_id ??
        item.goods_category_id ??
        item.categoryId ??
        item.cate_id ??
        item.category?.id ??
        item.category?.value ??
        cached?.category_id ??
        cached?.goods_category_id ??
        cached?.categoryId ??
        cached?.cate_id ??
        (categoryString && /^\d+$/.test(categoryString) ? categoryString : undefined)
      );
    }

    function categoryLabelForItem(item) {
      const categoryString = typeof item.category === "string" ? item.category.trim() : "";
      const cached = goodsState.infoById.get(String(item.id));
      const direct =
        (categoryString && !/^\d+$/.test(categoryString) ? categoryString : "") ||
        item.category?.name ||
        item.category?.label ||
        item.category_name ||
        item.category_title ||
        cached?.category?.name ||
        cached?.category?.label ||
        cached?.category_name ||
        cached?.category_title;
      if (direct) return direct;
      const categoryId = categoryIdForItem(item);
      const matched = goodsState.categories.find((category) => String(category.value) === String(categoryId));
      if (matched) return matched.label;
      return categoryId !== undefined && categoryId !== null && categoryId !== "" ? `分类 ID：${categoryId}` : "未分类";
    }

    const mountedGoodsEpoch = routeEpoch;

    async function enrichGoodsInfo(items) {
      const pending = items.filter((item) => categoryIdForItem(item) === undefined && !goodsState.infoById.has(String(item.id)));
      if (!pending.length) return;
      let completed = 0;
      let abortedError = null;
      const shouldCancel = () => mountedGoodsEpoch !== routeEpoch;
      for (let i = 0; i < pending.length; i += 1) {
        if (shouldCancel() || abortedError) break;
        const item = pending[i];
        try {
          const info = await postJson(API.goodsInfo, { id: item.id }, { shouldCancel, background: true });
          goodsState.infoById.set(String(item.id), info || {});
          scheduleSaveSessionCache();
        } catch (error) {
          if (error?.cancelled) break;
          if (error?.rateLimited) {
            abortedError = error;
            break;
          }
          goodsState.infoById.set(String(item.id), {});
        }
        completed += 1;
        setPanelStatus(panel, `按 ≤3个/秒安全识别商品分类 ${completed}/${pending.length}...`);
        if (completed % 3 === 0) applyGoodsDisplay();
      }
      if (abortedError) notify(abortedError.message, "error");
    }

    function fillCategorySelect(select, emptyLabel, searchText = "") {
      if (!(select instanceof HTMLSelectElement)) return;
      const oldValue = select.value;
      const keyword = searchText.trim().toLowerCase();
      const options = goodsState.categories.filter((category) => !keyword || category.label.toLowerCase().includes(keyword));
      select.innerHTML = "";
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = emptyLabel;
      select.appendChild(empty);
      options.forEach((category) => {
        const option = document.createElement("option");
        option.value = category.value;
        option.textContent = category.label;
        select.appendChild(option);
      });
      if ([...select.options].some((option) => option.value === oldValue)) select.value = oldValue;
    }

    function renderCategorySelects() {
      fillCategorySelect(
        body.querySelector('[data-goods="filterCategory"]'),
        "全部分类",
        body.querySelector("[data-goods-filter-category-search]")?.value || "",
      );
      fillCategorySelect(
        body.querySelector('[data-goods="category"]'),
        "保持不变",
        body.querySelector("[data-goods-category-search]")?.value || "",
      );
    }

    function readGoodsControls() {
      const values = {};
      body.querySelectorAll("[data-goods]").forEach((input) => {
        values[input.dataset.goods] = input.value.trim();
      });
      values.maxPages = Math.max(1, Math.min(20, Number(values.maxPages) || 1));
      values.pageSize = Math.max(20, Math.min(100, Number(values.pageSize) || 50));
      return values;
    }

    function updateGoodsCount() {
      body.querySelector("[data-goods-count]").textContent = `已选 ${goodsState.selected.size} 项`;
    }

    function sortGoodsItems() {
      const sort = body.querySelector('[data-goods="priceSort"]')?.value || "default";
      if (sort === "default") return;
      const isSales = sort === "sales_asc" || sort === "sales_desc";
      const isDesc = sort === "desc" || sort === "sales_desc";
      goodsState.items.sort((a, b) =>
        compareNullableNumbers(isSales ? getItemSales(a) : toNumber(a.price), isSales ? getItemSales(b) : toNumber(b.price), isDesc),
      );
    }

    function applyGoodsDisplay() {
      const stockFilter = body.querySelector('[data-goods="stockFilter"]')?.value || "all";
      const excludeZero = body.querySelector('[data-goods="excludeZero"]')?.value || "no";
      goodsState.items = goodsState.rawItems.filter((item) => {
        if (excludeZero === "yes") {
          const p = toNumber(item.price);
          if (p === null || p <= 0) return false;
        }
        if (stockFilter === "all") return true;
        if ((item.goods_type || goodsState.goodsType) !== "card") return false;
        const stock = toNumber(item.extend?.stock_count ?? item.stock_count);
        if (stock === null) return false;
        return stockFilter === "in" ? stock > 0 : stock <= 0;
      });
      const visibleIds = new Set(goodsState.items.map((item) => String(item.id)));
      goodsState.selected = new Set([...goodsState.selected].filter((id) => visibleIds.has(id)));
      sortGoodsItems();
      renderGoodsResults();
    }

    function renderGoodsResults() {
      const wrap = body.querySelector("[data-goods-results]");
      if (goodsState.loading) {
        wrap.innerHTML = '<div class="ldxp-toolkit-empty">正在加载商品...</div>';
        return;
      }
      if (!goodsState.items.length) {
        wrap.innerHTML = '<div class="ldxp-toolkit-empty">没有查到商品</div>';
        updateGoodsCount();
        return;
      }
      const currentSort = body.querySelector('[data-goods="priceSort"]')?.value || "default";
      wrap.innerHTML = `
        <table class="ldxp-toolkit-table">
          <thead><tr>
            <th>选择</th>
            <th>ID</th>
            <th>商品名称</th>
            <th>分类</th>
            <th>上架状态</th>
            <th>库存</th>
            <th class="sortable" data-goods-sort="sales">销量${sortMark(currentSort, "sales_asc", "sales_desc")}</th>
            <th class="sortable" data-goods-sort="price">价格${sortMark(currentSort, "asc", "desc")}</th>
          </tr></thead>
          <tbody>${goodsState.items.map((item) => {
            const sales = getItemSales(item);
            return `<tr>
            <td><input type="checkbox" data-goods-id="${escapeHtml(item.id)}" ${goodsState.selected.has(String(item.id)) ? "checked" : ""}></td>
            <td>${escapeHtml(item.id)}</td>
            <td class="name">${escapeHtml(item.name || "-")}</td>
            <td>${escapeHtml(categoryLabelForItem(item))}</td>
            <td><span class="ldxp-toolkit-badge ${listedLabel(item).className}">${listedLabel(item).text}</span></td>
            <td>${escapeHtml(itemStock(item))}</td>
            <td>${sales === null ? '<span class="ldxp-toolkit-muted">-</span>' : escapeHtml(sales)}</td>
            <td>${escapeHtml(money(item.price))}</td>
          </tr>`;
          }).join("")}</tbody>
        </table>`;
      updateGoodsCount();
    }

    async function loadCategories(goodsType) {
      if (goodsState.categoriesType === goodsType && goodsState.categories.length) {
        renderCategorySelects();
        return;
      }
      try {
        const data = await postJson(API.categoryList, { goods_type: goodsType });
        goodsState.categories = flattenCategories(data);
        goodsState.categoriesType = goodsType;
        renderCategorySelects();
      } catch (error) {
        notify(`分类加载失败：${error.message || error}`, "error");
      }
    }

    async function loadGoods(button) {
      const controls = readGoodsControls();
      goodsState.loading = true;
      goodsState.goodsType = controls.goodsType;
      goodsState.rawItems = [];
      goodsState.items = [];
      goodsState.selected.clear();
      renderGoodsResults();
      setBusy(button, true, "加载中...");
      try {
        await loadCategories(controls.goodsType);
        let total = Infinity;
        for (let current = 1; current <= controls.maxPages && goodsState.rawItems.length < total; current += 1) {
          setPanelStatus(panel, `正在加载第 ${current}/${controls.maxPages} 页...`);
          const data = await postJson(API.goodsList, {
            current,
            pageSize: controls.pageSize,
            goods_type: controls.goodsType,
            status: Number(controls.status),
            name: controls.name,
            category_id: controls.filterCategory ? Number(controls.filterCategory) : undefined,
            is_proxy: new URLSearchParams(location.search).get("is_proxy") || "1",
          });
          const list = Array.isArray(data?.list) ? data.list : [];
          total = Number(data?.total) || goodsState.items.length + list.length;
          goodsState.rawItems.push(...list);
          if (list.length < controls.pageSize) break;
        }
        await enrichGoodsInfo(goodsState.rawItems);
        applyGoodsDisplay();
        setPanelStatus(panel, `已拉取 ${goodsState.rawItems.length} 个，当前显示 ${goodsState.items.length} 个商品`);
      } catch (error) {
        goodsState.loading = false;
        renderGoodsResults();
        notify(error.message || String(error), "error");
      } finally {
        goodsState.loading = false;
        renderGoodsResults();
        setBusy(button, false);
      }
    }

    function selectedGoods() {
      return goodsState.items.filter((item) => goodsState.selected.has(String(item.id)));
    }

    function calculatePrice(oldPrice, mode, value) {
      const price = Math.max(0, toNumber(oldPrice) ?? 0);
      if (mode === "fixed") return Math.max(0, value);
      if (mode === "percent") return Math.max(0, Math.round(price * (1 + value / 100) * 100) / 100);
      if (mode === "add") return Math.max(0, Math.round((price + value) * 100) / 100);
      return price;
    }

    async function batchEdit(button) {
      const items = selectedGoods();
      if (!items.length) {
        notify("请先勾选商品", "error");
        return;
      }
      const controls = readGoodsControls();
      const categoryId = controls.category;
      const priceMode = controls.priceMode;
      const priceValue = toNumber(controls.priceValue);
      const status = controls.newStatus;
      if (!categoryId && priceMode === "keep" && status === "") {
        notify("请至少选择一个需要修改的字段", "error");
        return;
      }
      if (priceMode !== "keep" && priceValue === null) {
        notify("请输入价格修改数值", "error");
        return;
      }
      const categoryLabel = body.querySelector('[data-goods="category"] option:checked')?.textContent || "保持不变";
      const changes = [
        categoryId ? `分类：${categoryLabel}` : "",
        priceMode !== "keep" ? `价格方式：${{ fixed: "统一价格", percent: "按比例调整", add: "加减金额" }[priceMode]} ${priceValue}` : "",
        status !== "" ? `状态：${status === "1" ? "销售中" : "仓库中"}` : "",
      ].filter(Boolean).join("\n");
      if (!confirm(`即将修改 ${items.length} 个商品：\n${changes}\n\n操作会直接保存到店铺，确定继续吗？`)) return;

      setBusy(button, true, "保存中...");
      let success = 0;
      const failures = [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        setPanelStatus(panel, `正在保存 ${index + 1}/${items.length}：${item.name}`);
        try {
          if (categoryId || priceMode !== "keep") {
            const cachedInfo = goodsState.infoById.get(String(item.id));
            const info =
              cachedInfo && cachedInfo.name !== undefined
                ? cachedInfo
                : await postJson(API.goodsInfo, { id: item.id });
            const payload = JSON.parse(JSON.stringify(info || {}));
            if (!payload.id) payload.id = item.id;
            if (categoryId) payload.category_id = Number(categoryId);
            if (priceMode !== "keep") payload.price = calculatePrice(payload.price, priceMode, priceValue);
            await postJson(API.goodsUpdate, payload);
            goodsState.infoById.set(String(item.id), payload);
            scheduleSaveSessionCache();
          }
          if (status !== "") {
            await postJson(API.goodsStatus, { id: item.id, status: Number(status) });
          }
          success += 1;
        } catch (error) {
          failures.push(`${item.name}：${error.message || error}`);
        }
      }
      setBusy(button, false);
      setPanelStatus(panel, `批量修改完成：成功 ${success}，失败 ${failures.length}`);
      if (failures.length) {
        alert(`成功 ${success} 个，失败 ${failures.length} 个：\n\n${failures.join("\n")}`);
      } else {
        notify(`成功修改 ${success} 个商品`, "success");
      }
      await loadGoods(body.querySelector('[data-goods-action="load"]'));
    }

    async function buildReport(button) {
      const items = selectedGoods();
      if (!items.length) {
        notify("请先勾选商品", "error");
        return;
      }
      setBusy(button, true, "生成中...");
      const blocks = [];
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        setPanelStatus(panel, `正在获取链接 ${index + 1}/${items.length}...`);
        let link = safeUrl(item.link);
        if (link === "#") {
          try {
            const data = await postJson(API.goodsLink, { id: item.id });
            link = safeUrl(data?.link || data?.short_link);
          } catch (_) {
            link = "获取失败";
          }
        }
        blocks.push([
          `商品名称：${item.name || "-"}`,
          `库存：${itemStock(item)}`,
          `价格：${money(item.price)}`,
          `链接：${link}`,
        ].join("\n"));
      }
      const report = blocks.join("\n--------------------\n");
      reportModal.querySelector("[data-report-text]").value = report;
      reportModal.hidden = false;
      try {
        await navigator.clipboard.writeText(report);
        notify("文字报表已生成并复制", "success");
      } catch (_) {
        notify("报表已生成，请点击“复制全部文字”", "info");
      }
      setPanelStatus(panel, `已生成 ${items.length} 个商品的文字报表`);
      setBusy(button, false);
    }

    body.addEventListener("click", (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target) return;
      const sortTh = target.closest("[data-goods-sort]");
      if (sortTh) {
        const select = body.querySelector('[data-goods="priceSort"]');
        const pairs = { sales: ["sales_desc", "sales_asc"], price: ["asc", "desc"] }[sortTh.dataset.goodsSort];
        if (select && pairs) {
          select.value = select.value === pairs[0] ? pairs[1] : pairs[0];
          applyGoodsDisplay();
        }
        return;
      }
      const button = target.closest("[data-goods-action]");
      if (!button) return;
      const action = button.dataset.goodsAction;
      if (action === "load") loadGoods(button);
      if (action === "batch-edit") batchEdit(button);
      if (action === "report") buildReport(button);
    });

    body.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
      if (target.matches("[data-goods-id]")) {
        const id = String(target.dataset.goodsId);
        target.checked ? goodsState.selected.add(id) : goodsState.selected.delete(id);
        updateGoodsCount();
      }
      if (target.matches("[data-goods-select-all]")) {
        goodsState.items.forEach((item) => {
          const id = String(item.id);
          target.checked ? goodsState.selected.add(id) : goodsState.selected.delete(id);
        });
        renderGoodsResults();
      }
      if (target.matches('[data-goods="goodsType"]')) {
        goodsState.categories = [];
        goodsState.categoriesType = "";
        body.querySelector("[data-goods-filter-category-search]").value = "";
        body.querySelector("[data-goods-category-search]").value = "";
        if (!panel.hidden) loadCategories(target.value);
      }
      if (target.matches('[data-goods="priceSort"]')) {
        applyGoodsDisplay();
      }
      if (target.matches('[data-goods="stockFilter"]') || target.matches('[data-goods="excludeZero"]')) {
        applyGoodsDisplay();
        setPanelStatus(panel, `已拉取 ${goodsState.rawItems.length} 个，当前显示 ${goodsState.items.length} 个商品`);
      }
    });

    body.addEventListener("input", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.matches("[data-goods-filter-category-search]")) {
        fillCategorySelect(body.querySelector('[data-goods="filterCategory"]'), "全部分类", target.value);
      }
      if (target.matches("[data-goods-category-search]")) {
        fillCategorySelect(body.querySelector('[data-goods="category"]'), "保持不变", target.value);
      }
    });

    panel.hidden = true;
    createLauncher("商品批量工具", () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden && !goodsState.categories.length) loadCategories(readGoodsControls().goodsType);
    });
    createLauncher("货源广场", () => {
      location.href = SOURCE_PATH;
    }).classList.add("goto");
  }

  function mount() {
    if (document.getElementById(APP_ID)) return;
    installStyles();
    const marker = document.createElement("div");
    marker.id = APP_ID;
    marker.hidden = true;
    document.body.appendChild(marker);
    const pathname = location.pathname.replace(/\/+$/, "");
    if (pathname === SOURCE_PATH) mountSourceTool();
    if (pathname === GOODS_PATH) mountGoodsTool();
  }

  function boot() {
    loadSessionCache();
    installHostTrafficObserver();
    let lastPathname = location.pathname.replace(/\/+$/, "");
    const syncRoute = () => {
      const currentPathname = location.pathname.replace(/\/+$/, "");
      if (currentPathname !== lastPathname) {
        lastPathname = currentPathname;
        routeEpoch += 1;
        document.querySelectorAll(`.ldxp-toolkit-launcher,.ldxp-toolkit-panel,.ldxp-toolkit-report,.ldxp-toolkit-drawer,#${APP_ID}`).forEach((node) => node.remove());
        mount();
      }
    };
    mount();
    window.addEventListener("popstate", syncRoute);
    const observer = new MutationObserver(syncRoute);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
