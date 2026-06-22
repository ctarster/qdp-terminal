/* ════════════════════════════════════════════════════════════════════
   QDP Terminal — Account / Sync API  (Cloudflare Worker + D1)
   ────────────────────────────────────────────────────────────────────
   提供：
     • 帳號系統：註冊 / 登入（PBKDF2 雜湊密碼 + HMAC 簽章 token）
     • 雲端同步：自選清單 / 警報 / 預測紀錄（archive）跨裝置共用
     • 共用訓練池：跨「使用者 × 股票」的因子→報酬樣本（修「訓練不局限於追蹤股票」）
   與既有 worker.js（CORS 代理）分開部署；本 worker 需綁定 D1 + 一個密鑰。

   ── 部署步驟（wrangler）─────────────────────────────────────────────
     1. npm i -g wrangler && wrangler login
     2. wrangler d1 create qdp-db
        # 把回傳的 database_id 填進下方 wrangler.toml
     3. wrangler d1 execute qdp-db --remote --file=./schema.sql
     4. wrangler secret put AUTH_SECRET      # 輸入一段夠長的隨機字串
     5. wrangler deploy
   部署後會得到 https://qdp-api.<你的子網域>.workers.dev
   再把該網址填進前端設定（⚙ 設定 → API 伺服器網址），或設為預設值。

   wrangler.toml 範例：
     name = "qdp-api"
     main = "api-worker.js"
     compatibility_date = "2024-09-01"
     [[d1_databases]]
     binding = "DB"
     database_name = "qdp-db"
     database_id = "<填入步驟2的 id>"

   schema.sql 內容見檔案最下方註解。
═════════════════════════════════════════════════════════════════════ */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};
const POOL_CAP = 6000;   // 共用訓練池上限（超過砍最舊）

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

/* ── 工具：base64url ── */
const b64u = {
  enc(buf) {
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    let s = ""; for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  encStr(str) { return b64u.enc(new TextEncoder().encode(str)); },
  decToStr(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return atob(s);
  },
};

/* ── 密碼雜湊：PBKDF2-SHA256（150k iters）── */
async function hashPassword(password, saltHex) {
  const salt = saltHex
    ? Uint8Array.from(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 150000 }, key, 256
  );
  const hashHex = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
  const sHex = [...salt].map(b => b.toString(16).padStart(2, "0")).join("");
  return { hashHex, saltHex: sHex };
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ── token：base64url(payload).base64url(HMAC-SHA256) ── */
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return b64u.enc(sig);
}
async function signToken(secret, payload) {
  const body = b64u.encStr(JSON.stringify(payload));
  const sig = await hmac(secret, body);
  return `${body}.${sig}`;
}
async function verifyToken(secret, token) {
  if (!token || token.indexOf(".") < 0) return null;
  const [body, sig] = token.split(".");
  const expect = await hmac(secret, body);
  if (!timingSafeEqual(sig, expect)) return null;
  try {
    const payload = JSON.parse(b64u.decToStr(body));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}
function bearer(req) {
  const h = req.headers.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}
async function authUser(req, env) {
  const secret = env.AUTH_SECRET || "dev-insecure-secret-change-me";
  return await verifyToken(secret, bearer(req));
}

const USER_RE = /^[A-Za-z0-9_\.\-]{3,32}$/;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const secret = env.AUTH_SECRET || "dev-insecure-secret-change-me";

    if (!env.DB) return json(500, { error: "D1 未綁定（請在 wrangler.toml 設定 [[d1_databases]] binding=DB）" });

    try {
      // ── 健檢 ──
      if (path === "/" || path === "/health") {
        return json(200, { ok: true, service: "qdp-api", ts: new Date().toISOString() });
      }

      // ── 註冊 ──
      if (path === "/auth/register" && request.method === "POST") {
        const { username, password } = await request.json();
        if (!USER_RE.test(username || "")) return json(400, { error: "帳號需 3~32 字（英數 . _ -）" });
        if (!password || password.length < 6) return json(400, { error: "密碼至少 6 碼" });
        const exists = await env.DB.prepare("SELECT id FROM users WHERE username=?").bind(username).first();
        if (exists) return json(409, { error: "帳號已存在" });
        const { hashHex, saltHex } = await hashPassword(password);
        const now = Date.now();
        const res = await env.DB.prepare(
          "INSERT INTO users (username, pw_hash, pw_salt, created_at) VALUES (?,?,?,?)"
        ).bind(username, hashHex, saltHex, now).run();
        const uid = res.meta.last_row_id;
        await env.DB.prepare("INSERT INTO user_data (user_id, watchlist, alerts, archive, updated_at) VALUES (?,?,?,?,?)")
          .bind(uid, "[]", "[]", "{}", now).run();
        const token = await signToken(secret, { uid, username, exp: now + 90 * 86400000 });
        return json(200, { token, user: { id: uid, username } });
      }

      // ── 登入 ──
      if (path === "/auth/login" && request.method === "POST") {
        const { username, password } = await request.json();
        const row = await env.DB.prepare("SELECT id, pw_hash, pw_salt FROM users WHERE username=?").bind(username || "").first();
        if (!row) return json(401, { error: "帳號或密碼錯誤" });
        const { hashHex } = await hashPassword(password || "", row.pw_salt);
        if (!timingSafeEqual(hashHex, row.pw_hash)) return json(401, { error: "帳號或密碼錯誤" });
        const token = await signToken(secret, { uid: row.id, username, exp: Date.now() + 90 * 86400000 });
        return json(200, { token, user: { id: row.id, username } });
      }

      // ── 我是誰 ──
      if (path === "/auth/me" && request.method === "GET") {
        const u = await authUser(request, env);
        if (!u) return json(401, { error: "未登入或 token 失效" });
        return json(200, { user: { id: u.uid, username: u.username } });
      }

      // ── 拉取雲端資料 ──
      if (path === "/sync" && request.method === "GET") {
        const u = await authUser(request, env);
        if (!u) return json(401, { error: "未登入" });
        const d = await env.DB.prepare("SELECT watchlist, alerts, archive, updated_at FROM user_data WHERE user_id=?").bind(u.uid).first();
        return json(200, {
          watchlist: JSON.parse(d?.watchlist || "[]"),
          alerts: JSON.parse(d?.alerts || "[]"),
          archive: JSON.parse(d?.archive || "{}"),
          updatedAt: d?.updated_at || 0,
        });
      }

      // ── 上傳/合併雲端資料 ──
      if (path === "/sync" && request.method === "PUT") {
        const u = await authUser(request, env);
        if (!u) return json(401, { error: "未登入" });
        const body = await request.json();
        const now = Date.now();
        await env.DB.prepare(
          "INSERT INTO user_data (user_id, watchlist, alerts, archive, updated_at) VALUES (?,?,?,?,?) " +
          "ON CONFLICT(user_id) DO UPDATE SET watchlist=excluded.watchlist, alerts=excluded.alerts, archive=excluded.archive, updated_at=excluded.updated_at"
        ).bind(
          u.uid,
          JSON.stringify(body.watchlist || []),
          JSON.stringify(body.alerts || []),
          JSON.stringify(body.archive || {}),
          now
        ).run();
        return json(200, { ok: true, updatedAt: now });
      }

      // ── 共用訓練池：拉取 ──
      if (path === "/pool" && request.method === "GET") {
        const rows = await env.DB.prepare("SELECT sample, target FROM pool ORDER BY id DESC LIMIT 3000").all();
        const samples = [], targets = [];
        for (const r of (rows.results || [])) { try { samples.push(JSON.parse(r.sample)); targets.push(r.target); } catch {} }
        return json(200, { samples, targets, n: samples.length });
      }

      // ── 共用訓練池：貢獻（登入後才可寫，避免濫用）──
      if (path === "/pool/contribute" && request.method === "POST") {
        const u = await authUser(request, env);
        if (!u) return json(401, { error: "未登入" });
        const body = await request.json();
        const samples = Array.isArray(body.samples) ? body.samples.slice(0, 80) : [];
        const targets = Array.isArray(body.targets) ? body.targets : [];
        if (!samples.length) return json(400, { error: "無樣本" });
        const now = Date.now();
        const stmts = samples.map((s, i) =>
          env.DB.prepare("INSERT INTO pool (sample, target, created_at) VALUES (?,?,?)")
            .bind(JSON.stringify(s), Number(targets[i]) || 0, now)
        );
        await env.DB.batch(stmts);
        // 容量控制：超過上限刪最舊
        await env.DB.prepare(
          "DELETE FROM pool WHERE id IN (SELECT id FROM pool ORDER BY id ASC LIMIT MAX(0,(SELECT COUNT(*) FROM pool)-?))"
        ).bind(POOL_CAP).run();
        return json(200, { ok: true, added: samples.length });
      }

      return json(404, { error: "not found", path });
    } catch (e) {
      return json(500, { error: "server error", detail: String(e && e.message || e) });
    }
  },
};

/* ════════════════════════════════════════════════════════════════════
   schema.sql（執行：wrangler d1 execute qdp-db --remote --file=./schema.sql）

   CREATE TABLE IF NOT EXISTS users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     username TEXT UNIQUE NOT NULL,
     pw_hash TEXT NOT NULL,
     pw_salt TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS user_data (
     user_id INTEGER PRIMARY KEY,
     watchlist TEXT,
     alerts TEXT,
     archive TEXT,
     updated_at INTEGER
   );
   CREATE TABLE IF NOT EXISTS pool (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     sample TEXT NOT NULL,
     target REAL NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_pool_id ON pool(id);
═════════════════════════════════════════════════════════════════════ */
