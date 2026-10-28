/* 蚁读 · 前端应用（原生 JS，无构建） */
(() => {
  'use strict';

  /* ------------------------------ 状态 ------------------------------ */
  const state = {
    setup: false,
    authed: false,
    groups: [],
    feeds: [],
    counts: { unread: 0, starred: 0, feeds: 0, items: 0 },
    settings: {},
    scope: { type: 'all', id: null },
    filter: 'all',
    items: [],
    total: 0,
    current: null,
    collapsed: new Set(),
    loading: false,
    expandedId: null,
    itemCache: new Map(),
    loadedCount: 0,
    hasMore: true,
  };

  const $ = (sel) => document.querySelector(sel);
  const el = {
    authView: $('#auth-view'),
    authSub: $('#auth-sub'),
    authForm: $('#auth-form'),
    authPass: $('#auth-pass'),
    authPass2: $('#auth-pass2'),
    authSubmit: $('#auth-submit'),
    authErr: $('#auth-err'),
    main: $('#main-view'),
    srcScroll: $('#src-list'),
    srcContainer: $('#src-container'),
    ptrSrc: $('#ptr-src'),
    itemScroll: $('#item-list'),
    itemContainer: $('#item-container'),
    ptr: $('#ptr'),
    listTitle: $('#list-title'),
    listMore: $('#list-more'),
    btnMore: $('#btn-more'),
    latestTip: $('#latest-tip'),
    readerBody: $('#reader-body'),
    readerScroll: $('#reader-scroll'),
    segbar: $('#segbar'),
    menu: $('#menu'),
    toast: $('#toast'),
    modalAdd: $('#modal-add'),
    modalManage: $('#modal-manage'),
    modalNewGroup: $('#modal-newgroup'),
    modalSettings: $('#modal-settings'),
    modalFeed: $('#modal-feed'),
  };

  const DEFAULT_ICON = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 9.5h9M7.5 12.5h9M7.5 15.5h5"/></svg>`;
  const ICONS = {
    all: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 6.5h16M4 12h16M4 17.5h10"/></svg>`,
    unread: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/></svg>`,
    star: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3.6l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z"/></svg>`,
    folder: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3.5 7.5a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z"/></svg>`,
  };

  /* ------------------------------ 工具 ------------------------------ */
  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const pad = (n) => String(n).padStart(2, '0');

  /** 摘要去噪：开头的孤立符号 + 结尾的「查看全文」类模板文字 */
  const cleanText = (s) => String(s || '')
    .replace(/^(?:[>»›\-–—·|｜\s])+/, '')
    .replace(/\s*(?:查看全文|阅读全文|阅读原文|查看原文|点击查看)\.?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const STAR_SVG = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 3.6l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z"/></svg>`;

  /** HTML → 纯文本（保留段落换行），用于列表内展开预览 */
  const htmlToPlain = (html) => String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const EXPAND_HTML_LIMIT = 15000;

  /** 展开区内容：优先渲染 HTML（保留图片与段落），过长时按段落截断 */
  function expandedBody(item) {
    const html = String(item.content || '').trim();
    if (html) return `<div class="it-more-html">${clampHtml(tidyHtml(html))}</div>`;
    const text = cleanText(item.summary || '');
    if (text) return `<div class="it-more-html">${escapeHtml(text)}</div>`;
    return `<div class="it-more-html" style="color:var(--text-3)">这篇没有正文，点「原文」去看完整内容。</div>`;
  }

  /** 去掉源站模板残留：段首的「>」引用符号、「[查看全文]」之类 */
  function tidyHtml(html) {
    return String(html)
      .replace(/(<p[^>]*>|<br\s*\/?>|^)(?:\s*(?:&gt;|>)\s*)+/gi, '$1')
      .replace(/[\[【(（]\s*(?:查看全文|阅读原文|阅读全文|查看原文)\s*[\]】)）]/gi, '');
  }

  function clampHtml(html) {
    if (html.length <= EXPAND_HTML_LIMIT) return html;
    const cut = html.slice(0, EXPAND_HTML_LIMIT);
    const lastP = cut.lastIndexOf('</p>');
    const base = lastP > EXPAND_HTML_LIMIT * 0.5 ? cut.slice(0, lastP + 4) : cut;
    return `${base}<p style="color:var(--text-4);font-size:12px">…… 内容较长，点「原文」看完整版</p>`;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return '昨天';
    if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function fmtFull(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const isMobile = () => window.matchMedia('(max-width: 899px)').matches;

  let toastTimer = null;
  function toast(msg, ms = 2200) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
  }

  async function api(path, opts = {}) {
    const init = {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: {},
    };
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    if (opts.raw) {
      init.body = opts.raw;
      init.headers['content-type'] = 'text/xml';
    }
    const res = await fetch('/api' + path, init);
    let data = {};
    try { data = await res.json(); } catch { /* 非 JSON */ }
    if (res.status === 401) {
      showAuth(false);
      throw new Error(data.error || '需要登录');
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || `请求失败（${res.status}）`);
    }
    return data;
  }

  /* ------------------------------ 视图切换 ------------------------------ */
  function setView(view) {
    if (document.body.dataset.view === view) return;
    document.body.dataset.view = view;
    if (isMobile()) history.pushState({ view }, '');
  }
  window.addEventListener('popstate', (e) => {
    document.body.dataset.view = (e.state && e.state.view) || 'sources';
  });

  /* ------------------------------ 登录 ------------------------------ */
  function showAuth(setupMode) {
    el.main.hidden = true;
    el.authView.hidden = false;
    state.setup = !!setupMode && !state.setup ? true : state.setup;
    const isSetup = !state.setupIsDone;
    el.authSub.textContent = isSetup ? '首次使用，设置一个访问密码' : '输入访问密码';
    el.authPass2.hidden = !isSetup;
    el.authSubmit.textContent = isSetup ? '设置并进入' : '进入';
    el.authPass.value = '';
    el.authPass2.value = '';
    el.authErr.textContent = '';
    setTimeout(() => el.authPass.focus(), 80);
  }

  el.authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pwd = el.authPass.value;
    el.authErr.textContent = '';
    if (!pwd) { el.authErr.textContent = '请输入密码'; return; }
    try {
      el.authSubmit.disabled = true;
      if (!state.setupIsDone) {
        if (pwd.length < 4) { el.authErr.textContent = '密码至少 4 位'; return; }
        if (pwd !== el.authPass2.value) { el.authErr.textContent = '两次输入不一致'; return; }
        await api('/setup', { method: 'POST', body: { password: pwd } });
        state.setupIsDone = true;
      } else {
        await api('/login', { method: 'POST', body: { password: pwd } });
      }
      await enterApp();
    } catch (err) {
      el.authErr.textContent = err.message;
    } finally {
      el.authSubmit.disabled = false;
    }
  });

  async function enterApp() {
    el.authView.hidden = true;
    el.main.hidden = false;
    const data = await api('/bootstrap');
    state.groups = data.groups || [];
    state.feeds = data.feeds || [];
    state.counts = data.counts || state.counts;
    state.settings = data.settings || state.settings;
    renderSources();
    await selectScope({ type: 'all' }, { silent: true, keepView: true });
  }

  /* ------------------------------ 订阅源渲染 ------------------------------ */
  /** 有未读的源排前面，其余按最近更新时间倒序 */
  function sortFeeds(list) {
    return [...list].sort((a, b) => {
      const ua = (a.unread || 0) > 0 ? 0 : 1;
      const ub = (b.unread || 0) > 0 ? 0 : 1;
      if (ua !== ub) return ua - ub;
      const ta = a.last_pub || a.last_fetch_at || 0;
      const tb = b.last_pub || b.last_fetch_at || 0;
      return tb - ta;
    });
  }

  function renderSources() {
    const parts = [];

    parts.push(srcEntryHtml({
      key: 'all', icon: ICONS.all, name: '全部文章', badge: null,
      active: state.scope.type === 'all' && state.filter !== 'starred',
      time: '',
    }));
    parts.push(srcEntryHtml({
      key: 'starred', icon: ICONS.star, name: '收藏', badge: state.counts.starred || null,
      active: state.scope.type === 'all' && state.filter === 'starred',
      time: '',
    }));

    const byGroup = new Map();
    const ungrouped = [];
    for (const f of state.feeds) {
      if (f.group_id) {
        if (!byGroup.has(f.group_id)) byGroup.set(f.group_id, []);
        byGroup.get(f.group_id).push(f);
      } else ungrouped.push(f);
    }

    for (const g of state.groups) {
      const list = byGroup.get(g.id) || [];
      parts.push(`<div class="src-group ${state.collapsed.has(g.id) ? 'collapsed' : ''}" data-group="${g.id}">
        <span class="caret"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></span>
        <span class="src-group-name">${escapeHtml(g.name)}</span>
        <span class="src-group-count">${list.length}</span>
      </div>`);
      if (!state.collapsed.has(g.id)) {
        for (const f of sortFeeds(list)) parts.push(feedEntryHtml(f));
      }
    }
    if (ungrouped.length) {
      if (state.groups.length) parts.push(`<div class="src-group"><span class="caret"></span><span class="src-group-name">未分组</span></div>`);
      for (const f of sortFeeds(ungrouped)) parts.push(feedEntryHtml(f));
    }

    if (!state.feeds.length) {
      parts.push(`<div class="src-empty"><span class="big">还没有订阅</span>点右上角 ＋ 添加第一个 RSS 源</div>`);
    }

    el.srcContainer.innerHTML = parts.join('');
  }

  function srcEntryHtml({ key, icon, name, badge, active, time }) {
    return `<div class="src-entry ${active ? 'active' : ''} ${badge ? 'unread' : ''}" data-scope="${key}">
      <span class="se-icon">${icon}</span>
      <span class="se-name">${escapeHtml(name)}</span>
      ${badge ? `<span class="se-badge">${badge > 99 ? '99+' : badge}</span>` : ''}
      <span class="se-time">${time || ''}</span>
    </div>`;
  }

  function feedEntryHtml(f) {
    const active = state.scope.type === 'feed' && state.scope.id === f.id;
    return `<div class="src-entry ${active ? 'active' : ''} ${f.unread ? 'unread' : ''}" data-scope="feed" data-id="${f.id}">
      <span class="se-icon">${DEFAULT_ICON}</span>
      <span class="se-name">${escapeHtml(f.title || f.url)}</span>
      ${f.unread ? `<span class="se-badge">${f.unread > 99 ? '99+' : f.unread}</span>` : ''}
      <span class="se-time">${fmtTime(f.last_pub || f.last_fetch_at)}</span>
    </div>`;
  }

  el.srcScroll.addEventListener('click', (e) => {
    const groupHead = e.target.closest('.src-group');
    if (groupHead && groupHead.dataset.group) {
      const id = parseInt(groupHead.dataset.group, 10);
      if (state.collapsed.has(id)) state.collapsed.delete(id);
      else state.collapsed.add(id);
      renderSources();
      return;
    }
    const entry = e.target.closest('.src-entry');
    if (!entry) return;
    const scope = entry.dataset.scope;
    if (scope === 'feed') {
      selectScope({ type: 'feed', id: parseInt(entry.dataset.id, 10) });
    } else if (scope === 'unread') {
      state.filter = 'unread';
      selectScope({ type: 'all' });
    } else if (scope === 'starred') {
      state.filter = 'starred';
      selectScope({ type: 'all' });
    } else {
      state.filter = 'all';
      selectScope({ type: 'all' });
    }
  });

  /* ------------------------------ 选择范围 ------------------------------ */
  async function selectScope(scope, opts = {}) {
    state.scope = scope;
    if (!opts.keepFilter && scope.type !== 'all') state.filter = 'all';
    renderSources();
    updateListTitle();
    updateSegbar();
    if (!opts.silent) {
      state.current = null;
      el.readerBody.innerHTML = `<div class="empty">选择一篇文章开始阅读</div>`;
    }
    if (isMobile() && !opts.keepView) setView('list');
    await loadItems();
  }

  function scopeTitle() {
    const { scope, filter } = state;
    if (scope.type === 'feed') {
      const f = state.feeds.find((x) => x.id === scope.id);
      return f ? (f.title || f.url) : '订阅';
    }
    if (scope.type === 'group') {
      const g = state.groups.find((x) => x.id === scope.id);
      return g ? g.name : '分组';
    }
    if (filter === 'unread') return '未读';
    if (filter === 'starred') return '收藏';
    return '全部文章';
  }

  function updateListTitle() {
    el.listTitle.textContent = scopeTitle();
    const infoBtn = $('#btn-feed-info');
    if (infoBtn) infoBtn.hidden = state.scope.type !== 'feed';
  }

  function updateSegbar() {
    el.segbar.querySelectorAll('.seg-item').forEach((b) => {
      b.classList.toggle('on', b.dataset.filter === state.filter);
    });
  }

  el.segbar.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-item');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    updateSegbar();
    renderSources();
    updateListTitle();
    loadItems();
  });

  /* ------------------------------ 文章列表 ------------------------------ */

  const PAGE_SIZE = 40;

  function buildParams(extra) {
    const p = new URLSearchParams();
    if (state.scope.type === 'feed') p.set('feed_id', state.scope.id);
    if (state.scope.type === 'group') p.set('group_id', state.scope.id);
    p.set('limit', String(PAGE_SIZE));
    for (const [k, v] of Object.entries(extra || {})) p.set(k, String(v));
    return p;
  }

  /**
   * 打开列表时的定位：把「最旧的一条未读」顶到屏幕上边缘，方便从断点续读；
   * 若当前列表里没有未读，则落到底部（最新一篇）。
   */
  let suppressScrollLoad = 0;

  function scrollToFirstUnread() {
    const box = el.itemScroll;
    const place = () => {
      const first = el.itemContainer.querySelector('.item.unread');
      if (!first) {
        box.scrollTop = box.scrollHeight;
        return;
      }
      const offset = first.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      box.scrollTop = Math.max(0, offset - 6);
    };
    place();
    suppressScrollLoad = Date.now() + 700;
    // 视图刚切换/字体排版未稳时首帧可能测不准，稍后再校一次
    setTimeout(() => {
      place();
      suppressScrollLoad = Date.now() + 500;
    }, 130);
  }

  /**
   * 加载文章。
   * 「全部」：纯时间序，旧的在上、新的在下。首屏取最新一页（desc 取回后反转），打开即滚到底部；
   *          向上滚到接近顶部时再取更早的一页，插到列表前面并保持当前可视位置。
   * 「未读」「收藏」：正序分页，向下滚到底追加。
   */
  async function loadItems(more = false) {
    if (state.loading) return;
    state.loading = true;
    try {
      if (!more) {
        state.items = [];
        state.expandedId = null;
        state.hasMore = true;
        state.loadedCount = 0;

        if (state.filter === 'all') {
          const p = buildParams({ offset: 0 });
          p.set('order', 'desc');
          const data = await api(`/items?${p.toString()}`);
          state.items = data.items.slice().reverse();
          state.total = data.total;
          state.loadedCount = data.items.length;
          state.hasMore = state.loadedCount < state.total;
          renderItems();
          scrollToFirstUnread();
          return;
        }

        const p = buildParams({ offset: 0 });
        if (state.filter === 'unread') p.set('unread', '1');
        if (state.filter === 'starred') p.set('starred', '1');
        const data = await api(`/items?${p.toString()}`);
        state.items = data.items;
        state.total = data.total;
        state.hasMore = data.items.length < data.total;
        renderItems();
        return;
      }

      if (state.filter !== 'all') {
        if (!state.hasMore) return;
        const p = buildParams({ offset: state.items.length });
        if (state.filter === 'unread') p.set('unread', '1');
        if (state.filter === 'starred') p.set('starred', '1');
        const data = await api(`/items?${p.toString()}`);
        state.items = state.items.concat(data.items);
        state.total = data.total;
        state.hasMore = state.items.length < data.total;
        renderItems();
        return;
      }

      // 「全部」：向前加载更早的文章
      if (!state.hasMore) return;
      const p = buildParams({ offset: state.loadedCount });
      p.set('order', 'desc');
      const data = await api(`/items?${p.toString()}`);
      if (!data.items.length) {
        state.hasMore = false;
        return;
      }
      const older = data.items.slice().reverse();
      const box = el.itemScroll;
      const prevH = box.scrollHeight;
      const prevTop = box.scrollTop;
      state.items = older.concat(state.items);
      state.loadedCount += data.items.length;
      state.hasMore = state.loadedCount < state.total;
      renderItems();
      box.scrollTop = prevTop + (box.scrollHeight - prevH);
    } catch (err) {
      el.itemContainer.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    } finally {
      state.loading = false;
      maybeAutoLoad();
    }
  }

  /** 列表内容不足一屏时自动续载（全部=继续往前加载更早的文章，填满一屏为止） */
  let autoLoadDepth = 0;
  function maybeAutoLoad() {
    // 时间序列表（全部）：首屏定位到最旧未读，不再自动向前补历史，避免刚打开就往前翻
    if (state.filter === 'all') return;
    if (state.loading || !state.hasMore) return;
    if (autoLoadDepth > 10) return;
    const box = el.itemScroll;
    if (box.scrollHeight > box.clientHeight + 60) return;
    autoLoadDepth++;
    loadItems(true).finally(() => {
      autoLoadDepth = Math.max(0, autoLoadDepth - 1);
      maybeAutoLoad();
    });
  }

  /* 滚动加载：全部=滚到接近顶部时向前补更早的；未读/收藏=滚到底部追加 */
  let scrollLock = false;
  el.itemScroll.addEventListener('scroll', () => {
    if (scrollLock || state.loading || Date.now() < suppressScrollLoad) return;
    const { scrollTop, clientHeight, scrollHeight } = el.itemScroll;
    if (state.filter === 'all') {
      if (scrollTop > 260) return;
    } else if (scrollTop + clientHeight < scrollHeight - 240) {
      return;
    }
    scrollLock = true;
    loadItems(true).finally(() => {
      setTimeout(() => { scrollLock = false; }, 450);
    });
  }, { passive: true });

  function renderItems() {
    if (!state.items.length) {
      el.itemContainer.innerHTML = `<div class="empty"><span class="big">这里没有文章</span>${state.filter === 'unread' ? '所有文章都读完了' : '换个筛选条件或刷新试试'}</div>`;
      el.listMore.hidden = true;
      return;
    }

    const showFeedMini = state.scope.type !== 'feed';
    const out = [];

    for (const it of state.items) {
      const active = state.current && state.current.id === it.id;
      const expanded = state.expandedId === it.id;
      out.push(`<div class="item ${it.is_read ? '' : 'unread'} ${active ? 'active' : ''} ${expanded ? 'expanded' : ''}" data-id="${it.id}" data-pub="${escapeHtml(it.published_at || it.fetched_at || '')}" role="button" tabindex="0">
        <div class="it-top">
          <div class="it-title">${escapeHtml(it.title || '(无标题)')}</div>
          <div class="it-side">
            <span class="it-time">${fmtTime(it.published_at || it.fetched_at)}</span>
            <span class="it-feed-mini ${showFeedMini ? 'show' : ''}">${escapeHtml(it.feed_title || '')}</span>
          </div>
        </div>
        <div class="it-meta">
          <span class="it-feed">${escapeHtml(it.feed_title || '')}</span>
          ${it.author ? `<span class="sep">·</span><span>${escapeHtml(it.author)}</span>` : ''}
          ${it.is_starred ? `<span class="it-star">${STAR_SVG}</span>` : ''}
        </div>
        ${it.summary ? `<div class="it-summary">${escapeHtml(cleanText(it.summary))}</div>` : ''}
        ${expanded ? renderExpanded(it) : ''}
      </div>`);
    }

    el.itemContainer.innerHTML = out.join('');
    if (state.filter === 'all') {
      // 时间正序列表：底部就是最新，没有「加载更多」，更早的靠向上滚动
      el.listMore.hidden = false;
      el.btnMore.hidden = true;
      el.latestTip.hidden = false;
    } else {
      el.latestTip.hidden = true;
      el.btnMore.hidden = false;
      el.listMore.hidden = !state.hasMore;
    }
  }

  function renderExpanded(it) {
    const cached = state.itemCache.get(it.id);
    const body = cached
      ? expandedBody(cached)
      : `<div class="it-more-text" style="color:var(--text-3)">加载中…</div>`;
    return `<div class="it-more">
      <div data-more-body="${it.id}">${body}</div>
      <div class="it-more-foot">
        <span class="it-more-hint">点卡片打开原文</span>
        <button class="it-act ${it.is_starred ? 'on' : ''}" data-act="star" data-id="${it.id}">${it.is_starred ? '已收藏' : '收藏'}</button>
        <button class="it-act" data-act="open" data-id="${it.id}">原文 ↗</button>
      </div>
    </div>`;
  }

  /* ------------------------- 移动端原地展开 ------------------------- */

  /**
   * 展开后限制正文高度：保证卡片下方至少露出下一条（约 58px）。
   * 卡片本身太靠下时，先把它滚到视口顶部，腾出空间。
   */
  function fitExpandedCard(id) {
    const card = document.querySelector(`.item.expanded[data-id="${id}"]`);
    if (!card) return;
    const holder = card.querySelector('.it-more-html, .it-more-text');
    if (!holder) return;

    const box = el.itemScroll;
    const listRect = box.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();

    // 剩余空间不足（卡片太靠下）：先滚到顶部再算
    if (listRect.bottom - cardRect.top < 420) {
      const delta = cardRect.top - listRect.top;
      if (Math.abs(delta) > 4) {
        // 展开时的自动滚动不算「用户滚到顶部」，别顺手触发加载更早
        suppressScrollLoad = Date.now() + 900;
        box.scrollTo({ top: Math.max(0, box.scrollTop + delta - 6), behavior: 'smooth' });
      }
      setTimeout(() => fitExpandedCard(id), 340);
      return;
    }

    holder.style.maxHeight = '';
    const holderH = holder.getBoundingClientRect().height;
    const chromeH = Math.max(0, cardRect.height - holderH); // 标题 + 元信息 + 底部按钮 + padding
    const hasNext = !!card.nextElementSibling;
    const reserve = hasNext ? 58 : 14;
    const avail = listRect.bottom - cardRect.top - chromeH - reserve;
    holder.style.maxHeight = Math.max(120, Math.round(avail)) + 'px';
  }

  async function expandItem(id) {
    state.expandedId = id;
    suppressScrollLoad = Date.now() + 900;
    renderItems();
    markItemRead(id);
    setTimeout(() => fitExpandedCard(id), 40);
    if (state.itemCache.has(id)) return;
    try {
      const data = await api(`/items/${id}`);
      state.itemCache.set(id, data.item);
      const holder = document.querySelector(`[data-more-body="${id}"]`);
      if (holder && state.expandedId === id) {
        holder.innerHTML = expandedBody(data.item);
        fitExpandedCard(id);
      }
    } catch (err) {
      const holder = document.querySelector(`[data-more-body="${id}"]`);
      if (holder) holder.innerHTML = `<div class="it-more-text" style="color:var(--danger)">${escapeHtml(err.message)}</div>`;
    }
  }

  /**
   * 点击某篇：把它以及列表中比它更旧的未读一起标为已读（「读到这里」）。
   * 下界取当前已加载列表中最旧的一条，避免误清视野之外的历史。
   * 影响面过大（>30 篇）时先确认，防止误点清掉一大片。
   */
  async function markItemRead(id) {
    const idx = state.items.findIndex((x) => x.id === id);
    if (idx < 0) return;

    let willChange = 0;
    for (let i = 0; i <= idx; i++) if (!state.items[i].is_read) willChange++;
    if (!willChange) return;
    if (willChange > 30 && !confirm(`将把 ${willChange} 篇文章标为已读，确定？`)) return;

    for (let i = 0; i <= idx; i++) {
      const it = state.items[i];
      if (it.is_read) continue;
      it.is_read = 1;
      const f = state.feeds.find((x) => x.id === it.feed_id);
      if (f && f.unread > 0) f.unread -= 1;
    }
    state.counts.unread = Math.max(0, (state.counts.unread || 0) - willChange);
    renderItems();
    renderSources();

    const first = state.items[0];
    const body = { itemId: id, minTs: first ? (first.published_at || first.fetched_at || null) : null };
    if (state.scope.type === 'feed') body.feedId = state.scope.id;
    else if (state.scope.type === 'group') body.groupId = state.scope.id;
    try {
      const r = await api('/read-before', { method: 'POST', body });
      if (r.feeds) state.feeds = r.feeds;
      if (r.groups) state.groups = r.groups;
      state.counts.unread = state.feeds.reduce((s, f) => s + (f.unread || 0), 0);
      renderSources();
    } catch {
      /* 网络失败时本地已更新，下次加载会校准 */
    }
  }

  function openOriginal(id) {
    const row = state.items.find((x) => x.id === id);
    const cached = state.itemCache.get(id);
    const link = (cached && cached.link) || (row && row.link) || '';
    if (!link) { toast('这篇没有原文链接'); return; }
    window.open(link, '_blank', 'noopener');
  }

  async function toggleStarItem(id) {
    const row = state.items.find((x) => x.id === id);
    if (!row) return;
    const next = row.is_starred ? 0 : 1;
    row.is_starred = next;
    state.counts.starred = Math.max(0, (state.counts.starred || 0) + (next ? 1 : -1));
    const cached = state.itemCache.get(id);
    if (cached) cached.is_starred = next;
    renderItems();
    renderSources();
    try {
      await api(`/items/${id}`, { method: 'PATCH', body: { starred: !!next } });
      toast(next ? '已收藏' : '已取消收藏', 1200);
    } catch (err) { toast(err.message); }
  }

  el.itemContainer.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act) {
      e.stopPropagation();
      const actId = parseInt(act.dataset.id, 10);
      if (act.dataset.act === 'star') toggleStarItem(actId);
      else if (act.dataset.act === 'open') openOriginal(actId);
      return;
    }
    const card = e.target.closest('.item');
    if (!card) return;
    const id = parseInt(card.dataset.id, 10);
    // 桌面与手机一致：第一次就地展开看正文，再点一次打开原文
    if (state.expandedId === id) openOriginal(id);
    else expandItem(id);
  });

  el.itemContainer.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.item');
    if (!card) return;
    e.preventDefault();
    card.click();
  });

  $('#btn-more').addEventListener('click', () => loadItems(true));

  /* ------------------------------ 打开文章 ------------------------------ */
  /** 桌面端：点击文章在右栏渲染正文 */
  async function openItem(id) {
    try {
      let item = state.itemCache.get(id);
      if (!item) {
        const data = await api(`/items/${id}`);
        item = data.item;
        state.itemCache.set(id, item);
      }
      state.current = item;
      renderReader(item);
      markItemRead(id);
      const row = state.items.find((x) => x.id === id);
      if (row) row.is_read = 1;
      renderItems();
      el.readerScroll.scrollTop = 0;
    } catch (err) {
      toast(err.message);
    }
  }

  function renderReader(item) {
    const meta = [];
    if (item.feed_title) {
      const href = item.feed_site_url || '#';
      meta.push(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(item.feed_title)}</a>`);
    }
    if (item.author) meta.push(`<span>${escapeHtml(item.author)}</span>`);
    if (item.published_at) meta.push(`<span>${fmtFull(item.published_at)}</span>`);

    const plainLen = (item.content || '').replace(/<[^>]+>/g, '').trim().length;
    const cta = (item.link && plainLen < 320)
      ? `<div class="rd-foot"><a class="btn primary" href="${escapeHtml(item.link)}" target="_blank" rel="noopener">这篇只提供摘要，去原文阅读</a></div>`
      : '';

    el.readerBody.innerHTML = `
      <h1 class="rd-title">${escapeHtml(item.title || '(无标题)')}</h1>
      <div class="rd-meta">${meta.join('<span class="sep">·</span>')}</div>
      <div class="rd-content">${item.content || item.summary || '<p style="color:var(--text-3)">该文章没有正文，点右上角打开原文。</p>'}</div>
      ${cta}`;

    $('#btn-star').classList.toggle('on', !!item.is_starred);
    $('#btn-open').style.display = item.link ? '' : 'none';
  }

  /* ------------------------------ 阅读页操作 ------------------------------ */
  $('#btn-back').addEventListener('click', () => history.back());
  $('#btn-reader-back').addEventListener('click', () => history.back());

  $('#btn-open').addEventListener('click', () => {
    if (state.current && state.current.link) window.open(state.current.link, '_blank', 'noopener');
  });

  $('#btn-star').addEventListener('click', async () => {
    if (!state.current) return;
    const next = state.current.is_starred ? 0 : 1;
    state.current.is_starred = next;
    $('#btn-star').classList.toggle('on', !!next);
    const row = state.items.find((x) => x.id === state.current.id);
    if (row) row.is_starred = next;
    state.counts.starred = Math.max(0, (state.counts.starred || 0) + (next ? 1 : -1));
    renderSources();
    renderItems();
    try {
      await api(`/items/${state.current.id}`, { method: 'PATCH', body: { starred: !!next } });
      toast(next ? '已收藏' : '已取消收藏', 1200);
    } catch (err) { toast(err.message); }
  });

  $('#btn-markread').addEventListener('click', async () => {
    if (!state.current) return;
    const next = state.current.is_read ? 0 : 1;
    try {
      await api(`/items/${state.current.id}`, { method: 'PATCH', body: { read: !!next } });
      state.current.is_read = next;
      const row = state.items.find((x) => x.id === state.current.id);
      if (row) row.is_read = next;
      await refreshCounts();
      toast(next ? '已标为已读' : '已标为未读', 1200);
    } catch (err) { toast(err.message); }
  });

  async function refreshCounts() {
    try {
      const data = await api('/bootstrap');
      state.groups = data.groups || [];
      state.feeds = data.feeds || [];
      state.counts = data.counts || state.counts;
      renderSources();
      renderItems();
    } catch { /* ignore */ }
  }

  /* ------------------------------ 顶栏操作 ------------------------------ */
  $('#btn-markall').addEventListener('click', async () => {
    try {
      const body = {};
      if (state.scope.type === 'feed') body.feedId = state.scope.id;
      const r = await api('/read-all', { method: 'POST', body });
      await refreshCounts();
      await loadItems();
      toast(r.changed ? `已把 ${r.changed} 篇标为已读` : '没有未读文章');
    } catch (err) { toast(err.message); }
  });

  /** 刷新当前范围（单源 / 全部），按钮与下拉刷新共用 */
  async function doRefresh() {
    let msg;
    if (state.scope.type === 'feed') {
      const r = await api(`/feeds/${state.scope.id}/refresh`, { method: 'POST' });
      msg = r.added ? `更新 ${r.added} 篇` : '没有新文章';
    } else {
      const r = await api('/refresh', { method: 'POST', body: { limit: 15 } });
      msg = `刷新 ${r.refreshed} 个源，新增 ${r.added} 篇${r.errors.length ? `，${r.errors.length} 个失败` : ''}`;
    }
    await refreshCounts();
    await loadItems();
    return msg;
  }

  $('#btn-refresh').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.classList.add('busy');
    try {
      toast(await doRefresh(), 2600);
    } catch (err) {
      toast(err.message, 3400);
    } finally {
      btn.classList.remove('busy');
    }
  });

  /* ------------------------- 订阅源信息面板 ------------------------- */

  function openFeedInfo() {
    if (state.scope.type !== 'feed') return;
    const f = state.feeds.find((x) => x.id === state.scope.id);
    if (!f) { toast('订阅源不存在'); return; }

    $('#feed-name').value = f.title || '';
    $('#feed-url').value = f.url || '';
    $('#feed-group').innerHTML = `<option value="">不分组</option>` +
      state.groups.map((g) => `<option value="${g.id}" ${f.group_id === g.id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join('');

    const status = f.last_status === 'error'
      ? `<span class="err">抓取失败${f.last_error ? '：' + escapeHtml(f.last_error) : ''}</span>`
      : (f.last_status === 'ok' ? '正常' : '—');
    const site = f.site_url
      ? `<a href="${escapeHtml(f.site_url)}" target="_blank" rel="noopener">${escapeHtml(f.site_url.replace(/^https?:\/\//, ''))}</a>`
      : '—';

    $('#feed-stats').innerHTML = `
      <dt>文章</dt><dd>${f.total || 0} 篇（未读 ${f.unread || 0}）</dd>
      <dt>最新一篇</dt><dd>${f.last_pub ? fmtFull(f.last_pub) : '—'}</dd>
      <dt>最后抓取</dt><dd>${f.last_fetch_at ? fmtFull(f.last_fetch_at) : '—'}</dd>
      <dt>状态</dt><dd>${status}</dd>
      <dt>站点</dt><dd>${site}</dd>
      <dt>添加时间</dt><dd>${f.created_at ? fmtFull(f.created_at) : '—'}</dd>`;
    $('#feed-err').textContent = '';

    el.modalFeed.hidden = false;
    setTimeout(() => $('#feed-name').focus(), 90);
  }

  $('#btn-feed-info').addEventListener('click', openFeedInfo);

  $('#btn-save-feed').addEventListener('click', async () => {
    if (state.scope.type !== 'feed') return;
    const name = $('#feed-name').value.trim();
    const gid = $('#feed-group').value || null;
    const btn = $('#btn-save-feed');
    btn.disabled = true;
    $('#feed-err').textContent = '';
    try {
      const r = await api(`/feeds/${state.scope.id}`, { method: 'PATCH', body: { title: name, groupId: gid } });
      state.feeds = r.feeds || state.feeds;
      state.groups = r.groups || state.groups;
      renderSources();
      updateListTitle();
      await loadItems();
      closeModal('feed');
      toast('已保存');
    } catch (err) {
      $('#feed-err').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  $('#feed-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-save-feed').click();
  });

  $('#btn-delete-feed').addEventListener('click', async () => {
    if (state.scope.type !== 'feed') return;
    const id = state.scope.id;
    const f = state.feeds.find((x) => x.id === id);
    if (!confirm(`删除订阅「${f ? f.title || f.url : id}」？\n该源已抓取的文章会一并删除，不可恢复。`)) return;
    try {
      const r = await api(`/feeds/${id}`, { method: 'DELETE' });
      state.feeds = r.feeds;
      state.groups = r.groups;
      closeModal('feed');
      await selectScope({ type: 'all' });
      renderManage(); renderSources(); fillGroupSelect();
      toast('已删除订阅');
    } catch (err) {
      $('#feed-err').textContent = err.message;
    }
  });

  /* ---------------------------- 下拉刷新 ---------------------------- */

  function setupPullToRefresh(scroller, ptrEl, onRefresh) {
    if (!scroller || !ptrEl) return;
    const THRESHOLD = 54;
    const MAXH = 76;
    const iconEl = ptrEl.querySelector('.ptr-icon');
    const textEl = ptrEl.querySelector('.ptr-text');
    let startY = 0;
    let pulling = false;
    let dist = 0;
    let busy = false;

    const setHeight = (h, animate) => {
      ptrEl.classList.toggle('animating', !!animate);
      ptrEl.style.height = h + 'px';
    };
    const reset = (animate = true) => {
      dist = 0;
      ptrEl.classList.remove('ready', 'loading');
      if (iconEl) iconEl.textContent = '↓';
      if (textEl) textEl.textContent = '下拉刷新';
      setHeight(0, animate);
    };

    scroller.addEventListener('touchstart', (e) => {
      if (busy || scroller.scrollTop > 2) return;
      startY = e.touches[0].clientY;
      pulling = true;
      dist = 0;
    }, { passive: true });

    scroller.addEventListener('touchmove', (e) => {
      if (!pulling || busy) return;
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0) {
        if (dist > 0) reset(false);
        return;
      }
      if (scroller.scrollTop > 2) { pulling = false; reset(false); return; }
      dist = Math.min(dy * 0.62, MAXH);
      if (dist > 6) e.preventDefault();
      setHeight(dist, false);
      const ready = dist >= THRESHOLD;
      ptrEl.classList.toggle('ready', ready);
      if (iconEl) iconEl.textContent = ready ? '↑' : '↓';
      if (textEl) textEl.textContent = ready ? '松手刷新' : '下拉刷新';
    }, { passive: false });

    const finish = async () => {
      if (!pulling) return;
      pulling = false;
      if (dist < THRESHOLD) { reset(true); return; }
      busy = true;
      dist = 0;
      ptrEl.classList.add('loading');
      if (iconEl) iconEl.textContent = '↻';
      if (textEl) textEl.textContent = '刷新中…';
      setHeight(38, true);
      try {
        await onRefresh();
        if (textEl) textEl.textContent = '已刷新';
        await new Promise((r) => setTimeout(r, 400));
      } catch {
        if (textEl) textEl.textContent = '刷新失败';
        await new Promise((r) => setTimeout(r, 600));
      } finally {
        busy = false;
        reset(true);
      }
    };

    scroller.addEventListener('touchend', finish);
    scroller.addEventListener('touchcancel', () => { pulling = false; reset(true); });
  }

  setupPullToRefresh(el.itemScroll, el.ptr, () => doRefresh());
  setupPullToRefresh(el.srcScroll, el.ptrSrc, () => doRefresh());

  /* 横竖屏切换 / 窗口尺寸变化时重算展开区高度 */
  let fitTimer = null;
  window.addEventListener('resize', () => {
    if (!state.expandedId) return;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => fitExpandedCard(state.expandedId), 200);
  });

  /* ------------------------------ 菜单 ------------------------------ */
  $('#btn-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    el.menu.hidden = !el.menu.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!el.menu.hidden && !e.target.closest('#menu') && !e.target.closest('#btn-menu')) el.menu.hidden = true;
  });

  el.menu.addEventListener('click', async (e) => {
    const btn = e.target.closest('.menu-item');
    if (!btn) return;
    el.menu.hidden = true;
    const act = btn.dataset.act;
    try {
      if (act === 'manage') openManage();
      else if (act === 'starred') {
        state.filter = 'starred';
        await selectScope({ type: 'all' });
      } else if (act === 'opml-export') window.location.href = '/api/opml';
      else if (act === 'opml-import') $('#opml-file').click();
      else if (act === 'refresh') $('#btn-refresh').click();
      else if (act === 'theme') toggleTheme();
      else if (act === 'settings') openSettings();
      else if (act === 'logout') {
        await api('/logout', { method: 'POST' });
        location.reload();
      }
    } catch (err) { toast(err.message); }
  });

  /* ------------------------------ 主题 ------------------------------ */
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').setAttribute('content', theme === 'dark' ? '#16181a' : '#ffffff');
    const mi = el.menu.querySelector('[data-act="theme"]');
    if (mi) mi.textContent = theme === 'dark' ? '日间模式' : '夜间模式';
    localStorage.setItem('ant.theme', theme);
  }
  function toggleTheme() {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  }
  applyTheme(localStorage.getItem('ant.theme') || 'light');

  /* ------------------------------ 弹层通用 ------------------------------ */
  const modals = { add: el.modalAdd, manage: el.modalManage, settings: el.modalSettings, feed: el.modalFeed, newgroup: el.modalNewGroup };
  function closeModal(name) {
    if (modals[name]) modals[name].hidden = true;
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-close]');
    if (btn) closeModal(btn.dataset.close);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      Object.keys(modals).forEach((k) => { if (!modals[k].hidden) closeModal(k); });
      el.menu.hidden = true;
    }
  });

  /* ------------------------------ 添加订阅 ------------------------------ */
  $('#btn-add').addEventListener('click', () => {
    $('#add-url').value = '';
    $('#add-err').textContent = '';
    $('#add-preview').hidden = true;
    fillGroupSelect();
    el.modalAdd.hidden = false;
    setTimeout(() => $('#add-url').focus(), 80);
  });

  function fillGroupSelect(selected) {
    const sel = $('#add-group');
    sel.innerHTML = `<option value="">不分组</option>` +
      state.groups.map((g) => `<option value="${g.id}" ${String(selected) === String(g.id) ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join('');
  }

  $('#btn-add-submit').addEventListener('click', async () => {
    const url = $('#add-url').value.trim();
    const groupId = $('#add-group').value || null;
    const btn = $('#btn-add-submit');
    if (!url) { $('#add-err').textContent = '请输入订阅地址'; return; }
    btn.disabled = true;
    btn.textContent = '添加中…';
    $('#add-err').textContent = '';
    try {
      const r = await api('/feeds', { method: 'POST', body: { url, groupId } });
      state.feeds = r.feeds;
      state.groups = r.groups;
      renderSources();
      closeModal('add');
      await refreshCounts();
      if (state.scope.type === 'all') await loadItems();
      toast(`已添加「${r.feed.title || r.feed.url}」，抓取 ${r.synced.added} 篇`, 2800);
    } catch (err) {
      $('#add-err').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '添加';
    }
  });

  $('#add-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-add-submit').click();
  });

  /* ------------------------------ 整理订阅 ------------------------------ */
  function openManage() {
    $('#manage-search').value = '';
    renderManage();
    el.modalManage.hidden = false;
    setTimeout(() => $('#manage-search').focus(), 80);
  }

  function renderManage() {
    const kw = ($('#manage-search').value || '').trim().toLowerCase();

    $('#group-chips').innerHTML = state.groups.map((g) => `
      <span class="chip" data-gid="${g.id}">${escapeHtml(g.name)}
        <button data-del-group="${g.id}" title="删除分组">×</button>
      </span>`).join('') || `<span class="hint">还没有分组</span>`;

    const list = kw
      ? state.feeds.filter((f) => (f.title || '').toLowerCase().includes(kw) || (f.url || '').toLowerCase().includes(kw))
      : state.feeds;

    $('#manage-feeds').innerHTML = list.map((f) => `
      <div class="mf-item" data-fid="${f.id}">
        <div class="mf-main">
          <div class="mf-title">${escapeHtml(f.title || f.url)}</div>
          <div class="mf-url">${escapeHtml(f.url)}${f.last_status === 'error' ? ' · <span style="color:var(--danger)">抓取失败</span>' : ''}</div>
        </div>
        <select class="input" data-group-of="${f.id}">
          <option value="">未分组</option>
          ${state.groups.map((g) => `<option value="${g.id}" ${f.group_id === g.id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join('')}
        </select>
        <button class="icon-btn sm mf-del" data-del-feed="${f.id}" title="删除">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 7h14M10 7V5h4v2M6.5 7l.8 12h9.4l.8-12"/></svg>
        </button>
      </div>`).join('')
      || (kw
        ? `<div class="empty">没有匹配「${escapeHtml(kw)}」的订阅源</div>`
        : `<div class="empty">还没有订阅源</div>`);
  }

  /* 搜索订阅源：输入即过滤 */
  $('#manage-search').addEventListener('input', renderManage);

  /* 新建分组：先点按钮，再在弹窗里填名字 */
  $('#btn-open-newgroup').addEventListener('click', () => {
    $('#new-group-name').value = '';
    $('#newgroup-err').textContent = '';
    el.modalNewGroup.hidden = false;
    setTimeout(() => $('#new-group-name').focus(), 80);
  });

  async function createGroup() {
    const name = $('#new-group-name').value.trim();
    if (!name) { $('#newgroup-err').textContent = '请输入分组名称'; return; }
    try {
      const r = await api('/groups', { method: 'POST', body: { name } });
      state.groups = r.groups;
      closeModal('newgroup');
      renderManage(); renderSources(); fillGroupSelect();
      toast('分组已创建');
    } catch (err) {
      $('#newgroup-err').textContent = err.message;
    }
  }
  $('#btn-create-group').addEventListener('click', createGroup);
  $('#new-group-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createGroup(); });

  el.modalManage.addEventListener('click', async (e) => {
    const delGroup = e.target.closest('[data-del-group]');
    if (delGroup) {
      const id = parseInt(delGroup.dataset.delGroup, 10);
      if (!confirm('删除这个分组？组内订阅会变成「未分组」，不会被删除。')) return;
      try {
        const r = await api(`/groups/${id}`, { method: 'DELETE' });
        state.groups = r.groups;
        state.feeds = r.feeds;
        renderManage(); renderSources(); fillGroupSelect();
      } catch (err) { toast(err.message); }
      return;
    }
    const delFeed = e.target.closest('[data-del-feed]');
    if (delFeed) {
      const id = parseInt(delFeed.dataset.delFeed, 10);
      const f = state.feeds.find((x) => x.id === id);
      if (!confirm(`删除订阅「${f ? f.title || f.url : id}」？该源已抓取的文章会一并删除。`)) return;
      try {
        const r = await api(`/feeds/${id}`, { method: 'DELETE' });
        state.feeds = r.feeds;
        state.groups = r.groups;
        if (state.scope.type === 'feed' && state.scope.id === id) await selectScope({ type: 'all' });
        renderManage(); renderSources(); fillGroupSelect();
        toast('已删除');
      } catch (err) { toast(err.message); }
    }
  });

  el.modalManage.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-group-of]');
    if (!sel) return;
    const id = parseInt(sel.dataset.groupOf, 10);
    try {
      const r = await api(`/feeds/${id}`, { method: 'PATCH', body: { groupId: sel.value || null } });
      state.feeds = r.feeds;
      state.groups = r.groups;
      renderSources();
      toast('已移动');
    } catch (err) { toast(err.message); }
  });

  /* ------------------------------ OPML 导入 ------------------------------ */
  $('#opml-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!confirm(`导入「${file.name}」？同名订阅会自动跳过。导入需要逐个探测源，可能耗时几十秒。`)) return;
    toast('正在导入，请稍候…', 60000);
    try {
      const text = await file.text();
      const r = await api('/opml', { raw: text, method: 'POST' });
      state.feeds = r.feeds;
      state.groups = r.groups;
      renderSources();
      await refreshCounts();
      toast(`导入完成：新增 ${r.added}，跳过 ${r.skipped}，失败 ${r.failed}`, 4000);
    } catch (err) {
      toast(err.message, 4000);
    }
  });

  /* ------------------------------ 设置 ------------------------------ */
  function openSettings() {
    $('#set-oldpass').value = '';
    $('#set-newpass').value = '';
    $('#set-err').textContent = '';
    $('#stat-line').innerHTML =
      `订阅源 ${state.counts.feeds || 0} 个 · 文章 ${state.counts.items || 0} 篇 · 未读 ${state.counts.unread || 0} · 收藏 ${state.counts.starred || 0}`;
    el.modalSettings.hidden = false;
  }

  $('#btn-save-settings').addEventListener('click', async () => {
    const oldPass = $('#set-oldpass').value;
    const newPass = $('#set-newpass').value;
    $('#set-err').textContent = '';
    try {
      if (newPass) {
        if (newPass.length < 4) throw new Error('新密码至少 4 位');
        await api('/password', { method: 'POST', body: { oldPassword: oldPass, newPassword: newPass } });
      }
      closeModal('settings');
      toast('已保存');
    } catch (err) {
      $('#set-err').textContent = err.message;
    }
  });

  /* ------------------------------ 键盘快捷键 ------------------------------ */
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (!el.main.hidden && !document.querySelector('.modal:not([hidden])')) {
      const idx = state.items.findIndex((x) => state.current && x.id === state.current.id);
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = state.items[Math.min(idx + 1, state.items.length - 1)];
        if (next) openItem(next.id);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = state.items[Math.max(idx - 1, 0)];
        if (prev) openItem(prev.id);
      } else if (e.key === 'm') {
        $('#btn-markread').click();
      } else if (e.key === 's') {
        $('#btn-star').click();
      } else if (e.key === 'o') {
        $('#btn-open').click();
      } else if (e.key === 'r') {
        $('#btn-refresh').click();
      }
    }
  });

  /* ------------------------------ 启动 ------------------------------ */
  async function boot() {
    history.replaceState({ view: 'sources' }, '');
    try {
      const st = await api('/status');
      state.setupIsDone = !!st.setup;
      state.counts = st.counts || state.counts;
      if (!st.setup) {
        state.setupIsDone = false;
        showAuth(true);
        return;
      }
      if (!st.authed) {
        showAuth(false);
        return;
      }
      await enterApp();
    } catch (err) {
      showAuth(false);
      el.authErr.textContent = '无法连接服务：' + err.message;
    }
  }

  boot();
})();
