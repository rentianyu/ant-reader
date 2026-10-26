#!/usr/bin/env python3
"""线上只读探针：登录 → 测量移动端密度 → 截图（不点击卡片，不改动任何数据）

用法：PASS='xxx' python3 tests/online_probe.py --base https://ant.xbta.cc
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

_mid = [0]


def cdp(ws, method, params=None):
    _mid[0] += 1
    mid = _mid[0]
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    deadline = time.time() + 60
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
    return r.get("result", {}).get("value")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="https://ant.xbta.cc")
    ap.add_argument("--port", default="9555")
    args = ap.parse_args()
    base = args.base.rstrip("/")
    host = base.split("//", 1)[1].split("/")[0].split(":")[0]
    password = os.environ.get("PASS", "")

    req = urllib.request.Request(
        base + "/api/login",
        data=json.dumps({"password": password}).encode(),
        headers={
            "content-type": "application/json",
            "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/140.0 Safari/537.36",
        },
    )
    token = urllib.request.urlopen(req, timeout=40).headers.get("set-cookie", "").split(";")[0].split("=", 1)[1]
    print("登录成功")

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
        ws = websocket.create_connection(ws_url, timeout=60, suppress_origin=True)
        cdp(ws, "Page.enable")
        cdp(ws, "Network.enable")
        cdp(ws, "Network.setCookie", {"name": "ant_session", "value": token, "domain": host, "path": "/"})
        cdp(ws, "Emulation.setDeviceMetricsOverride",
            {"width": 390, "height": 844, "deviceScaleFactor": 2, "mobile": True})
        cdp(ws, "Page.navigate", {"url": base + "/"})
        time.sleep(5)

        print("已登录进首页:", ev(ws, "!document.getElementById('main-view').hidden"))
        print("订阅源条目:", ev(ws, "document.querySelectorAll('.src-entry').length"),
              "高度:", ev(ws, "Math.round(document.querySelector('.src-entry')?.getBoundingClientRect().height || 0)"), "px")
        shot(ws, "online-1-sources.png")

        ev(ws, "document.querySelector('.src-entry[data-scope=all]').click()")
        time.sleep(3)
        metric = ev(ws, """(() => {
          const items = [...document.querySelectorAll('.item')];
          if (!items.length) return {n: 0};
          const h = items.slice(0, 8).reduce((s, e) => s + e.getBoundingClientRect().height, 0) / Math.min(8, items.length);
          const vh = document.getElementById('item-list').clientHeight;
          return {n: items.length, avg: Math.round(h), per: Math.floor(vh / h), vh: Math.round(vh)};
        })()""")
        print("列表:", metric)
        print("标题行数:", ev(ws, """(() => {
          const t = document.querySelector('.it-title');
          const lh = parseFloat(getComputedStyle(t).lineHeight) || 21;
          return Math.round(t.getBoundingClientRect().height / lh);
        })()"""))
        shot(ws, "online-2-list.png")

        # 滑到底，看已读段是否追加（只读操作，不改数据）
        ev(ws, "document.getElementById('item-list').scrollTop = 99999")
        time.sleep(3.5)
        print("已读分隔出现:", ev(ws, "!!document.querySelector('.seg-divider')"))
        print("列表总条数:", ev(ws, "document.querySelectorAll('.item').length"))
        shot(ws, "online-3-read-seg.png")
        ws.close()
    finally:
        chrome.terminate()
        try:
            chrome.wait(timeout=5)
        except Exception:
            chrome.kill()
    return 0


def shot(ws, name):
    data = cdp(ws, "Page.captureScreenshot", {"format": "png"})
    out = "/sandbox/workspace/ant-reader/shots"
    os.makedirs(out, exist_ok=True)
    p = os.path.join(out, name)
    open(p, "wb").write(base64.b64decode(data["data"]))
    print("截图 →", p, f"({os.path.getsize(p)//1024}KB)")


if __name__ == "__main__":
    sys.exit(main())
