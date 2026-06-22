-- QDP API — D1 schema
-- 執行：wrangler d1 execute qdp-db --remote --file=./schema.sql

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
