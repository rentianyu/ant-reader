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
    settings: { refreshInterval: 30 },
    scope: { type: 'all', id: null },
    filter: 'all',
    items: [],
    total: 0,
    current: null,
    collapsed: new Set(),
    loading: false,
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
    srcList: $('#src-list'),
    itemList: $('#item-list'),
    listTitle: $('#list-title'),
    listMore: $('#list-more'),
    readerBody: $('#reader-body'),
    readerScroll: $('#reader-scroll'),
    segbar: $('#segbar'),
    menu: $('#menu'),
    toast: $('#toast'),
    modalAdd: $('#modal-add'),
    modalManage: $('#modal-manage'),
    modalSettings: $('#modal-settings'),
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
  function renderSources() {
    const parts = [];

    const unread = state.counts.unread || 0;
    parts.push(srcEntryHtml({
      key: 'all', icon: ICONS.all, name: '全部文章', badge: null,
      active: state.scope.type === 'all' && state.filter !== 'starred',
      time: '',
    }));
    parts.push(srcEntryHtml({
      key: 'unread', icon: ICONS.unread, name: '未读', badge: unread || null,
      active: state.scope.type === 'all' && state.filter === 'unread',
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
        for (const f of list) parts.push(feedEntryHtml(f));
      }
    }
    if (ungrouped.length) {
      if (state.groups.length) parts.push(`<div class="src-group"><span class="caret"></span><span class="src-group-name">未分组</span></div>`);
      for (const f of ungrouped) parts.push(feedEntryHtml(f));
    }

    if (!state.feeds.length) {
      parts.push(`<div class="src-empty"><span class="big">还没有订阅</span>点右上角 ＋ 添加第一个 RSS 源</div>`);
    }

    el.srcList.innerHTML = parts.join('');
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

  el.srcList.addEventListener('click', (e) => {
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
  async function loadItems(more = false) {
    if (state.loading) return;
    state.loading = true;
    const params = new URLSearchParams();
    if (state.scope.type === 'feed') params.set('feed_id', state.scope.id);
    if (state.scope.type === 'group') params.set('group_id', state.scope.id);
    if (state.filter === 'unread') params.set('unread', '1');
    if (state.filter === 'starred') params.set('starred', '1');
    params.set('limit', '40');
    params.set('offset', more ? state.items.length : 0);

    try {
      const data = await api(`/items?${params.toString()}`);
      state.items = more ? state.items.concat(data.items) : data.items;
      state.total = data.total;
      renderItems();
    } catch (err) {
      el.itemList.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    } finally {
      state.loading = false;
    }
  }

  function renderItems() {
    if (!state.items.length) {
      el.itemList.innerHTML = `<div class="empty"><span class="big">这里没有文章</span>${state.filter === 'unread' ? '所有文章都读完了' : '换个筛选条件或刷新试试'}</div>`;
      el.listMore.hidden = true;
      return;
    }

    el.itemList.innerHTML = state.items.map((it) => {
      const active = state.current && state.current.id === it.id;
      return `<button class="item ${it.is_read ? '' : 'unread'} ${active ? 'active' : ''}" data-id="${it.id}">
        <div class="it-top">
          <div class="it-title">${escapeHtml(it.title || '(无标题)')}</div>
          <div class="it-time">${fmtTime(it.published_at || it.fetched_at)}</div>
        </div>
        <div class="it-meta">
          <span class="it-feed">${escapeHtml(it.feed_title || '')}</span>
          ${it.author ? `<span class="sep">·</span><span>${escapeHtml(it.author)}</span>` : ''}
          ${it.is_starred ? `<span class="it-star"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 3.6l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z"/></svg></span>` : ''}
        </div>
        ${it.summary ? `<div class="it-summary">${escapeHtml(cleanText(it.summary))}</div>` : ''}
      </button>`;
    }).join('');

    el.listMore.hidden = state.items.length >= state.total;
  }

  el.itemList.addEventListener('click', (e) => {
    const btn = e.target.closest('.item');
    if (!btn) return;
    openItem(parseInt(btn.dataset.id, 10));
  });

  $('#btn-more').addEventListener('click', () => loadItems(true));

  /* ------------------------------ 打开文章 ------------------------------ */
  async function openItem(id) {
    const idx = state.items.findIndex((x) => x.id === id);
    if (idx < 0) return;

    try {
      const data = await api(`/items/${id}`);
      const item = data.item;
      state.current = item;
      renderReader(item);

      if (!item.is_read) {
        item.is_read = 1;
        const listItem = state.items[idx];
        listItem.is_read = 1;
        state.counts.unread = Math.max(0, (state.counts.unread || 1) - 1);
        const feed = state.feeds.find((f) => f.id === item.feed_id);
        if (feed && feed.unread > 0) feed.unread -= 1;
        renderSources();
        renderItems();
        api(`/items/${id}`, { method: 'PATCH', body: { read: true } }).catch(() => {});
      }

      if (isMobile()) setView('reader');
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

  $('#btn-refresh').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.classList.add('busy');
    try {
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
      toast(msg, 2600);
    } catch (err) {
      toast(err.message, 3400);
    } finally {
      btn.classList.remove('busy');
    }
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
  const modals = { add: el.modalAdd, manage: el.modalManage, settings: el.modalSettings };
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
    renderManage();
    el.modalManage.hidden = false;
  }

  function renderManage() {
    $('#group-chips').innerHTML = state.groups.map((g) => `
      <span class="chip" data-gid="${g.id}">${escapeHtml(g.name)}
        <button data-del-group="${g.id}" title="删除分组">×</button>
      </span>`).join('') || `<span class="hint">还没有分组</span>`;

    $('#manage-feeds').innerHTML = state.feeds.map((f) => `
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
      </div>`).join('') || `<div class="empty">还没有订阅源</div>`;
  }

  $('#btn-new-group').addEventListener('click', async () => {
    const name = $('#new-group').value.trim();
    if (!name) return;
    try {
      const r = await api('/groups', { method: 'POST', body: { name } });
      state.groups = r.groups;
      $('#new-group').value = '';
      renderManage();
      renderSources();
      fillGroupSelect();
    } catch (err) { toast(err.message); }
  });

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
    $('#set-interval').value = state.settings.refreshInterval || 30;
    $('#set-oldpass').value = '';
    $('#set-newpass').value = '';
    $('#set-err').textContent = '';
    $('#stat-line').innerHTML =
      `订阅源 ${state.counts.feeds || 0} 个 · 文章 ${state.counts.items || 0} 篇 · 未读 ${state.counts.unread || 0} · 收藏 ${state.counts.starred || 0}`;
    el.modalSettings.hidden = false;
  }

  $('#btn-save-settings').addEventListener('click', async () => {
    const interval = parseInt($('#set-interval').value, 10) || 30;
    const oldPass = $('#set-oldpass').value;
    const newPass = $('#set-newpass').value;
    $('#set-err').textContent = '';
    try {
      const r = await api('/settings', { method: 'PATCH', body: { refreshInterval: interval } });
      state.settings = { ...state.settings, ...r.settings };
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
