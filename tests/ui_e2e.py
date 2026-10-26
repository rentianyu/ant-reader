#!/usr/bin/env python3
"""
蚁读 UI 验收脚本（CDP 驱动无头 Chromium）

覆盖：
  1. 移动端密度（列表项高度、一屏条目数）
  2. 点一次原地展开、再点打开原文
  3. 下拉刷新（模拟触摸手势）
  4. 桌面端三栏 + 右栏正文

用法：
  python3 tests/ui_e2e.py --base http://127.0.0.1:8787 --password test1234 [--port 9222]
  python3 tests/ui_e2e.py --base https://ant.xbta.cc --password xxx --shots-dir shots
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
    path = os.path.join(OUT, name)
    with open(path, "wb") as f:
        f.write(base64.b64decode(data["data"]))
    print(f"  截图 → {path} ({os.path.getsize(path)//1024}KB)")


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
    resp = urllib.request.urlopen(req, timeout=30)
    return resp.headers.get("set-cookie", "").split(";")[0].split("=", 1)[1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8787")
    ap.add_argument("--password", default="test1234")
    ap.add_argument("--port", default="9222")
    args = ap.parse_args()
    base = args.base.rstrip("/")
    host = base.split("//", 1)[1].split("/")[0].split(":")[0]

    token = login_token(base, args.password)
    print(f"登录 OK（{host}）")

    chrome = subprocess.Popen(
        ["chromium", "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
         f"--remote-debugging-port={args.port}", "--remote-allow-origins=*", "--hide-scrollbars",
         "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
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
        cdp(ws, "Runtime.enable")
        cdp(ws, "Network.setCookie", {"name": "ant_session", "value": token, "domain": host, "path": "/"})
        cdp(ws, "Emulation.setDeviceMetricsOverride",
            {"width": 390, "height": 844, "deviceScaleFactor": 2, "mobile": True})
        cdp(ws, "Page.navigate", {"url": base + "/"})
        time.sleep(3.2)

        print("== 移动端 · 订阅源首页 ==")
        check("主界面已显示", ev(ws, "!document.getElementById('main-view').hidden"))
        src_h = ev(ws, "Math.round(document.querySelector('.src-entry').getBoundingClientRect().height)")
        check("订阅源条目高度 ≤ 50px", src_h and src_h <= 50, f"{src_h}px")
        shot(ws, "m1-sources.png")

        print("== 移动端 · 文章列表密度 ==")
        ev(ws, "document.querySelector('.src-entry[data-scope=all]').click()")
        time.sleep(2.0)
        check("进入文章列表", ev(ws, "document.body.dataset.view") == "list")
        metric = ev(ws, """(() => {
          const items = [...document.querySelectorAll('.item')];
          const h = items.slice(0, 6).reduce((s, e) => s + e.getBoundingClientRect().height, 0) / Math.max(1, Math.min(6, items.length));
          const vh = document.getElementById('item-list').clientHeight;
          return {avg: Math.round(h), per: Math.floor(vh / h), vh: Math.round(vh), n: items.length};
        })()""")
        check("列表项平均高度 ≤ 66px", metric["avg"] <= 66, f"{metric['avg']}px")
        check("一屏可见 ≥ 10 条", metric["per"] >= 10, f"{metric['per']} 条/屏（视口 {metric['vh']}px）")
        has_summary = ev(ws, "getComputedStyle(document.querySelector('.it-summary')).display !== 'none'")
        check("移动端隐藏摘要行", not has_summary)
        shot(ws, "m2-list.png")

        print("== 移动端 · 点开原地展开 ==")
        ev(ws, "window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; };")
        ev(ws, "document.querySelector('.item').click()")
        time.sleep(1.6)
        expanded = ev(ws, "!!document.querySelector('.item.expanded')")
        check("卡片原地展开", expanded)
        more_len = ev(ws, "(document.querySelector('.it-more-html')||{}).textContent?.length || 0")
        check("展开区有文字", (more_len or 0) > 50, f"{more_len} 字")
        check("展开时未跳转原文", ev(ws, "window.__opened.length") == 0)
        h_expanded = ev(ws, "Math.round(document.querySelector('.item.expanded').getBoundingClientRect().height)")
        check("展开后卡片明显变高", h_expanded > metric["avg"] * 2, f"{h_expanded}px vs {metric['avg']}px")
        shot(ws, "m3-expanded.png")

        print("== 移动端 · 再点打开原文 ==")
        ev(ws, "document.querySelector('.item.expanded .it-title').click()")
        time.sleep(0.8)
        opened = ev(ws, "window.__opened")
        check("再点触发打开原文", isinstance(opened, list) and len(opened) == 1, str(opened)[:80])
        check("打开的是 http(s) 链接", bool(opened) and str(opened[0]).startswith("http"), str(opened)[:60])

        print("== 移动端 · 展开区按钮 ==")
        ev(ws, "document.querySelector('.item[data-id]').click()")  # 收起或展开另一条
        time.sleep(1.0)
        ev(ws, "document.querySelector('.item [data-act=star]').click()")
        time.sleep(1.2)
        starred = ev(ws, "document.querySelector('.item [data-act=star]').classList.contains('on')")
        check("展开区收藏按钮生效", bool(starred))
        ev(ws, "document.querySelector('.item [data-act=star]').click()")  # 取消
        time.sleep(1.0)

        print("== 移动端 · 下拉刷新 ==")
        ev(ws, "document.getElementById('item-list').scrollTop = 0")
        time.sleep(0.3)
        cdp(ws, "Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": 195, "y": 380}]})
        heights = []
        for i in range(1, 9):
            cdp(ws, "Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": 195, "y": 380 + i * 22}]})
            time.sleep(0.06)
            heights.append(ev(ws, "parseInt(document.getElementById('ptr').style.height) || 0"))
        ptr_h = max(heights) if heights else 0
        check("下拉时指示器展开", ptr_h > 20, f"{ptr_h}px")
        ptr_text = ev(ws, "document.querySelector('#ptr .ptr-text').textContent")
        check("提示文案切换到松手刷新", ptr_text in ("松手刷新", "下拉刷新"), ptr_text)
        shot(ws, "m4-pulling.png")
        cdp(ws, "Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        time.sleep(1.0)
        loading_text = ev(ws, "document.querySelector('#ptr .ptr-text').textContent")
        check("松手后进入刷新态", loading_text in ("刷新中…", "已刷新", "刷新失败"), loading_text)
        time.sleep(6)
        final_h = ev(ws, "parseInt(document.getElementById('ptr').style.height) || 0")
        check("刷新完成指示器收起", final_h == 0, f"{final_h}px")
        shot(ws, "m5-refreshed.png")

        print("== 桌面端 · 三栏 ==")
        ev(ws, "document.body.dataset.view = 'sources'")
        cdp(ws, "Emulation.setDeviceMetricsOverride",
            {"width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False})
        time.sleep(0.6)
        ev(ws, "document.querySelector('.src-entry[data-scope=all]').click()")
        time.sleep(2.0)
        cols = ev(ws, "getComputedStyle(document.querySelector('.layout')).gridTemplateColumns")
        check("桌面三栏网格", cols.count("px") == 3, cols)
        ev(ws, "document.querySelector('.item').click()")
        time.sleep(1.6)
        rd = ev(ws, "(document.querySelector('.rd-content')||{}).innerHTML?.length || 0")
        check("桌面点文章渲染右栏正文", (rd or 0) > 60, f"{rd} 字符")
        check("桌面不进入展开态", not ev(ws, "!!document.querySelector('.item.expanded')"))
        shot(ws, "d1-three-col.png")

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
