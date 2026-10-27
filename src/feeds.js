/** 抓取、同步、Feed 地址发现、OPML 导入导出 */

import { parseFeed, discoverFeeds, pageTitle } from './feed-parser.js';
import { sanitizeHtml, htmlToText } from './sanitize.js';
import {
  createFeed, createGroup, getFeed, getFeedByUrl, insertItems, listFeeds, listGroups,
  markFeedFetch, trimFeedItems, updateFeedMeta,
} from './db.js';

export const UA = 'Mozilla/5.0 (compatible; AntReader/1.1; +https://ant.xbta.cc)';
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_ITEMS_PER_FETCH = 100;
const MAX_CONTENT_CHARS = 200000;
/** 每个源保留的历史条数上限 */
const FEED_KEEP_ITEMS = 300;

/** 读取响应体字节（不解码），上限 maxBytes */
async function readLimited(res, maxBytes = MAX_BYTES) {
  const declared = parseInt(res.headers.get('content-length') || '0', 10);
  if (declared && declared > maxBytes) throw new Error(`响应过大（${Math.round(declared / 1024)}KB）`);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error('响应过大，已中断');
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return buf;
}

/**
 * 探测编码：Content-Type → XML 声明 → HTML meta → 默认 UTF-8。
 * 不少国内论坛（如 52pojie/Discuz）的 RSS 仍是 GBK，按 UTF-8 解码会全是乱码。
 */
function detectCharset(buf, contentType) {
  const ct = String(contentType || '');
  const m = /charset\s*=\s*["']?([\w.-]+)/i.exec(ct);
  if (m) return m[1].toLowerCase();

  const head = new TextDecoder('latin1').decode(buf.slice(0, 512));
  const m2 = /<\?xml[^>]*encoding\s*=\s*["']([\w.-]+)["']/i.exec(head);
  if (m2) return m2[1].toLowerCase();

  const m3 = /<meta[^>]*charset\s*=\s*["']?([\w.-]+)/i.exec(head);
  if (m3) return m3[1].toLowerCase();

  return 'utf-8';
}

/** 按探测到的编码解码；GB2312/GBK 统一用超集 GB18030 */
function decodeBody(buf, contentType) {
  let cs = detectCharset(buf, contentType);
  if (/^gb(2312|k|18030)$/i.test(cs)) cs = 'gb18030';
  try {
    return new TextDecoder(cs, { fatal: false }).decode(buf);
  } catch {
    try { return new TextDecoder('gb18030').decode(buf); } catch { /* 继续回退 */ }
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
}

async function fetchOnce(url) {
  return fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, application/json;q=0.8, text/html;q=0.7, */*;q=0.5',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
}

/** 去掉正文里的源站模板残留：「>」引用符号、「[查看全文]」之类 */
function trimLeadingQuote(html) {
  return String(html || '')
    .replace(/(<p[^>]*>|<br\s*\/?>|^)(?:\s*(?:&gt;|>)\s*)+/gi, '$1')
    .replace(/[\[【(（]\s*(?:查看全文|阅读原文|阅读全文|查看原文)\s*[\]】)）]/gi, '');
}

/**
 * 清理摘要里的冗余噪声：开头的孤立符号、结尾的「查看全文」类模板文字。
 * 只处理摘要，正文保持原样。
 */
function cleanSummary(s) {
  return String(s || '')
    .replace(/^(?:[>»›\-–—·|｜\s])+/, '')
    .replace(/\s*(?:查看全文|阅读全文|阅读原文|查看原文|点击查看|here)\.?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把解析结果写入库
 * @returns {{added:number, total:number}}
 */
export async function syncFeed(env, feed) {
  let res;
  try {
    res = await fetchOnce(feed.url);
  } catch (err) {
    await markFeedFetch(env.DB, feed.id, 'error', `抓取失败：${err?.message || err}`);
    throw new Error(`抓取失败：${err?.message || err}`);
  }

  if (!res.ok) {
    await markFeedFetch(env.DB, feed.id, 'error', `HTTP ${res.status}`);
    throw new Error(`HTTP ${res.status}`);
  }

  const text = decodeBody(await readLimited(res), res.headers.get('content-type'));
  let parsed;
  try {
    parsed = parseFeed(text, feed.url);
  } catch (err) {
    await markFeedFetch(env.DB, feed.id, 'error', `解析失败：${err?.message || err}`);
    throw new Error(`解析失败：${err?.message || err}`);
  }

  const base = feed.site_url || parsed.siteUrl || feed.url;
  const prepared = parsed.items
    .slice(0, MAX_ITEMS_PER_FETCH)
    .map((it) => {
      const rawContent = it.content || it.summary || '';
      const content = trimLeadingQuote(sanitizeHtml(rawContent, it.link || base)).slice(0, MAX_CONTENT_CHARS);
      const summary = cleanSummary(it.summary || htmlToText(content)).slice(0, 500);
      return { ...it, content, summary };
    });

  const added = await insertItems(env.DB, feed.id, prepared);

  // 每个源只保留最近 FEED_KEEP_ITEMS 条
  const trimmed = await trimFeedItems(env.DB, feed.id, FEED_KEEP_ITEMS);

  if (!feed.title && parsed.title) {
    await updateFeedMeta(env.DB, feed.id, {
      title: parsed.title,
      siteUrl: parsed.siteUrl || feed.site_url,
    });
  }
  await markFeedFetch(env.DB, feed.id, 'ok', null);
  return { added, trimmed, total: prepared.length };
}

/**
 * 发现 Feed 地址：直接把输入当 feed 试；失败则抓 HTML 找 <link rel="alternate">
 */
export async function resolveFeed(inputUrl) {
  let url = String(inputUrl || '').trim();
  if (!url) throw new Error('请输入订阅地址');
  // OPML / 网页复制常带 HTML 实体，&amp; 会让 query 参数失效
  url = url.replace(/&amp;/gi, '&').replace(/&#0*38;/g, '&').replace(/&quot;/gi, '"').trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { throw new Error('地址格式不正确'); }
  if (!/^https?:$/.test(parsedUrl.protocol)) throw new Error('只支持 http/https 地址');

  let res;
  try {
    res = await fetchOnce(parsedUrl.toString());
  } catch (err) {
    throw new Error(`无法访问该地址：${err?.message || err}`);
  }
  if (!res.ok) throw new Error(`无法访问该地址：HTTP ${res.status}`);

  const text = decodeBody(await readLimited(res), res.headers.get('content-type'));
  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  // 1) 直接当 feed 解析
  try {
    const parsed = parseFeed(text, parsedUrl.toString());
    if (parsed.items.length || parsed.title) {
      return {
        feedUrl: parsedUrl.toString(),
        title: parsed.title || parsedUrl.hostname,
        siteUrl: parsed.siteUrl || parsedUrl.origin,
        description: parsed.description || '',
        itemCount: parsed.items.length,
        preview: parsed.items.slice(0, 3).map((i) => i.title),
      };
    }
  } catch {
    // 继续按网页处理
  }

  // 2) 当作网页，找 feed link
  if (contentType.includes('html') || /<html/i.test(text.slice(0, 2000))) {
    const found = discoverFeeds(text, parsedUrl.toString());
    if (found.length) {
      const first = found[0];
      const r2 = await fetchOnce(first.url);
      if (r2.ok) {
        const t2 = decodeBody(await readLimited(r2), r2.headers.get('content-type'));
        try {
          const parsed = parseFeed(t2, first.url);
          return {
            feedUrl: first.url,
            title: parsed.title || first.title || pageTitle(text) || parsedUrl.hostname,
            siteUrl: parsed.siteUrl || parsedUrl.origin,
            description: parsed.description || '',
            itemCount: parsed.items.length,
            preview: parsed.items.slice(0, 3).map((i) => i.title),
            candidates: found.map((f) => f.url),
          };
        } catch {
          // 落到下面的错误
        }
      }
    }
  }

  throw new Error('该地址不是有效的 RSS/Atom/JSON Feed，也没有找到可用的订阅链接');
}

export async function addFeed(env, { url, groupId, title }) {
  const info = await resolveFeed(url);
  const existing = await getFeedByUrl(env.DB, info.feedUrl);
  if (existing) throw new Error(`该订阅已存在：${existing.title || existing.url}`);

  const feedId = await createFeed(env.DB, {
    url: info.feedUrl,
    title: title || info.title,
    siteUrl: info.siteUrl,
    description: info.description,
    groupId: groupId || null,
  });
  const feed = await getFeed(env.DB, feedId);
  let synced = { added: 0, total: 0 };
  try { synced = await syncFeed(env, feed); } catch { /* 首次抓取失败不阻断添加 */ }
  return { feed: await getFeed(env.DB, feedId), info, synced };
}

/* -------------------------------- OPML -------------------------------- */

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export async function exportOpml(db) {
  const groups = await listGroups(db);
  const feeds = await listFeeds(db);
  const byGroup = new Map();
  for (const f of feeds) {
    const key = f.group_id || 0;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(f);
  }

  const line = (f, indent) => `${indent}<outline text="${escapeXml(f.title || f.url)}" title="${escapeXml(f.title || f.url)}" type="rss" xmlUrl="${escapeXml(f.url)}" htmlUrl="${escapeXml(f.site_url || '')}" />`;

  const parts = [];
  for (const g of groups) {
    const list = byGroup.get(g.id) || [];
    if (!list.length) continue;
    parts.push(`    <outline text="${escapeXml(g.name)}" title="${escapeXml(g.name)}">`);
    for (const f of list) parts.push(line(f, '      '));
    parts.push('    </outline>');
  }
  for (const f of byGroup.get(0) || []) parts.push(line(f, '    '));

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Ant Reader 订阅</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
    <generator>Ant Reader 1.0</generator>
  </head>
  <body>
${parts.join('\n')}
  </body>
</opml>`;
}

/** 从 OPML 文本提取 {groupName|null, url, title} 列表（支持多层嵌套分组） */
export function parseOpml(text) {
  const out = [];
  const stack = [];
  const bodyStart = text.search(/<body[^>]*>/i);
  const src = bodyStart >= 0 ? text.slice(bodyStart) : text;
  const re = /<(\/?)\s*outline\b([^>]*?)(\/?)>/gi;
  const decode = (s) => String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

  let m;
  while ((m = re.exec(src))) {
    const isClose = m[1] === '/';
    const selfClose = m[3] === '/';
    if (isClose) { stack.pop(); continue; }

    const attrs = {};
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = attrRe.exec(m[2]))) {
      attrs[a[1].toLowerCase()] = a[2] !== undefined ? a[2] : a[3];
    }

    const xmlUrl = decode(attrs.xmlurl || '').trim();
    const label = decode(attrs.text || attrs.title || '').trim();

    if (xmlUrl) {
      out.push({ url: xmlUrl, title: label, group: stack.length ? stack[stack.length - 1] : null });
    } else if (!selfClose) {
      stack.push(label);
    }
  }
  return out;
}

/** 批量导入（返回统计） */
export async function importOpml(env, text) {
  const entries = parseOpml(text);
  const groups = await listGroups(env.DB);
  const groupMap = new Map(groups.map((g) => [g.name, g.id]));
  let added = 0, skipped = 0, failed = 0;
  const errors = [];

  for (const e of entries) {
    let groupId = null;
    if (e.group) {
      if (!groupMap.has(e.group)) {
        const id = await createGroup(env.DB, e.group);
        groupMap.set(e.group, id);
      }
      groupId = groupMap.get(e.group);
    }
    try {
      const existing = await getFeedByUrl(env.DB, e.url);
      if (existing) { skipped++; continue; }
      const info = await resolveFeed(e.url);
      const dup = await getFeedByUrl(env.DB, info.feedUrl);
      if (dup) { skipped++; continue; }
      await createFeed(env.DB, {
        url: info.feedUrl,
        title: e.title || info.title,
        siteUrl: info.siteUrl,
        description: info.description,
        groupId,
      });
      added++;
    } catch (err) {
      failed++;
      if (errors.length < 10) errors.push(`${e.title || e.url}：${err?.message || err}`);
    }
  }
  return { total: entries.length, added, skipped, failed, errors };
}
