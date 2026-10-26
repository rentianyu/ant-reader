/**
 * 文章正文 HTML 净化：白名单标签 + 白名单属性 + 协议校验。
 * 目标不是学术级 sanitizer，而是在单用户场景下把 script/iframe/事件属性/危险协议全部剥掉。
 */

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup', 'dd', 'del', 'details',
  'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i',
  'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'picture', 'pre', 'q', 's', 'samp', 'small', 'source',
  'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
  'u', 'ul', 'video', 'audio',
]);

const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea',
  'link', 'meta', 'noscript', 'svg', 'canvas', 'applet', 'template',
]);

const ALLOWED_ATTRS = {
  '*': new Set(['class', 'title', 'dir', 'lang']),
  a: new Set(['href', 'target', 'rel']),
  img: new Set(['src', 'alt', 'width', 'height', 'loading', 'referrerpolicy', 'srcset']),
  source: new Set(['src', 'srcset', 'type', 'media']),
  video: new Set(['src', 'poster', 'controls', 'width', 'height', 'preload']),
  audio: new Set(['src', 'controls', 'preload']),
  td: new Set(['colspan', 'rowspan', 'align']),
  th: new Set(['colspan', 'rowspan', 'align', 'scope']),
  col: new Set(['span', 'width']),
  colgroup: new Set(['span', 'width']),
  details: new Set(['open']),
};

/** 允许保留受限 style 的标签 */
const STYLE_TAGS = new Set([
  'div', 'span', 'p', 'img', 'figure', 'figcaption', 'table', 'td', 'th', 'tr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'a', 'blockquote', 'pre',
]);

function safeUrl(url, base, allowData) {  const u = String(url || '').trim();
  if (!u) return '';
  if (/^data:/i.test(u)) return allowData && /^data:image\//i.test(u) ? u : '';
  if (/^(javascript|vbscript|file):/i.test(u)) return '';
  if (/^#/.test(u)) return u;
  try {
    const abs = new URL(u, base || 'https://example.invalid/');
    if (!/^(https?|mailto):$/i.test(abs.protocol)) return '';
    return abs.toString();
  } catch {
    return '';
  }
}

/**
 * @param {string} html 原始 HTML 片段
 * @param {string} baseUrl 用于相对链接补全
 */
export function sanitizeHtml(html, baseUrl = '') {
  let s = String(html || '');

  // 1. 去掉整块危险元素（含内容）
  for (const tag of DROP_WITH_CONTENT) {
    s = s.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    s = s.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

  // 2. 逐标签重写
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g, (full, rawName, rawAttrs) => {
    const name = rawName.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) return '';
    if (full.startsWith('</')) return `</${name}>`;

    const attrs = {};
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m;
    while ((m = attrRe.exec(rawAttrs))) {
      attrs[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : (m[4] || '');
    }

    const common = ALLOWED_ATTRS['*'];
    const specific = ALLOWED_ATTRS[name] || new Set();
    const outAttrs = [];

    // style 只保留极少安全子集（对齐/宽度/字重），其余丢弃
    if (STYLE_TAGS.has(name)) {
      const style = keepSafeStyle(attrs['style']);
      if (style) outAttrs.push(`style="${style}"`);
    }

    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('on')) continue;
      if (k === 'style') continue;
      if (!common.has(k) && !specific.has(k)) continue;
      if (k === 'href' || k === 'src' || k === 'poster') {
        const safe = safeUrl(v, baseUrl, k === 'src' || k === 'poster');
        if (!safe) continue;
        if (k === 'href') {
          outAttrs.push(`href="${escapeAttr(safe)}"`);
          outAttrs.push('target="_blank"');
          outAttrs.push('rel="noopener noreferrer"');
        } else {
          outAttrs.push(`${k}="${escapeAttr(safe)}"`);
        }
        continue;
      }
      if (k === 'srcset') {
        const set = v.split(',').map((part) => {
          const seg = part.trim().split(/\s+/);
          const url = safeUrl(seg[0], baseUrl, true);
          return url ? [url, ...seg.slice(1)].join(' ') : '';
        }).filter(Boolean).join(', ');
        if (set) outAttrs.push(`srcset="${escapeAttr(set)}"`);
        continue;
      }
      outAttrs.push(`${k}="${escapeAttr(v)}"`);
    }

    if (name === 'img') {
      if (!outAttrs.some((a) => a.startsWith('loading='))) outAttrs.push('loading="lazy"');
      if (!outAttrs.some((a) => a.startsWith('referrerpolicy='))) outAttrs.push('referrerpolicy="no-referrer"');
    }

    return `<${name}${outAttrs.length ? ' ' + outAttrs.join(' ') : ''}>`;
  });

  return s.trim();
}

function keepSafeStyle(style) {
  if (!style) return '';
  const keep = [];
  for (const decl of String(style).split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (!val || /expression|url\s*\(|javascript|@import/i.test(val)) continue;
    if (/^(text-align|width|height|max-width|vertical-align|margin|padding|font-weight|font-style|text-decoration|border-radius)$/.test(prop)) {
      keep.push(`${prop}:${val}`);
    }
  }
  return keep.join(';');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 纯文本摘要 */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
