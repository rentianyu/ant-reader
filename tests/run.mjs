/** 核心逻辑单测：node tests/run.mjs */

import { parseFeed, parseXml, decodeEntities, discoverFeeds, child, childText } from '../src/feed-parser.js';
import { sanitizeHtml, htmlToText } from '../src/sanitize.js';
import { parseOpml } from '../src/feeds.js';
import { makePasswordRecord, verifyPassword, signSession, verifySession } from '../src/auth.js';

let pass = 0;
const fails = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; return; }
  fails.push(`${name}${extra ? ' → ' + extra : ''}`);
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ----------------------------- XML 基础 ----------------------------- */
{
  const root = parseXml(`<?xml version="1.0"?><a x="1"><b>hi &amp; you</b><c><![CDATA[<p>raw</p>]]></c></a>`);
  const a = root.children[0];
  eq('根节点名', a.name, 'a');
  eq('属性解析', a.attrs.x, '1');
  eq('实体解码', childText(a, 'b'), 'hi & you');
  eq('CDATA 原样', child(a, 'c').text, '<p>raw</p>');
}

{
  eq('数字实体', decodeEntities('&#20013;&#x6587;'), '中文');
  eq('未知实体保留', decodeEntities('&foo;'), '&foo;');
}

{
  const r = parseXml('<a><b x="va>l">1</b><c/></a>');
  eq('属性内含 > 不清断标签', child(r.children[0], 'b').attrs.x, 'va>l');
  eq('自闭合节点', child(r.children[0], 'c').children.length, 0);
}

/* ------------------------------- RSS 2.0 ------------------------------- */
const rss2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>阮一峰的网络日志</title>
  <link>https://www.ruanyifeng.com/blog/</link>
  <description>科技爱好者周刊</description>
  <item>
    <title>周刊第 415 期</title>
    <link>/blog/2026/10/weekly-415.html</link>
    <guid isPermaLink="false">tag:ruanyf,2026:415</guid>
    <pubDate>Fri, 23 Oct 2026 08:00:00 +0800</pubDate>
    <author>ruanyf</author>
    <description><![CDATA[<p>本期内容 <b>很精彩</b></p>]]></description>
    <content:encoded><![CDATA[<p>正文 <script>alert(1)</script>内容</p>]]></content:encoded>
  </item>
</channel>
</rss>`;
{
  const f = parseFeed(rss2, 'https://www.ruanyifeng.com/blog/atom.xml');
  eq('RSS 标题', f.title, '阮一峰的网络日志');
  eq('RSS 站点', f.siteUrl, 'https://www.ruanyifeng.com/blog/');
  eq('RSS 条目数', f.items.length, 1);
  eq('RSS guid', f.items[0].guid, 'tag:ruanyf,2026:415');
  eq('RSS 相对链接补全', f.items[0].link, 'https://www.ruanyifeng.com/blog/2026/10/weekly-415.html');
  ok('RSS 时间解析', typeof f.items[0].publishedAt === 'number' && f.items[0].publishedAt > 0);
  ok('RSS 正文含 script（存入后再净化）', f.items[0].content.includes('<script>'));
  eq('RSS 摘要去标签', f.items[0].summary, '本期内容 很精彩');
}

/* -------------------------------- Atom -------------------------------- */
const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>少数派</title>
  <subtitle>高效工作，品质生活</subtitle>
  <link href="https://sspai.com"/>
  <icon>https://sspai.com/favicon.ico</icon>
  <entry>
    <title>一篇 Atom 文章</title>
    <link rel="alternate" href="https://sspai.com/post/1"/>
    <id>https://sspai.com/post/1</id>
    <published>2026-10-20T10:00:00Z</published>
    <updated>2026-10-21T10:00:00Z</updated>
    <author><name>小王</name></author>
    <summary>摘要文本</summary>
    <content type="html">&lt;p&gt;正文段落&lt;/p&gt;</content>
  </entry>
</feed>`;
{
  const f = parseFeed(atom, 'https://sspai.com/feed');
  eq('Atom 标题', f.title, '少数派');
  eq('Atom 站点', f.siteUrl, 'https://sspai.com/');
  eq('Atom 图标', f.iconUrl, 'https://sspai.com/favicon.ico');
  eq('Atom 条目数', f.items.length, 1);
  eq('Atom 链接', f.items[0].link, 'https://sspai.com/post/1');
  eq('Atom 作者', f.items[0].author, '小王');
  ok('Atom 正文还原', f.items[0].content.includes('<p>正文段落</p>'), f.items[0].content);
}

/* ------------------------------ RSS 1.0 (RDF) ------------------------------ */
const rdf = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://example.com">
    <title>RDF 示例</title>
    <link>https://example.com</link>
  </channel>
  <item rdf:about="https://example.com/1">
    <title>RDF 文章</title>
    <link>https://example.com/1</link>
    <dc:date>2026-09-01T12:00:00Z</dc:date>
    <description>描述</description>
  </item>
</rdf:RDF>`;
{
  const f = parseFeed(rdf, 'https://example.com/rss');
  eq('RDF 标题', f.title, 'RDF 示例');
  eq('RDF 条目数', f.items.length, 1);
  eq('RDF guid 用 rdf:about', f.items[0].guid, 'https://example.com/1');
  ok('RDF 时间', f.items[0].publishedAt > 0);
}

/* ------------------------------ JSON Feed ------------------------------ */
const jsonFeed = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'JSON 源',
  home_page_url: 'https://jf.example.com',
  items: [{ id: '1', url: 'https://jf.example.com/1', title: 'JSON 文章', content_html: '<p>hi</p>', date_published: '2026-10-01T00:00:00Z', authors: [{ name: '小李' }] }],
});
{
  const f = parseFeed(jsonFeed, 'https://jf.example.com/feed.json');
  eq('JSON Feed 标题', f.title, 'JSON 源');
  eq('JSON Feed 条目', f.items.length, 1);
  eq('JSON Feed 作者', f.items[0].author, '小李');
}

/* ------------------------------ 异常输入 ------------------------------ */
{
  let threw = false;
  try { parseFeed('<html><body>不是 feed</body></html>', 'https://a.com'); } catch { threw = true; }
  ok('HTML 被判为无效 Feed', threw);

  let threw2 = false;
  try { parseFeed('', 'https://a.com'); } catch { threw2 = true; }
  ok('空响应报错', threw2);
}

/* ------------------------------ Feed 发现 ------------------------------ */
{
  const html = `<html><head><title>某某博客</title>
    <link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
    <link rel="stylesheet" href="/a.css">
  </head></html>`;
  const found = discoverFeeds(html, 'https://blog.example.com/post/1');
  eq('发现 feed 数量', found.length, 1);
  eq('发现 feed 绝对地址', found[0].url, 'https://blog.example.com/feed.xml');
}

/* ------------------------------ HTML 净化 ------------------------------ */
{
  const dirty = `<p onclick="evil()">正常</p>
    <script>alert(1)</script>
    <img src="/img/a.png" onerror="alert(2)" alt="图">
    <a href="javascript:alert(3)">坏链</a>
    <a href="/rel">相对链</a>
    <iframe src="https://evil.com"></iframe>
    <style>body{display:none}</style>
    <div style="text-align:center;background:url(javascript:alert(4))">居中</div>`;
  const clean = sanitizeHtml(dirty, 'https://site.com/post/');
  ok('移除 script 标签', !/<script/i.test(clean), clean);
  ok('移除 on* 属性', !/onerror|onclick/i.test(clean), clean);
  ok('移除 iframe', !/iframe/i.test(clean), clean);
  ok('移除 style 块', !/<style/i.test(clean), clean);
  ok('javascript: 链接被清除', !/javascript:/i.test(clean), clean);
  ok('相对图片转绝对', clean.includes('https://site.com/img/a.png'), clean);
  ok('相对链接转绝对', clean.includes('href="https://site.com/rel"'), clean);
  ok('外链加 noopener', clean.includes('rel="noopener noreferrer"'), clean);
  ok('保留安全 style', clean.includes('text-align:center'), clean);
  ok('img 加 lazy', clean.includes('loading="lazy"'), clean);
  eq('纯文本提取', htmlToText('<p>a</p><p>b &amp; c</p>'), 'a b & c');
}

/* -------------------------------- OPML -------------------------------- */
{
  const opmlText = `<?xml version="1.0"?>
<opml version="2.0"><head><title>x</title></head><body>
  <outline text="技术">
    <outline text="阮一峰" type="rss" xmlUrl="https://a.com/feed" htmlUrl="https://a.com"/>
    <outline text="少数派" type="rss" xmlUrl="https://b.com/feed"/>
  </outline>
  <outline text="独立博客" type="rss" xmlUrl="https://c.com/feed"/>
</body></opml>`;
  const list = parseOpml(opmlText);
  eq('OPML 条目数', list.length, 3);
  eq('OPML 分组归属', list[0].group, '技术');
  eq('OPML 未分组', list[2].group, null);
  eq('OPML 标题', list[1].title, '少数派');
}

/* -------------------------------- 认证 -------------------------------- */
{
  const rec = await makePasswordRecord('test1234');
  ok('密码记录格式', /^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(rec), rec);
  ok('正确密码通过', await verifyPassword('test1234', rec));
  ok('错误密码拒绝', !(await verifyPassword('test12345', rec)));
  ok('空记录拒绝', !(await verifyPassword('x', '')));

  const token = await signSession('secret-key');
  ok('会话校验通过', await verifySession('secret-key', token));
  ok('错误密钥拒绝', !(await verifySession('other-key', token)));
  ok('篡改载荷拒绝', !(await verifySession('secret-key', token.replace(/^./, 'x'))));
  ok('空 token 拒绝', !(await verifySession('secret-key', '')));
}

/* -------------------------------- 输出 -------------------------------- */
console.log(`\n${pass} 项通过，${fails.length} 项失败`);
if (fails.length) {
  console.log('\n失败项：');
  fails.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
