/**
 * 零依赖 XML 解析 + RSS 2.0 / Atom 1.0 / RSS 1.0(RDF) / JSON Feed 归一化
 * 不依赖 DOM，可直接跑在 Workers 运行时与 Node 里（便于单测）。
 */

const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '\u00a9', reg: '\u00ae', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
  ldquo: '\u201c', rdquo: '\u201d', lsquo: '\u2018', rsquo: '\u2019',
  middot: '\u00b7', bull: '\u2022', deg: '\u00b0', laquo: '\u00ab', raquo: '\u00bb',
};

export function decodeEntities(s) {
  if (!s || s.indexOf('&') < 0) return s;
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent) => {
    if (ent[0] === '#') {
      const hex = ent[1] === 'x' || ent[1] === 'X';
      const code = parseInt(hex ? ent.slice(2) : ent.slice(1), hex ? 16 : 10);
      if (!isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const v = ENTITY_MAP[ent.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function escapeText(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;');
}

/**
 * 把 XML 文本解析成极简节点树。
 * 节点：{ name, attrs, children, text }  —— text 为该节点直属文本（含 CDATA，已反转义）
 */
export function parseXml(input) {
  const xml = String(input).replace(/^\uFEFF/, '');
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const n = xml.length;

  const addText = (s) => {
    if (!s) return;
    stack[stack.length - 1].text += decodeEntities(s);
  };

  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { addText(xml.slice(i)); break; }
    if (lt > i) addText(xml.slice(i, lt));

    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      stack[stack.length - 1].text += xml.slice(lt + 9, e < 0 ? n : e);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      const e = xml.indexOf('?>', lt + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (xml.startsWith('<!', lt)) {
      const e = xml.indexOf('>', lt + 2);
      i = e < 0 ? n : e + 1;
      continue;
    }

    // 找闭合的 '>'，跳过引号内内容
    let j = lt + 1;
    let quote = null;
    while (j < n) {
      const ch = xml[j];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
      j++;
    }
    if (j >= n) break;

    const raw = xml.slice(lt + 1, j);
    i = j + 1;

    if (raw[0] === '/') {
      const name = raw.slice(1).trim().toLowerCase();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name.toLowerCase() === name) { stack.length = k; break; }
      }
      continue;
    }

    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1) : raw;
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) continue;
    const name = m[1];

    const attrs = {};
    const attrRe = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let am;
    const attrStr = body.slice(name.length);
    while ((am = attrRe.exec(attrStr))) {
      const val = am[2] !== undefined ? am[2] : am[3] !== undefined ? am[3] : (am[4] || '');
      attrs[am[1]] = decodeEntities(val);
    }

    const node = { name, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

export function localName(name) {
  const k = String(name).indexOf(':');
  return k < 0 ? String(name) : String(name).slice(k + 1);
}

function sameName(nodeName, wanted) {
  const n = nodeName.toLowerCase();
  const w = wanted.toLowerCase();
  return n === w || localName(n) === w;
}

export function child(node, ...names) {
  if (!node || !node.children) return null;
  for (const c of node.children) {
    for (const w of names) if (sameName(c.name, w)) return c;
  }
  return null;
}

export function children(node, ...names) {
  if (!node || !node.children) return [];
  return node.children.filter((c) => names.some((w) => sameName(c.name, w)));
}

/** 节点文本：直属文本 + 所有子元素序列化（处理 title 里嵌 <div> 之类的脏数据） */
export function textOf(node) {
  if (!node) return '';
  let out = node.text || '';
  for (const c of node.children) out += serialize(c);
  return out.trim();
}

export function childText(node, ...names) {
  return textOf(child(node, ...names));
}

export function serialize(node) {
  if (!node) return '';
  const attrs = Object.entries(node.attrs || {})
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');
  const inner = escapeText(node.text || '') + (node.children || []).map(serialize).join('');
  return `<${node.name}${attrs}>${inner}</${node.name}>`;
}

function toTs(s) {
  if (!s) return null;
  const t = Date.parse(String(s).trim());
  return Number.isNaN(t) ? null : t;
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashString(str) {
  // FNV-1a 32bit，够做兜底 guid
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function absolutize(href, base) {
  if (!href) return href;
  const h = String(href).trim();
  if (!h || /^(https?:|mailto:|data:|javascript:|#)/i.test(h)) return h;
  try { return new URL(h, base).toString(); } catch { return h; }
}

/** URL 规范化（补全斜杠、解析相对地址）；失败时原样返回 */
function normalizeUrl(u, base) {
  const raw = String(u || '').trim();
  if (!raw) return '';
  try { return new URL(raw, base || 'https://example.invalid/').toString(); } catch { return raw; }
}

/* ------------------------------- RSS 2.0 ------------------------------- */

function parseRssChannel(channel, feedUrl) {
  const out = {
    title: childText(channel, 'title') || '',
    siteUrl: childText(channel, 'link') || '',
    description: stripTags(childText(channel, 'description')).slice(0, 500),
    iconUrl: '',
    items: [],
  };
  const image = child(channel, 'image');
  if (image) {
    out.iconUrl = childText(image, 'url');
    if (!out.siteUrl) out.siteUrl = childText(image, 'link');
  }
  if (!out.iconUrl) {
    const itunesImage = child(channel, 'itunes:image', 'image');
    if (itunesImage && itunesImage.attrs && itunesImage.attrs.href) {
      out.iconUrl = itunesImage.attrs.href;
    }
  }

  for (const node of children(channel, 'item')) {
    const title = stripTags(textOf(child(node, 'title'))).slice(0, 500);
    const link = absolutize(childText(node, 'link') || (child(node, 'guid')?.attrs?.isPermaLink !== 'false' ? childText(node, 'guid') : ''), feedUrl);
    const guid = childText(node, 'guid') || link || hashString(title + '|' + childText(node, 'pubDate'));
    const content = childText(node, 'content:encoded') || childText(node, 'description') || '';
    const summary = stripTags(childText(node, 'description')).slice(0, 800);
    const author = childText(node, 'author', 'dc:creator') || '';
    const published = toTs(childText(node, 'pubDate', 'dc:date', 'published', 'updated'));

    out.items.push({
      guid: String(guid).slice(0, 900),
      title: title || '(无标题)',
      link: link || '',
      author: stripTags(author).slice(0, 200),
      summary,
      content,
      publishedAt: published,
    });
  }
  return out;
}

/* -------------------------------- Atom -------------------------------- */

function atomLink(entry) {
  const links = children(entry, 'link');
  let alt = '';
  let self = '';
  for (const l of links) {
    const rel = (l.attrs?.rel || 'alternate').toLowerCase();
    const href = l.attrs?.href || l.text || '';
    if (rel === 'alternate' && !alt) alt = href;
    else if (rel === 'self' && !self) self = href;
  }
  return alt || self;
}

function parseAtomFeed(feedNode, feedUrl) {
  const out = {
    title: stripTags(childText(feedNode, 'title')) || '',
    siteUrl: atomLink(feedNode) || '',
    description: stripTags(childText(feedNode, 'subtitle')).slice(0, 500),
    iconUrl: childText(feedNode, 'icon', 'logo') || '',
    items: [],
  };

  for (const entry of children(feedNode, 'entry')) {
    const title = stripTags(textOf(child(entry, 'title'))).slice(0, 500);
    const link = absolutize(atomLink(entry), feedUrl);
    const guid = childText(entry, 'id') || link || hashString(title);
    const contentNode = child(entry, 'content');
    let content = contentNode ? textOf(contentNode) : '';
    if (!content) content = childText(entry, 'summary');
    const summary = stripTags(childText(entry, 'summary')).slice(0, 800) || stripTags(content).slice(0, 800);
    const authorNode = child(entry, 'author');
    const author = authorNode ? childText(authorNode, 'name') : '';
    const published = toTs(childText(entry, 'published') || childText(entry, 'updated'));

    out.items.push({
      guid: String(guid).slice(0, 900),
      title: title || '(无标题)',
      link: link || '',
      author: stripTags(author).slice(0, 200),
      summary,
      content,
      publishedAt: published,
    });
  }
  return out;
}

/* ----------------------------- RSS 1.0 / RDF ----------------------------- */

function parseRdfFeed(rdfNode, feedUrl) {
  const channel = child(rdfNode, 'channel') || rdfNode;
  const out = {
    title: stripTags(childText(channel, 'title')) || '',
    siteUrl: childText(channel, 'link') || '',
    description: stripTags(childText(channel, 'description')).slice(0, 500),
    iconUrl: '',
    items: [],
  };
  for (const node of children(rdfNode, 'item')) {
    const title = stripTags(textOf(child(node, 'title'))).slice(0, 500);
    const link = absolutize(childText(node, 'link'), feedUrl);
    const guid = childText(node, 'rdf:about') || (child(node, 'about')?.attrs?.rdf || '') || childText(node, 'about') || link || hashString(title);
    const content = childText(node, 'content:encoded') || childText(node, 'description') || '';
    out.items.push({
      guid: String(guid).slice(0, 900),
      title: title || '(无标题)',
      link: link || '',
      author: stripTags(childText(node, 'dc:creator')).slice(0, 200),
      summary: stripTags(childText(node, 'description')).slice(0, 800),
      content,
      publishedAt: toTs(childText(node, 'dc:date')),
    });
  }
  return out;
}

/* ------------------------------ JSON Feed ------------------------------ */

function parseJsonFeed(text, feedUrl) {
  const data = JSON.parse(text);
  const out = {
    title: stripTags(data.title) || '',
    siteUrl: data.home_page_url || '',
    description: stripTags(data.description).slice(0, 500),
    iconUrl: data.icon || data.favicon || '',
    items: [],
  };
  for (const it of data.items || []) {
    const title = stripTags(it.title) || '';
    const link = absolutize(it.url || it.external_url || '', feedUrl);
    const authors = Array.isArray(it.authors) ? it.authors.map((a) => a?.name).filter(Boolean).join(', ') : (it.author?.name || '');
    out.items.push({
      guid: String(it.id || link || hashString(title)).slice(0, 900),
      title: title || '(无标题)',
      link: link || '',
      author: stripTags(authors).slice(0, 200),
      summary: stripTags(it.summary).slice(0, 800),
      content: it.content_html || it.content_text || it.summary || '',
      publishedAt: toTs(it.date_published || it.date_modified),
    });
  }
  return out;
}

/* ------------------------------- 入口 -------------------------------- */

/**
 * 解析任意 feed 文本
 * @param {string} text  原始响应体
 * @param {string} feedUrl  用于补全相对链接
 * @returns {{title,siteUrl,description,iconUrl,items:Array}}
 */
export function parseFeed(text, feedUrl = '') {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw) throw new Error('响应为空');

  if (raw[0] === '{' || raw[0] === '[') {
    return parseJsonFeed(raw, feedUrl);
  }

  const root = parseXml(raw);
  const first = root.children.find((c) => c.name !== '#text');
  if (!first) throw new Error('无法识别的内容格式');

  const nm = first.name.toLowerCase();
  let result = null;

  if (nm === 'rss' || nm.endsWith(':rss')) {
    const channel = child(first, 'channel');
    if (!channel) throw new Error('RSS 缺少 channel');
    result = parseRssChannel(channel, feedUrl);
  } else if (nm === 'feed' || nm.endsWith(':feed') || children(first, 'entry').length) {
    result = parseAtomFeed(first, feedUrl);
  } else if (nm.includes('rdf')) {
    result = parseRdfFeed(first, feedUrl);
  } else if (nm === 'html' || nm === '!doctype') {
    throw new Error('这是一个网页，不是 Feed');
  } else {
    // 兜底：尝试当作 rss 处理
    const channel = child(first, 'channel') || first;
    if (children(channel, 'item').length) result = parseRssChannel(channel, feedUrl);
    else if (children(first, 'entry').length) result = parseAtomFeed(first, feedUrl);
  }

  if (!result) throw new Error('无法识别的 Feed 格式');

  result.siteUrl = normalizeUrl(result.siteUrl, feedUrl);
  result.iconUrl = result.iconUrl ? normalizeUrl(result.iconUrl, feedUrl) : '';
  result.title = String(result.title || '').trim();
  return result;
}

/** 从 HTML 里发现 feed 地址（用于「只填了站点首页」的场景） */
export function discoverFeeds(html, pageUrl) {
  const found = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const type = (/\btype\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1] || '';
    if (!/application\/(rss|atom|feed)\+xml|application\/json/i.test(type)) continue;
    const href = (/\bhref\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1] || '';
    if (!href) continue;
    const title = (/\btitle\s*=\s*["']([^"']*)["']/i.exec(tag) || [])[1] || '';
    const abs = absolutize(decodeEntities(href), pageUrl);
    if (abs && !found.some((f) => f.url === abs)) found.push({ url: abs, title: decodeEntities(title) });
  }
  return found;
}

/** 页面标题（发现 feed 后推断订阅名） */
export function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? stripTags(decodeEntities(m[1])).slice(0, 200) : '';
}

export { stripTags, hashString, toTs, absolutize };
