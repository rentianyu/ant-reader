/** HTTP API 路由 */

import * as db from './db.js';
import {
  COOKIE_NAME, buildSessionCookie, clearSessionCookie, makePasswordRecord,
  parseCookies, signSession, verifyPassword, verifySession,
} from './auth.js';
import { addFeed, exportOpml, importOpml, resolveFeed, syncFeed } from './feeds.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

export function fail(message, status = 400) {
  return json({ ok: false, error: message }, status);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requireAuth(request, env) {
  const cookies = parseCookies(request.headers.get('cookie'));
  const token = cookies[COOKIE_NAME];
  if (!token) return false;
  const secret = await db.ensureSecret(env);
  return verifySession(secret, token);
}

async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 生产环境走 https 带 Secure；本地 wrangler dev（http）不带头，便于调试 */
function sessionCookie(request, token) {
  const secure = new URL(request.url).protocol === 'https:';
  return buildSessionCookie(token, undefined, secure);
}

function clearedCookie(request) {
  return clearSessionCookie(new URL(request.url).protocol === 'https:');
}

export async function handleApi(request, env, url) {
  const method = request.method.toUpperCase();
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const q = url.searchParams;

  try {
    /* ---------------------------- 公共端点 ---------------------------- */

    if (path === '/health' && method === 'GET') {
      return json({ ok: true, service: 'ant-reader', time: Date.now() });
    }

    if (path === '/status' && method === 'GET') {
      const [st, authed] = await Promise.all([db.statusData(env.DB), requireAuth(request, env)]);
      return json({ ok: true, setup: st.setup, authed, counts: st.counts });
    }

    if (path === '/setup' && method === 'POST') {
      const hash = await db.getSetting(env.DB, 'password_hash');
      if (hash) return fail('已初始化，请直接登录', 409);
      const body = await readJson(request);
      const password = String(body?.password || '');
      if (password.length < 4) return fail('密码至少 4 位');
      await db.setSetting(env.DB, 'password_hash', await makePasswordRecord(password));
      const secret = await db.ensureSecret(env);
      const token = await signSession(secret);
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, token) });
    }

    if (path === '/login' && method === 'POST') {
      const body = await readJson(request);
      const password = String(body?.password || '');
      const stored = await db.getSetting(env.DB, 'password_hash');
      if (!stored) return fail('尚未初始化，请先设置密码', 428);
      const ok = await verifyPassword(password, stored);
      if (!ok) {
        await sleep(600);
        return fail('密码不正确', 401);
      }
      const secret = await db.ensureSecret(env);
      const token = await signSession(secret);
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, token) });
    }

    /* --------------------------- 以下需登录 --------------------------- */

    if (!(await requireAuth(request, env))) {
      return fail('未登录或会话已过期', 401);
    }

    if (path === '/logout' && method === 'POST') {
      return json({ ok: true }, 200, { 'set-cookie': clearedCookie(request) });
    }

    if (path === '/bootstrap' && method === 'GET') {
      const data = await db.bootstrapData(env.DB);
      return json({ ok: true, ...data });
    }

    if (path === '/password' && method === 'POST') {
      const body = await readJson(request);
      const stored = await db.getSetting(env.DB, 'password_hash');
      const okOld = await verifyPassword(String(body?.oldPassword || ''), stored || '');
      if (!okOld) return fail('原密码不正确', 401);
      const next = String(body?.newPassword || '');
      if (next.length < 4) return fail('新密码至少 4 位');
      await db.setSetting(env.DB, 'password_hash', await makePasswordRecord(next));
      const secret = await db.ensureSecret(env);
      const token = await signSession(secret);
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie(request, token) });
    }

    /* ------------------------------ 分组 ------------------------------ */

    if (path === '/groups' && method === 'POST') {
      const body = await readJson(request);
      const name = String(body?.name || '').trim();
      if (!name) return fail('分组名不能为空');
      const id = await db.createGroup(env.DB, name.slice(0, 60));
      return json({ ok: true, id, groups: await db.listGroups(env.DB) });
    }

    let m = /^\/groups\/(\d+)$/.exec(path);
    if (m) {
      const id = parseInt(m[1], 10);
      if (method === 'PATCH') {
        const body = await readJson(request);
        const name = String(body?.name || '').trim();
        if (!name) return fail('分组名不能为空');
        await env.DB.prepare('UPDATE groups SET name = ? WHERE id = ?').bind(name.slice(0, 60), id).run();
        return json({ ok: true, groups: await db.listGroups(env.DB) });
      }
      if (method === 'DELETE') {
        await env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(id).run();
        return json({ ok: true, groups: await db.listGroups(env.DB), feeds: await db.listFeeds(env.DB) });
      }
    }

    /* ------------------------------ 订阅源 ----------------------------- */

    if (path === '/feeds/discover' && method === 'POST') {
      const body = await readJson(request);
      const info = await resolveFeed(body?.url);
      return json({ ok: true, info });
    }

    if (path === '/feeds' && method === 'POST') {
      const body = await readJson(request);
      const result = await addFeed(env, {
        url: body?.url,
        groupId: body?.groupId ? parseInt(body.groupId, 10) : null,
        title: body?.title ? String(body.title).slice(0, 120) : '',
      });
      return json({ ok: true, ...result, feeds: await db.listFeeds(env.DB), groups: await db.listGroups(env.DB) });
    }

    m = /^\/feeds\/(\d+)$/.exec(path);
    if (m) {
      const id = parseInt(m[1], 10);
      const feed = await db.getFeed(env.DB, id);
      if (!feed) return fail('订阅不存在', 404);

      if (method === 'PATCH') {
        const body = await readJson(request);
        if (typeof body?.title === 'string') {
          await env.DB.prepare('UPDATE feeds SET title = ? WHERE id = ?').bind(body.title.trim().slice(0, 120), id).run();
        }
        if (body?.groupId !== undefined) {
          const gid = body.groupId ? parseInt(body.groupId, 10) : null;
          await env.DB.prepare('UPDATE feeds SET group_id = ? WHERE id = ?').bind(gid, id).run();
        }
        return json({ ok: true, feeds: await db.listFeeds(env.DB), groups: await db.listGroups(env.DB) });
      }
      if (method === 'DELETE') {
        await db.deleteFeed(env.DB, id);
        return json({ ok: true, feeds: await db.listFeeds(env.DB), groups: await db.listGroups(env.DB) });
      }
    }

    m = /^\/feeds\/(\d+)\/refresh$/.exec(path);
    if (m && method === 'POST') {
      const feed = await db.getFeed(env.DB, parseInt(m[1], 10));
      if (!feed) return fail('订阅不存在', 404);
      try {
        const r = await syncFeed(env, feed);
        return json({ ok: true, ...r, feeds: await db.listFeeds(env.DB) });
      } catch (err) {
        return json({ ok: false, error: String(err?.message || err), feeds: await db.listFeeds(env.DB) }, 502);
      }
    }

    m = /^\/feeds\/(\d+)\/read-all$/.exec(path);
    if (m && method === 'POST') {
      const changed = await db.markAllRead(env.DB, { feedId: parseInt(m[1], 10) });
      return json({ ok: true, changed, feeds: await db.listFeeds(env.DB), groups: await db.listGroups(env.DB) });
    }

    if (path === '/refresh' && method === 'POST') {
      const body = await readJson(request);
      const maxFeeds = Math.min(parseInt(body?.limit || 15, 10) || 15, 25);
      const targets = await db.feedsForRefresh(env.DB, maxFeeds);
      let added = 0;
      const errors = [];
      for (const feed of targets) {
        try {
          const r = await syncFeed(env, feed);
          added += r.added;
        } catch (err) {
          if (errors.length < 8) errors.push(`${feed.title || feed.url}：${String(err?.message || err)}`);
        }
      }
      return json({
        ok: true, refreshed: targets.length, added, errors,
        feeds: await db.listFeeds(env.DB), groups: await db.listGroups(env.DB),
      });
    }

    /* ------------------------------- 文章 ------------------------------ */

    if (path === '/items' && method === 'GET') {
      const result = await db.listItems(env.DB, {
        feedId: q.get('feed_id') ? parseInt(q.get('feed_id'), 10) : null,
        groupId: q.get('group_id') ? parseInt(q.get('group_id'), 10) : null,
        unreadOnly: q.get('unread') === '1',
        readOnly: q.get('read') === '1',
        starredOnly: q.get('starred') === '1',
        limit: Math.min(parseInt(q.get('limit') || '40', 10) || 40, 100),
        offset: Math.max(parseInt(q.get('offset') || '0', 10) || 0, 0),
        q: (q.get('q') || '').trim() || null,
        order: q.get('order') === 'desc' ? 'desc' : 'asc',
      });
      return json({ ok: true, ...result });
    }

    m = /^\/items\/(\d+)$/.exec(path);
    if (m) {
      const id = parseInt(m[1], 10);
      const item = await db.getItem(env.DB, id);
      if (!item) return fail('文章不存在', 404);
      if (method === 'GET') {
        return json({ ok: true, item });
      }
      if (method === 'PATCH') {
        const body = await readJson(request);
        if (body?.read !== undefined) await db.setItemRead(env.DB, id, !!body.read);
        if (body?.starred !== undefined) await db.setItemStar(env.DB, id, !!body.starred);
        const fresh = await db.getItem(env.DB, id);
        return json({ ok: true, item: fresh });
      }
    }

    if (path === '/read-all' && method === 'POST') {
      const body = await readJson(request);
      const changed = await db.markAllRead(env.DB, {
        feedId: body?.feedId ? parseInt(body.feedId, 10) : null,
        groupId: body?.groupId ? parseInt(body.groupId, 10) : null,
      });
      return json({ ok: true, changed, feeds: await db.listFeeds(env.DB), groups: await db.listGroups(env.DB) });
    }

    /* ------------------------------ OPML ------------------------------ */

    if (path === '/opml' && method === 'GET') {
      const xml = await exportOpml(env.DB);
      return new Response(xml, {
        headers: {
          'content-type': 'text/x-opml; charset=utf-8',
          'content-disposition': `attachment; filename="ant-reader-${new Date().toISOString().slice(0, 10)}.opml"`,
          'cache-control': 'no-store',
        },
      });
    }

    if (path === '/opml' && method === 'POST') {
      const text = await request.text();
      if (!/<opml/i.test(text)) return fail('不是有效的 OPML 文件');
      const stats = await importOpml(env, text);
      return json({ ok: true, ...stats, feeds: await db.listFeeds(env.DB), groups: await db.listGroups(env.DB) });
    }

    /* ------------------------------ 设置 ------------------------------ */

    if (path === '/settings' && method === 'PATCH') {
      const body = await readJson(request);
      if (body?.defaultFilter) {
        await db.setSetting(env.DB, 'default_filter', String(body.defaultFilter));
      }
      return json({
        ok: true,
        settings: {
          defaultFilter: await db.getSetting(env.DB, 'default_filter', 'all'),
        },
      });
    }

    return fail('接口不存在', 404);
  } catch (err) {
    console.error('API error', path, err);
    return fail(String(err?.message || err), 500);
  }
}
