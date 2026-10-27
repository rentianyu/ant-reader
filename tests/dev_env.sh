#!/bin/bash
# 本地开发环境一键恢复（沙箱重置后跑这个）
#   - wrangler 从 .devdeps/wrangler.tgz 解压（免联网重装）
#   - 重建本地 D1（/tmp/wrstate）+ 起 wrangler dev
#   - 灌入 3 个真实订阅源做种子数据
set -e
cd "$(dirname "$0")/.."
export PATH=/tmp/wr/node_modules/.bin:$PATH

if [ ! -x /tmp/wr/node_modules/.bin/wrangler ]; then
  echo "[1/4] 解压 wrangler ..."
  mkdir -p /tmp/wr
  tar xzf .devdeps/wrangler.tgz -C /tmp/wr
else
  echo "[1/4] wrangler 已就绪"
fi

if ! command -v chromium >/dev/null 2>&1; then
  echo "[2/4] 安装 chromium ..."
  apt-get install -y --no-install-recommends chromium fonts-noto-color-emoji >/dev/null 2>&1
else
  echo "[2/4] chromium 已就绪"
fi

echo "[3/4] 重建本地 D1 并启动 dev ..."
pkill -f "wrangler dev" >/dev/null 2>&1 || true
sleep 1
rm -rf /tmp/wrstate
wrangler d1 execute ant-reader-db --local --persist-to /tmp/wrstate --file=./schema.sql >/dev/null 2>&1
nohup wrangler dev --port 8787 --ip 127.0.0.1 --persist-to /tmp/wrstate > /tmp/wrdev.log 2>&1 &
for _ in $(seq 1 30); do
  sleep 1
  if curl -sf --max-time 2 http://127.0.0.1:8787/api/health >/dev/null 2>&1; then break; fi
done
curl -sf --max-time 3 http://127.0.0.1:8787/api/health >/dev/null || { echo "dev 启动失败"; tail -20 /tmp/wrdev.log; exit 1; }

echo "[4/4] 灌入种子数据 ..."
J=/tmp/seed_cookies.txt
rm -f "$J"
curl -s -c "$J" -X POST -H 'content-type: application/json' \
  -d '{"password":"test1234"}' http://127.0.0.1:8787/api/setup >/dev/null
for u in https://www.ruanyifeng.com/blog/atom.xml https://sspai.com/feed https://51.ruyo.net/feed https://www.solidot.org/index.rss https://www.ifanr.com/feed https://www.oschina.net/news/rss; do
  printf '  + %s ' "$u"
  curl -s -b "$J" --max-time 90 -X POST -H 'content-type: application/json' \
    -d "{\"url\":\"$u\"}" http://127.0.0.1:8787/api/feeds | head -c 120
  echo
done

echo "就绪：http://127.0.0.1:8787 （密码 test1234）"
