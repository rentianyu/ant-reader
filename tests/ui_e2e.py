#!/usr/bin/env python3
"""
蚁读 UI 验收脚本（CDP 驱动无头 Chromium）

覆盖：
  1. 移动端密度（列表项高度、一屏条目数、标题单行）
  2. 列表初始只显示未读，滑到底才追加已读（分隔条）
  3. 点一条 → 它和更早的未读全部变灰
  4. 点开原地展开、再点打开原文
  5. 下拉刷新（模拟触摸手势）
  6. 桌面端三栏 + 右栏正文

用法：
  python3 tests/ui_e2e.py --base http://127.0.0.1:8787 --password test1234
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request

import websocket

OUT = "/sandbox/workspace/ant-reader/shots"
fails = []
_mid = [0]


def cdp(ws, method, params=None):
    _mid[0] += 1
    mid = _mid[0]
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    deadline = time.time() + 45
    while time.time() < deadline:
        raw = ws.recv()
        if not raw:
            continue
        msg = json.loads(raw)
        if msg.get("id") == mid:
            if "error" in msg:
                raise RuntimeError(f"{method}: {msg['error']}")
            return msg.get("result", {})
    raise TimeoutError(method)


def ev(ws, expr):
    r = cdp(ws, "Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
    res = r.get("result", {})
    if res.get("subtype") == "error":
        raise RuntimeError(res.get("description"))
    return res.get("value")


def check(name, cond, extra=""):
    if cond:
        print(f"  PASS {name}" + (f"  [{extra}]" if extra else ""))
    else:
        fails.append(name)
        print(f"  FAIL {name}  {extra}")


def shot(ws, name):
    data = cdp(ws, "Page.captureScreenshot", {"format": "png"})
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, name)
    with open(p, "wb") as f:
        f.write(base64.b64decode(data["data"]))
    print(f"  截图 → {p} ({os.path.getsize(p)//1024}KB)")


def login_token(base, password):
    req = urllib.request.Request(
        base + "/api/login",
        data=json.dumps({"password": password}).encode(),
        headers={
            "content-type": "application/json",
            "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/140.0 Safari/537.36",
        },
    )
    return urllib.request.urlopen(req, timeout=30).headers.get("set-cookie", "").split(";")[0].split("=", 1)[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8787")
    ap.add_argument("--password", default="test1234")
    ap.add_argument("--port", default="9222")
    ap.add_argument("--reset-unread", action="store_true", help="本地测试前把所有文章重置为未读")
    args = ap.parse_args()
    base = args.base.rstrip("/")
    host = base.split("//", 1)[1].split("/")[0].split(":")[0]

    if args.reset_unread:
        env = dict(os.environ)
        env["PATH"] = "/tmp/wr/node_modules/.bin:" + env.get("PATH", "")
        subprocess.run(["wrangler", "d1", "execute", "ant-reader-db", "--local",
                        "--persist-to", "/tmp/wrstate", "--command",
                        "UPDATE items SET is_read = 0"],
                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        time.sleep(1)
        print("已重置所有文章为未读")

    token = login_token(base, args.password)
    print(f"登录 OK（{host}）")

    chrome = subprocess.Popen(
        ["chromium", "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
         f"--remote-debugging-port={args.port}", "--remote-allow-origins=*", "--hide-scrollbars", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ws_url = None
        for _ in range(80):
            try:
                pages = [t for t in json.load(urllib.request.urlopen(
                    f"http://127.0.0.1:{args.port}/json/list", timeout=2)) if t["type"] == "page"]
                if pages:
                    ws_url = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                pass
            time.sleep(0.4)
        if not ws_url:
            print("无法连接 Chromium")
            return 1

        ws = websocket.create_connection(ws_url, timeout=45, suppress_origin=True)
        cdp(ws, "Page.enable")
        cdp(ws, "Network.enable")
        cdp(ws, "Network.setCookie", {"name": "ant_session", "value": token, "domain": host, "path": "/"})
        cdp(ws, "Emulation.setDeviceMetricsOverride",
            {"width": 390, "height": 844, "deviceScaleFactor": 2, "mobile": True})
        cdp(ws, "Page.navigate", {"url": base + "/"})
        time.sleep(3.4)

        print("== 订阅源首页 ==")
        check("主界面已显示", ev(ws, "!document.getElementById('main-view').hidden"))
        src_h = ev(ws, "Math.round(document.querySelector('.src-entry').getBoundingClientRect().height)")
        check("订阅源条目 ≤ 50px", src_h and src_h <= 50, f"{src_h}px")

        print("== 文章列表：密度 ==")
        # 接口层先确认排序：旧 → 新
        req0 = urllib.request.Request(
            base + "/api/items?limit=6&unread=1",
            headers={"cookie": f"ant_session={token}",
                     "user-agent": "Mozilla/5.0 Chrome/140.0 Safari/537.36"})
        d0 = json.loads(urllib.request.urlopen(req0, timeout=60).read())
        ts0 = [i["published_at"] or i["fetched_at"] for i in d0["items"]]
        check("接口按时间升序（旧→新）", ts0 == sorted(ts0), f"{len(ts0)} 条")

        ev(ws, "document.querySelector('.src-entry[data-scope=feed]').click()")
        time.sleep(2.4)
        check("进入文章列表", ev(ws, "document.body.dataset.view") == "list")
        metric = ev(ws, """(() => {
          const items = [...document.querySelectorAll('.item')];
          const h = items.reduce((s, e) => s + e.getBoundingClientRect().height, 0) / Math.max(1, items.length);
          const vh = document.getElementById('item-list').clientHeight;
          return {avg: Math.round(h), per: Math.floor(vh / h), n: items.length};
        })()""")
        check("列表项平均高度 ≤ 50px", metric["avg"] <= 50, f"{metric['avg']}px")
        check("一屏可见 ≥ 12 条", metric["per"] >= 12, f"{metric['per']} 条/屏")
        title_lines = ev(ws, """(() => {
          const t = document.querySelector('.it-title');
          const lh = parseFloat(getComputedStyle(t).lineHeight) || 21;
          return Math.round(t.getBoundingClientRect().height / lh);
        })()""")
        check("标题只占一行", title_lines == 1, f"{title_lines} 行")

        print("== 列表内容 ==")
        counts = ev(ws, """(() => {
          const items = [...document.querySelectorAll('.item')];
          return {n: items.length, unread: items.filter(e => e.classList.contains('unread')).length,
                  read: items.filter(e => !e.classList.contains('unread')).length};
        })()""")
        check("列表有条目", counts["n"] > 0, f"{counts['n']} 条（未读 {counts['unread']}，已读 {counts['read']}）")
        shot(ws, "m2-list.png")

        print("== 点一条 → 它和更旧的未读一起变已读 ==")
        ev(ws, "window.confirm = () => true")
        before = counts["unread"]
        total_items = counts["n"]
        # 升序下点最后一条未读（最新的未读），先记下点击前的未读 id 集合
        clicked_id = ev(ws, "(() => { const un = [...document.querySelectorAll('.item.unread')]; const t = un.length ? un[un.length - 1] : null; return t ? t.dataset.id : null; })()")
        unread_ids = ev(ws, "[...document.querySelectorAll('.item.unread')].map(e => e.dataset.id)")
        ev(ws, "(() => { const un = [...document.querySelectorAll('.item.unread')]; (un.length ? un[un.length - 1] : [...document.querySelectorAll('.item')].pop()).click(); })()")
        time.sleep(2.4)
        after = ev(ws, """(() => {
          const items = [...document.querySelectorAll('.item')];
          const ex = document.querySelector('.item.expanded');
          return {unread: items.filter(e => e.classList.contains('unread')).length,
                  clickedRead: ex ? !ex.classList.contains('unread') : null};
        })()""")
        check("被点那篇变为已读", after["clickedRead"] is True, str(after["clickedRead"]))
        left = after["unread"]
        check("比它旧的未读一起变已读（列表内清空）", left == 0, f"剩余 {left} 条未读（原 {len(unread_ids or [])} 条）")
        color = ev(ws, "getComputedStyle(document.querySelector('.item.expanded .it-title')).color")
        check("已读标题转浅灰", color not in ("rgb(34, 34, 34)", "rgb(0, 0, 0)"), color)
        shot(ws, "m3-read-one.png")

        print("== 展开区（同为已读那一击） ==")
        check("卡片原地展开", ev(ws, "!!document.querySelector('.item.expanded')"))
        more_len = ev(ws, "(document.querySelector('.it-more-html')||{}).textContent?.length || 0")
        check("展开区有文字", (more_len or 0) > 10, f"{more_len} 字")

        print("== 展开后下方仍露出下一条 + 滚动联动 ==")
        # 点倒数第二条（它下面还有一条），检验布局与滚动链
        ev(ws, "(() => { const a = [...document.querySelectorAll('.item')]; a[a.length - 2].click(); })()")
        time.sleep(2.6)
        geo = ev(ws, """(() => {
          const card = document.querySelector('.item.expanded');
          const box = document.getElementById('item-list');
          if (!card) return null;
          const cr = card.getBoundingClientRect();
          const br = box.getBoundingClientRect();
          const next = card.nextElementSibling;
          const holder = card.querySelector('.it-more-html, .it-more-text');
          return {
            spaceBelow: Math.round(br.bottom - cr.bottom),
            hasNext: !!next,
            nextTop: next ? Math.round(next.getBoundingClientRect().top - br.top) : null,
            nextVisible: next ? next.getBoundingClientRect().top < br.bottom - 8 : null,
            holderMaxH: holder ? holder.style.maxHeight : null,
            overscroll: holder ? getComputedStyle(holder).overscrollBehaviorY : null,
          };
        })()""")
        check("展开卡片下方留有空间", geo and geo["spaceBelow"] >= 40, str(geo and geo["spaceBelow"]))
        check("下一条文章可见", geo and geo["nextVisible"] is True, str(geo and geo["nextTop"]))
        check("展开区允许滚动联动外层", geo and geo["overscroll"] in ("auto", "visible"), str(geo and geo["overscroll"]))
        shot(ws, "m5-expand-next.png")

        shot(ws, "m4-list-full.png")

        print("== 再点已展开的卡片打开原文 ==")
        ev(ws, "window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; };")
        ev(ws, "document.querySelector('.item.expanded .it-title').click()")
        time.sleep(0.9)
        opened = ev(ws, "window.__opened")
        check("再点打开原文", isinstance(opened, list) and len(opened) == 1, str(opened)[:70])

        print("== 下拉刷新 ==")
        # 先重载当前源，收起上一段展开的卡片，避免内部滚动容器拦截手势
        ev(ws, "document.querySelector('.src-entry.active').click()")
        time.sleep(2.8)
        ev(ws, "document.getElementById('item-list').scrollTop = 0")
        time.sleep(0.5)
        cdp(ws, "Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": 195, "y": 380}]})
        heights = []
        for i in range(1, 9):
            cdp(ws, "Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": 195, "y": 380 + i * 22}]})
            time.sleep(0.06)
            heights.append(ev(ws, "parseInt(document.getElementById('ptr').style.height) || 0"))
        check("下拉指示器展开", max(heights or [0]) > 20, f"{max(heights or [0])}px")
        cdp(ws, "Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        seen = []
        for _ in range(8):
            time.sleep(0.08)
            seen.append(ev(ws, "document.querySelector('#ptr .ptr-text').textContent"))
        check("松手后进入加载/已加载态", any(x in ("加载中…", "已加载更久") for x in seen), str(seen[:4]))
        # 刷新会真实抓取全部订阅源，耗时不定 → 轮询等待最多 25s
        settled = False
        for _ in range(25):
            time.sleep(1)
            if ev(ws, "parseInt(document.getElementById('ptr').style.height) || 0") == 0:
                settled = True
                break
        check("刷新后指示器收起", settled)

        print("== 桌面端两栏 ==")
        ev(ws, "document.body.dataset.view = 'sources'")
        cdp(ws, "Emulation.setDeviceMetricsOverride",
            {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
        time.sleep(0.8)
        ev(ws, "document.querySelector('.src-entry[data-scope=feed]').click()")
        time.sleep(2.6)
        cols = ev(ws, "getComputedStyle(document.querySelector('.layout')).gridTemplateColumns")
        check("桌面是两栏", len(cols.split()) == 2, cols)
        check("阅读栏已隐藏", ev(ws, "getComputedStyle(document.getElementById('pane-reader')).display") == "none")
        dh = ev(ws, "Math.round(document.querySelector('.item').getBoundingClientRect().height)")
        check("桌面条目高 ≤ 48px（放大后上限）", dh and dh <= 48, f"{dh}px")
        title_fs = ev(ws, "getComputedStyle(document.querySelector('.it-title')).fontSize")
        check("桌面标题字号 ≥ 15px", float(title_fs.replace("px", "")) >= 15, title_fs)
        lh = ev(ws, "getComputedStyle(document.querySelector('.it-title')).lineHeight")
        ratio = float(lh.replace("px", "")) / float(title_fs.replace("px", ""))
        check("桌面标题行高 ≥ 1.5", ratio >= 1.5, f"{ratio:.2f}")
        ev(ws, "document.querySelector('.item').click()")
        time.sleep(2.0)
        check("桌面点击也原地展开", ev(ws, "!!document.querySelector('.item.expanded')"))
        shot(ws, "d1-two-col.png")

        print("== 左栏宽度 + 订阅源信息面板 ==")
        rail_w = ev(ws, "Math.round(document.querySelector('.pane-sources').getBoundingClientRect().width)")
        check("左栏宽度 ≈ 402px", 390 <= (rail_w or 0) <= 415, f"{rail_w}px")

        ev(ws, "document.querySelector('.src-entry[data-scope=feed]').click()")
        time.sleep(2.6)
        check("选中订阅源后显示信息按钮", not ev(ws, "document.getElementById('btn-feed-info').hidden"))
        ev(ws, "document.getElementById('btn-feed-info').click()")
        time.sleep(0.8)
        check("信息面板打开", not ev(ws, "document.getElementById('modal-feed').hidden"))
        nm = ev(ws, "document.getElementById('feed-name').value")
        check("名称已填充", bool(nm), str(nm))
        dts = ev(ws, "document.querySelectorAll('#feed-stats dt').length")
        check("统计项 ≥ 5", (dts or 0) >= 5, f"{dts} 项")
        shot(ws, "d2-feed-info.png")

        ev(ws, "document.getElementById('feed-name').value = '改名测试'")
        ev(ws, "document.getElementById('btn-save-feed').click()")
        time.sleep(2.6)
        check("保存后关闭面板", ev(ws, "document.getElementById('modal-feed').hidden"))
        lt = ev(ws, "document.querySelector('.list-title').textContent")
        check("标题跟随新名称", lt == "改名测试", lt)
        left_name = ev(ws, "document.querySelector('.src-entry.active .se-name').textContent")
        check("左栏名称已更新", left_name == "改名测试", left_name)

        # 还原原名
        ev(ws, "document.getElementById('btn-feed-info').click()")
        time.sleep(0.6)
        ev(ws, "document.getElementById('feed-name').value = %s" % json.dumps(nm))
        ev(ws, "document.getElementById('btn-save-feed').click()")
        time.sleep(2.0)
        check("还原成功", ev(ws, "document.querySelector('.list-title').textContent") == nm)

        print("== 设置面板 ==")
        ev(ws, "document.body.dataset.view = 'sources'")
        time.sleep(0.4)
        ev(ws, "document.getElementById('btn-menu').click()")
        time.sleep(0.5)
        ev(ws, "document.querySelector('[data-act=settings]').click()")
        time.sleep(0.8)
        check("设置面板已打开", not ev(ws, "document.getElementById('modal-settings').hidden"))
        check("已移除「自动刷新间隔」输入框", ev(ws, "!document.getElementById('set-interval')"))
        hint = ev(ws, "document.querySelector('#modal-settings .hint').textContent")
        check("提示写明 Cron 每 30 分钟", "30 分钟" in (hint or ""), (hint or "")[:40])
        shot(ws, "m7-settings.png")
        ev(ws, "document.querySelector('#modal-settings [data-close=settings]').click()")
        time.sleep(0.4)

        print("== 整理订阅：搜索 + 新建分组弹窗 ==")
        ev(ws, "window.confirm = () => true")
        ev(ws, "document.body.dataset.view = 'sources'")
        time.sleep(0.4)
        ev(ws, "document.getElementById('btn-menu').click()")
        time.sleep(0.4)
        ev(ws, "document.querySelector('[data-act=manage]').click()")
        time.sleep(0.9)
        check("整理订阅已打开", not ev(ws, "document.getElementById('modal-manage').hidden"))
        n_before = ev(ws, "document.querySelectorAll('.mf-item').length")
        check("默认列出全部订阅源", (n_before or 0) > 5, f"{n_before} 个")
        kw = ev(ws, "document.querySelector('.mf-item .mf-title').textContent.slice(0, 2)")
        ev(ws, "document.getElementById('manage-search').value = %s" % json.dumps(kw))
        ev(ws, "document.getElementById('manage-search').dispatchEvent(new Event('input'))")
        time.sleep(0.5)
        n_after = ev(ws, "document.querySelectorAll('.mf-item').length")
        check("搜索即时过滤订阅源", (n_after or 0) < (n_before or 0), f"{n_before} → {n_after} 个")
        ev(ws, "document.getElementById('manage-search').value = ''")
        ev(ws, "document.getElementById('manage-search').dispatchEvent(new Event('input'))")
        time.sleep(0.4)
        ev(ws, "document.getElementById('btn-open-newgroup').click()")
        time.sleep(0.6)
        check("新建分组弹窗打开", not ev(ws, "document.getElementById('modal-newgroup').hidden"))
        ev(ws, "document.getElementById('new-group-name').value = '测试分组'")
        ev(ws, "document.getElementById('btn-create-group').click()")
        time.sleep(1.8)
        check("新建后弹窗关闭", ev(ws, "document.getElementById('modal-newgroup').hidden"))
        check("分组出现在列表里", ev(ws, "[...document.querySelectorAll('#group-chips .chip')].some(c => c.textContent.includes('测试分组'))"))
        shot(ws, "m8-manage.png")
        gid = ev(ws, "(() => { const c = [...document.querySelectorAll('#group-chips .chip')].find(c => c.textContent.includes('测试分组')); return c ? c.dataset.gid : null; })()")
        if gid:
            ev(ws, "document.querySelector('[data-del-group=\"%s\"]').click()" % gid)
            time.sleep(1.4)
        check("测试分组已清理", not ev(ws, "[...document.querySelectorAll('#group-chips .chip')].some(c => c.textContent.includes('测试分组'))"))
        ev(ws, "document.querySelector('#modal-manage [data-close=manage]').click()")
        time.sleep(0.5)

        print("== 订阅源信息：删除订阅源入口 ==")
        ev(ws, "document.querySelector('.src-entry[data-scope=feed]').click()")
        time.sleep(2.6)
        ev(ws, "document.getElementById('btn-feed-info').click()")
        time.sleep(0.8)
        check("信息弹窗已打开", not ev(ws, "document.getElementById('modal-feed').hidden"))
        check("有删除订阅源按钮", ev(ws, "!!document.getElementById('btn-delete-feed')"))
        check("按钮文字为删除订阅源", ev(ws, "document.getElementById('btn-delete-feed').textContent.trim()") == "删除订阅源")
        shot(ws, "m9-feed-delete.png")
        ev(ws, "document.querySelector('#modal-feed [data-close=feed]').click()")
        time.sleep(0.5)

        print("== 默认只看未读 + 加载更久 ==")
        ev(ws, "document.body.dataset.view = 'sources'")
        time.sleep(0.4)
        ev(ws, "document.querySelector('.src-entry[data-scope=feed]').click()")
        time.sleep(3.8)
        stat = json.loads(ev(ws, """(() => {
          const its = [...document.querySelectorAll('.item')];
          const box = document.getElementById('item-list');
          const un = document.querySelector('.item.unread');
          return JSON.stringify({
            n: its.length,
            read: its.filter(e => !e.classList.contains('unread')).length,
            pubs: its.map(e => e.dataset.pub).filter(Boolean),
            unTop: un ? Math.round(un.getBoundingClientRect().top - box.getBoundingClientRect().top) : null,
          });
        })()""") or "{}")
        check("有文章", (stat.get("n") or 0) > 3, f"{stat.get('n')} 条")
        check("默认列表只有未读", stat.get("read") == 0, f"已读 {stat.get('read')} 条")
        check("旧在上新在下", stat.get("pubs") == sorted(stat.get("pubs") or []))
        ut = stat.get("unTop")
        check("最旧未读贴在屏幕上方", ut is not None and -6 <= ut <= 60, f"距顶 {ut}px")
        check("底部是「已是最新」提示", ev(ws, "!document.getElementById('latest-tip').hidden"))
        check("无「全部/未读/收藏」筛选条", ev(ws, "!document.getElementById('segbar')"))
        check("左栏无「全部文章」入口", ev(ws, "[...document.querySelectorAll('.src-entry')].every(e => !e.textContent.includes('全部文章'))"))
        check("顶部不再有「加载更久」栏", ev(ws, "!document.getElementById('load-older')"))
        check("左栏有「⭐️ 收藏」入口", ev(ws, "[...document.querySelectorAll('.src-entry')].some(e => e.textContent.includes('⭐️ 收藏'))"))
        shot(ws, "m10-unread-only.png")

        n1 = stat.get("n") or 0
        # 触底加载：滚到顶部（列表已贴顶，用 JS 直接触发一次滚动加载）
        ev(ws, "document.getElementById('item-list').scrollTop = 1")
        time.sleep(0.3)
        ev(ws, "document.getElementById('item-list').scrollTop = 0")
        time.sleep(3.4)
        stat2 = json.loads(ev(ws, """(() => {
          const its = [...document.querySelectorAll('.item')];
          return JSON.stringify({n: its.length, read: its.filter(e => !e.classList.contains('unread')).length});
        })()""") or "{}")
        check("向上滚动可加载更久（含已读）", (stat2.get("n") or 0) >= n1, f"{n1} → {stat2.get('n')} 条，已读 {stat2.get('read')}")
        shot(ws, "m11-loaded-older.png")

        print("== 未读清空后给空状态 + 可看更久 ==")
        req = urllib.request.Request(
            base + "/api/read-all", data=b"{}", method="POST",
            headers={"content-type": "application/json", "cookie": f"ant_session={token}",
                     "user-agent": "Mozilla/5.0 Chrome/140.0 Safari/537.36"})
        urllib.request.urlopen(req, timeout=60).read()
        ev(ws, "document.body.dataset.view = 'sources'")
        cdp(ws, "Emulation.setDeviceMetricsOverride",
            {"width": 390, "height": 844, "deviceScaleFactor": 2, "mobile": True})
        time.sleep(0.5)
        ev(ws, "document.querySelector('.src-entry[data-scope=feed]').click()")
        time.sleep(3.2)
        check("未读为空时给空状态", ev(ws, "!!document.querySelector('.empty .big')"))
        big = ev(ws, "document.querySelector('.empty .big').textContent")
        check("空状态文案为「没有未读」", "没有未读" in (big or ""), big)
        check("提供「查看更久的文章」入口", ev(ws, "!!document.getElementById('btn-load-older')"))
        shot(ws, "m5-no-unread.png")
        ev(ws, "document.getElementById('btn-load-older').click()")
        time.sleep(3.2)
        n_hist = ev(ws, "document.querySelectorAll('.item').length")
        check("点后可看到历史文章", (n_hist or 0) > 0, f"{n_hist} 条")
        shot(ws, "m12-history.png")

        ws.close()
    finally:
        chrome.terminate()
        try:
            chrome.wait(timeout=5)
        except Exception:
            chrome.kill()

    print()
    if fails:
        print(f"✗ {len(fails)} 项失败：{fails}")
        return 1
    print("✓ UI 验收全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
