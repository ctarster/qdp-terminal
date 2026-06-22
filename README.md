# QDP Terminal — 機構級台股量化決策終端

純前端單檔股票分析工具（`app.html`），搭配 Cloudflare Workers 後端（CORS 代理 + 帳號/雲端同步）。

## 架構

```
GitHub Pages  →  app.html（前端，靜態）
                      │  瀏覽器呼叫
                      ▼
Cloudflare Workers
  • worker.js      CORS 代理（即時報價 / 歷史備援）
  • api-worker.js  帳號系統 + 雲端同步 + 共用訓練池（D1 資料庫）
```

> **GitHub Pages 只跑得動前端 `app.html`。** 後端兩個 Worker 必須部署到 Cloudflare（見下方）。

## 前端部署（GitHub Pages）

1. 把這個倉庫推到 GitHub（Public）。
2. Repo → **Settings → Pages → Build and deployment → Source: Deploy from a branch**，
   Branch 選 `main` / 資料夾 `/ (root)`，Save。
3. 約 1 分鐘後得到網址：`https://<你的帳號>.github.io/<倉庫名>/`
   （根目錄的 `index.html` 會自動轉址到 `app.html`。）

## 後端部署（Cloudflare Workers）

需要 [wrangler](https://developers.cloudflare.com/workers/wrangler/)：

```bash
npm i -g wrangler && wrangler login

# 1) CORS 代理
wrangler deploy worker.js --name qdp-proxy

# 2) 帳號 / 同步 API（需 D1）
wrangler d1 create qdp-db                 # 把回傳的 database_id 填進 wrangler.toml
wrangler d1 execute qdp-db --remote --file=./schema.sql
wrangler secret put AUTH_SECRET           # 輸入一段夠長的隨機字串
wrangler deploy
```

部署完成後，到 app 右上 **⚙ 設定** 填入：
- **FinMind Token**（提高歷史資料額度）
- **API 伺服器網址**（你的 `qdp-api.*.workers.dev`，啟用帳號雲端同步）

## 隱私

- 不含任何金鑰：`AUTH_SECRET` 是 Cloudflare secret、FinMind token 存在使用者瀏覽器，皆**不在原始碼裡**。
- 未登入時所有資料只存在使用者本機 `localStorage`。

> 量化模型僅供參考，非投資建議。
