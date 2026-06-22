/* ════════════════════════════════════════════════════════════════════
   QDP Terminal — Cloudflare Worker CORS Proxy
   ────────────────────────────────────────────────────────────────────
   用途：取代 allorigins / corsproxy 等不穩定的公用代理，為前端提供
         穩定低延遲的 CORS 轉發層。

   功能：
     • 白名單防護（只允許轉發到 TWSE / FinMind，避免被當開放代理濫用）
     • Edge cache 3 秒（多分頁同股票時可命中，省 upstream 額度）
     • 8 秒上游 timeout（超過視為失敗，比公用代理 30s timeout 快得多）
     • CORS 完整支援（含 preflight OPTIONS）
     • 診斷 header（x-proxy-cache / x-upstream-status）方便 DevTools 觀察

   用法（前端）：
     const target = `https://mis.twse.com.tw/...`;
     const proxied = `https://qdp-proxy.<你的子網域>.workers.dev/?url=${encodeURIComponent(target)}`;
     fetch(proxied).then(r => r.json())
═════════════════════════════════════════════════════════════════════ */

const ALLOWED_HOSTS = new Set([
  "mis.twse.com.tw",            // TWSE 即時報價
  "api.finmindtrade.com",       // FinMind（歷史資料主來源）
  "openapi.twse.com.tw",        // 證交所 OpenAPI（上市全名單 STOCK_DAY_ALL）
  "www.twse.com.tw",            // 證交所月成交資料（歷史備援）
  "www.tpex.org.tw",            // 櫃買中心 OpenAPI（上櫃全名單）
  "query1.finance.yahoo.com",   // Yahoo Finance 歷史備援（2 年 K 線，無額度限制）
  "query2.finance.yahoo.com",   // Yahoo Finance 備援節點
]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age":       "86400",
};

const EDGE_CACHE_TTL_MS = 3000;   // 3 秒邊緣快取
const UPSTREAM_TIMEOUT_MS = 8000;

function corsJson(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" }
  });
}

export default {
  async fetch(request, env, ctx) {
    // ── 1. CORS preflight ──
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return corsJson(405, { error: "method not allowed" });
    }

    // ── 2. 解析目標 URL ──
    const reqUrl = new URL(request.url);

    // 健檢 endpoint
    if (reqUrl.pathname === "/health") {
      return corsJson(200, {
        ok: true,
        service: "qdp-proxy",
        version: "1.0",
        allowed_hosts: [...ALLOWED_HOSTS],
        ts: new Date().toISOString()
      });
    }

    const target = reqUrl.searchParams.get("url");
    if (!target) {
      return corsJson(400, { error: "missing ?url= parameter" });
    }

    let targetUrl;
    try { targetUrl = new URL(target); }
    catch { return corsJson(400, { error: "invalid url" }); }

    if (!["http:", "https:"].includes(targetUrl.protocol)) {
      return corsJson(400, { error: "only http(s) allowed" });
    }
    if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
      return corsJson(403, { error: `host not in allowlist: ${targetUrl.hostname}` });
    }

    // ── 3. 邊緣快取（正規化 URL — 去掉 cache-buster `_` 參數）──
    const normUrl = new URL(targetUrl.toString());
    normUrl.searchParams.delete("_");
    const cacheKey = new Request(normUrl.toString(), { method: "GET" });
    const cache = caches.default;

    const cached = await cache.match(cacheKey);
    if (cached) {
      const age = Date.now() - Number(cached.headers.get("x-cached-at") || 0);
      if (age < EDGE_CACHE_TTL_MS) {
        const h = new Headers(cached.headers);
        for (const [k, v] of Object.entries(CORS_HEADERS)) h.set(k, v);
        h.set("x-proxy-cache", "HIT");
        h.set("x-cache-age-ms", String(age));
        return new Response(cached.body, { status: cached.status, headers: h });
      }
    }

    // ── 4. 上游請求（含 timeout）──
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        method: "GET",
        signal: ctrl.signal,
        headers: {
          "User-Agent": "QDP-Terminal/3.2 (Cloudflare-Worker)",
          "Accept":     "application/json, text/plain, */*",
          "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        },
        // 不帶 cookie / referrer，純無狀態
        redirect: "follow",
      });
    } catch (e) {
      clearTimeout(tid);
      const isAbort = e.name === "AbortError";
      return corsJson(502, {
        error: isAbort ? "upstream timeout" : "upstream fetch failed",
        detail: e.message,
        upstream: targetUrl.hostname
      });
    }
    clearTimeout(tid);

    // ── 5. 包裝回應 ──
    const body = await upstream.arrayBuffer();
    const respHeaders = new Headers(CORS_HEADERS);
    const ct = upstream.headers.get("Content-Type") || "application/json; charset=utf-8";
    respHeaders.set("Content-Type", ct);
    respHeaders.set("x-cached-at", String(Date.now()));
    respHeaders.set("x-proxy-cache", "MISS");
    respHeaders.set("x-upstream-status", String(upstream.status));

    const response = new Response(body, {
      status: upstream.status,
      headers: respHeaders
    });

    // 200 才快取
    if (upstream.ok) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  }
};
