PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feeds (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  url           TEXT    NOT NULL UNIQUE,
  title         TEXT    NOT NULL DEFAULT '',
  site_url      TEXT,
  description   TEXT,
  group_id      INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  last_fetch_at INTEGER,
  last_status   TEXT,
  last_error    TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  feed_id      INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid         TEXT    NOT NULL,
  title        TEXT    NOT NULL DEFAULT '',
  link         TEXT,
  author       TEXT,
  summary      TEXT,
  content      TEXT,
  published_at INTEGER,
  fetched_at   INTEGER NOT NULL,
  is_read      INTEGER NOT NULL DEFAULT 0,
  is_starred   INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_items_feed_guid ON items(feed_id, guid);
CREATE INDEX IF NOT EXISTS idx_items_feed_pub ON items(feed_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_pub      ON items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_read_pub ON items(is_read, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_star     ON items(is_starred, published_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
