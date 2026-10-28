/** D1 数据访问层 */

export function now() {
  return Date.now();
}

/* ------------------------------ settings ------------------------------ */

export async function getSetting(db, key, fallback = null) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? row.value : fallback;
}

export async function setSetting(db, key, value) {
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, String(value))
    .run();
}

/** 会话签名密钥：优先用环境变量，否则首次启动时落库（保证重启后会话不失效） */
export async function ensureSecret(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  let secret = await getSetting(env.DB, 'session_secret');
  if (!secret) {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    secret = Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
    await setSetting(env.DB, 'session_secret', secret);
  }
  return secret;
}

/* ------------------------------- groups ------------------------------- */

const SQL_GROUPS = `
  SELECT g.id, g.name, g.sort_order, g.created_at,
    (SELECT COUNT(*) FROM items i JOIN feeds f ON f.id = i.feed_id
      WHERE f.group_id = g.id AND i.is_read = 0) AS unread,
    (SELECT COUNT(*) FROM feeds f WHERE f.group_id = g.id) AS feed_count
  FROM groups g ORDER BY g.sort_order ASC, g.id ASC
`;

const SQL_FEEDS = `
  SELECT f.id, f.url, f.title, f.site_url, f.description, f.group_id,
         f.last_fetch_at, f.last_status, f.last_error, f.sort_order, f.created_at,
    (SELECT COUNT(*) FROM items i WHERE i.feed_id = f.id AND i.is_read = 0) AS unread,
    (SELECT COUNT(*) FROM items i WHERE i.feed_id = f.id) AS total,
    (SELECT MAX(published_at) FROM items i WHERE i.feed_id = f.id) AS last_pub
  FROM feeds f ORDER BY f.sort_order ASC, f.id ASC
`;

export async function listGroups(db) {
  const { results } = await db.prepare(SQL_GROUPS).all();
  return results || [];
}

export async function createGroup(db, name) {
  const sort = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS s FROM groups').first();
  const res = await db.prepare('INSERT INTO groups (name, sort_order, created_at) VALUES (?, ?, ?)')
    .bind(name, sort?.s || 1, now())
    .run();
  return res.meta?.last_row_id;
}

/* -------------------------------- feeds ------------------------------- */

export async function listFeeds(db) {
  const { results } = await db.prepare(SQL_FEEDS).all();
  return results || [];
}

export async function getFeed(db, id) {
  return db.prepare('SELECT * FROM feeds WHERE id = ?').bind(id).first();
}

export async function getFeedByUrl(db, url) {
  return db.prepare('SELECT * FROM feeds WHERE url = ?').bind(url).first();
}

export async function createFeed(db, { url, title, siteUrl, description, groupId }) {
  const sort = await db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS s FROM feeds').first();
  const res = await db.prepare(
    'INSERT INTO feeds (url, title, site_url, description, group_id, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(url, title || '', siteUrl || '', description || '', groupId || null, sort?.s || 1, now()).run();
  return res.meta?.last_row_id;
}

export async function updateFeedMeta(db, id, { title, siteUrl, description }) {
  await db.prepare('UPDATE feeds SET title = COALESCE(?, title), site_url = COALESCE(?, site_url), description = COALESCE(?, description) WHERE id = ?')
    .bind(title ?? null, siteUrl ?? null, description ?? null, id)
    .run();
}

export async function deleteFeed(db, id) {
  await db.prepare('DELETE FROM feeds WHERE id = ?').bind(id).run();
}

export async function markFeedFetch(db, id, status, error) {
  await db.prepare('UPDATE feeds SET last_fetch_at = ?, last_status = ?, last_error = ? WHERE id = ?')
    .bind(now(), status, error ? String(error).slice(0, 500) : null, id)
    .run();
}

/* -------------------------------- items ------------------------------- */

export async function insertItems(db, feedId, items) {
  if (!items.length) return 0;
  const ts = now();
  // 已存在则更新文本字段（源修正编码 / 改标题后能自愈），未读与收藏状态不动
  const stmts = items.map((it) => db.prepare(
    `INSERT INTO items (feed_id, guid, title, link, author, summary, content, published_at, fetched_at, is_read, is_starred)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
     ON CONFLICT(feed_id, guid) DO UPDATE SET
       title = excluded.title,
       link = excluded.link,
       author = excluded.author,
       summary = excluded.summary,
       content = excluded.content,
       published_at = COALESCE(excluded.published_at, items.published_at)
     WHERE items.title <> excluded.title OR items.content <> excluded.content`,
  ).bind(
    feedId, it.guid, it.title || '', it.link || '', it.author || '',
    it.summary || '', it.content || '', it.publishedAt || ts, ts,
  ));
  const results = await db.batch(stmts);
  return results.reduce((n, r) => n + (r.meta?.changes || 0), 0);
}

export async function listItems(db, opts = {}) {
  const { feedId, groupId, unreadOnly, readOnly, starredOnly, limit = 40, offset = 0, q, order = 'asc' } = opts;
  const where = [];
  const binds = [];
  if (feedId) { where.push('i.feed_id = ?'); binds.push(feedId); }
  if (groupId) { where.push('f.group_id = ?'); binds.push(groupId); }
  if (unreadOnly) where.push('i.is_read = 0');
  if (readOnly) where.push('i.is_read = 1');
  if (starredOnly) where.push('i.is_starred = 1');
  if (q) { where.push('(i.title LIKE ? OR i.summary LIKE ?)'); binds.push(`%${q}%`, `%${q}%`); }

  const dir = order === 'desc' ? 'DESC' : 'ASC';
  const sql = `
    SELECT i.id, i.feed_id, i.title, i.link, i.author, i.summary, i.published_at, i.fetched_at,
           i.is_read, i.is_starred, f.title AS feed_title, f.site_url AS feed_site_url
    FROM items i JOIN feeds f ON f.id = i.feed_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY COALESCE(i.published_at, i.fetched_at) ${dir}, i.id ${dir}
    LIMIT ? OFFSET ?
  `;
  const countSql = `
    SELECT COUNT(*) AS c FROM items i JOIN feeds f ON f.id = i.feed_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
  `;
  // 列表 + 总数合成一次 batch，减少跨区往返
  const [listRes, countRes] = await db.batch([
    db.prepare(sql).bind(...binds, limit, offset),
    db.prepare(countSql).bind(...binds),
  ]);
  return {
    items: listRes.results || [],
    total: countRes.results?.[0]?.c || 0,
  };
}

export async function getItem(db, id) {
  return db.prepare(`
    SELECT i.*, f.title AS feed_title, f.site_url AS feed_site_url
    FROM items i JOIN feeds f ON f.id = i.feed_id WHERE i.id = ?
  `).bind(id).first();
}

export async function setItemRead(db, id, read) {
  await db.prepare('UPDATE items SET is_read = ? WHERE id = ?').bind(read ? 1 : 0, id).run();
}

export async function setItemStar(db, id, starred) {
  await db.prepare('UPDATE items SET is_starred = ? WHERE id = ?').bind(starred ? 1 : 0, id).run();
}

export async function markAllRead(db, { feedId, groupId } = {}) {
  let sql = 'UPDATE items SET is_read = 1 WHERE is_read = 0';
  const binds = [];
  if (feedId) {
    sql = 'UPDATE items SET is_read = 1 WHERE is_read = 0 AND feed_id = ?';
    binds.push(feedId);
  } else if (groupId) {
    sql = 'UPDATE items SET is_read = 1 WHERE is_read = 0 AND feed_id IN (SELECT id FROM feeds WHERE group_id = ?)';
    binds.push(groupId);
  }
  const res = await db.prepare(sql).bind(...binds).run();
  return res.meta?.changes || 0;
}

/**
 * 把某篇文章及其更早的未读一次性标为已读。
 * 范围由 feedId / groupId 决定，都不传则为全部订阅；
 * minTs 是下界（前端传「当前已加载列表里最旧一条」的时间），避免误清视野外的历史。
 */
export async function markBefore(db, { itemId, feedId, groupId, minTs }) {
  const item = await db.prepare(
    'SELECT feed_id, COALESCE(published_at, fetched_at) AS ts FROM items WHERE id = ?',
  ).bind(itemId).first();
  if (!item) return { changed: 0, ts: null };

  let sql = 'UPDATE items SET is_read = 1 WHERE is_read = 0 AND COALESCE(published_at, fetched_at) <= ?';
  const binds = [item.ts];
  if (minTs) {
    sql += ' AND COALESCE(published_at, fetched_at) >= ?';
    binds.push(minTs);
  }
  if (feedId) {
    sql += ' AND feed_id = ?';
    binds.push(feedId);
  } else if (groupId) {
    sql += ' AND feed_id IN (SELECT id FROM feeds WHERE group_id = ?)';
    binds.push(groupId);
  }
  const res = await db.prepare(sql).bind(...binds).run();
  return { changed: res.meta?.changes || 0, ts: item.ts };
}

export async function trimFeedItems(db, feedId, keep = 300) {
  const res = await db.prepare(`
    DELETE FROM items
    WHERE feed_id = ?
      AND id NOT IN (
        SELECT id FROM items WHERE feed_id = ?
        ORDER BY COALESCE(published_at, fetched_at) DESC, id DESC
        LIMIT ?
      )
  `).bind(feedId, feedId, keep).run();
  return res.meta?.changes || 0;
}

export async function counts(db) {
  const unread = await db.prepare('SELECT COUNT(*) AS c FROM items WHERE is_read = 0').first();
  const starred = await db.prepare('SELECT COUNT(*) AS c FROM items WHERE is_starred = 1').first();
  const feeds = await db.prepare('SELECT COUNT(*) AS c FROM feeds').first();
  const items = await db.prepare('SELECT COUNT(*) AS c FROM items').first();
  return {
    unread: unread?.c || 0,
    starred: starred?.c || 0,
    feeds: feeds?.c || 0,
    items: items?.c || 0,
  };
}

/** 取最久未刷新的订阅源（cron 轮转用） */
export async function feedsForRefresh(db, limit = 40) {
  const { results } = await db.prepare(
    'SELECT * FROM feeds ORDER BY COALESCE(last_fetch_at, 0) ASC LIMIT ?',
  ).bind(limit).all();
  return results || [];
}

/* --------------------------- 聚合查询（单次往返） --------------------------- */

function countOf(res) {
  return res?.results?.[0]?.c || 0;
}

/** 首屏数据：分组 + 订阅源 + 计数 + 刷新间隔，一次 batch 拿全 */
export async function bootstrapData(db) {
  const res = await db.batch([
    db.prepare(SQL_GROUPS),
    db.prepare(SQL_FEEDS),
    db.prepare('SELECT COUNT(*) AS c FROM items WHERE is_read = 0'),
    db.prepare('SELECT COUNT(*) AS c FROM items WHERE is_starred = 1'),
    db.prepare('SELECT COUNT(*) AS c FROM feeds'),
    db.prepare('SELECT COUNT(*) AS c FROM items'),
  ]);
  return {
    groups: res[0].results || [],
    feeds: res[1].results || [],
    counts: {
      unread: countOf(res[2]),
      starred: countOf(res[3]),
      feeds: countOf(res[4]),
      items: countOf(res[5]),
    },
    settings: {},
  };
}

/** 登录页状态：是否已初始化 + 计数，一次 batch */
export async function statusData(db) {
  const res = await db.batch([
    db.prepare("SELECT value FROM settings WHERE key = 'password_hash'"),
    db.prepare('SELECT COUNT(*) AS c FROM items WHERE is_read = 0'),
    db.prepare('SELECT COUNT(*) AS c FROM items WHERE is_starred = 1'),
    db.prepare('SELECT COUNT(*) AS c FROM feeds'),
    db.prepare('SELECT COUNT(*) AS c FROM items'),
  ]);
  return {
    setup: !!res[0].results?.[0]?.value,
    counts: {
      unread: countOf(res[1]),
      starred: countOf(res[2]),
      feeds: countOf(res[3]),
      items: countOf(res[4]),
    },
  };
}
