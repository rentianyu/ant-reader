# 蚁读 · Ant Reader

一个自托管的 RSS 阅读器，界面参照**蚁阅**的视觉语言重写：白底、极浅分割线、单列信息流、线性图标、浅灰胶囊未读徽章、亮蓝作为唯一强调色。后端跑在 **Cloudflare Workers + D1**，零运行时依赖（不打包、不需要 Node 环境即可部署）。

移动端是单列三级页面（订阅源 → 文章 → 阅读），桌面端自动变成三栏（订阅源 / 列表 / 正文）。

## 特性

- **订阅管理**：添加时自动发现 Feed（填站点首页即可）、分组、改名、删除
- **文章**：未读计数、全部/未读/收藏筛选、标记已读/未读、收藏、分页加载
- **阅读**：正文服务端净化后渲染（白名单标签、去脚本、去事件属性、相对链接转绝对），保留图片与排版
- **OPML**：一键导出 / 导入（导入自动建分组、重复源自动跳过）
- **刷新**：单源手动刷新 + Cron 每 30 分钟轮转抓取（按最久未抓排序，每次一批）
- **访问控制**：单用户口令（PBKDF2-SHA256 12 万轮）+ HMAC 签名 HttpOnly Cookie
- **主题**：白天/夜间，跟随本地记忆
- **快捷键**（桌面）：`j`/`k` 上下篇、`o` 打开原文、`m` 已读、`s` 收藏、`r` 刷新
- 兼容 RSS 2.0、Atom 1.0、RSS 1.0 (RDF)、JSON Feed

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Cloudflare Workers | 单文件入口 `src/index.js`，ESM |
| 数据库 | Cloudflare D1 (SQLite) | 订阅源、文章、分组、设置 |
| 静态资源 | Workers Static Assets | `public/` 直接托管，零构建 |
| 定时任务 | Workers Cron Triggers | `*/30 * * * *` |
| 前端 | 原生 HTML/CSS/JS | 无框架、无构建、约 30KB |

**运行时依赖：0**。`package.json` 里只有 `wrangler` 一个 devDependency，用于部署。

## 目录结构

```
ant-reader/
├── src/
│   ├── index.js          # Worker 入口：路由分发 + Cron
│   ├── api.js            # HTTP API（认证、订阅、文章、OPML、设置）
│   ├── db.js             # D1 查询封装
│   ├── feeds.js          # 抓取、同步、Feed 发现、OPML 读写
│   ├── feed-parser.js    # 零依赖 XML 解析 + RSS/Atom/RDF/JSON Feed 归一化
│   ├── sanitize.js       # 正文 HTML 白名单净化
│   └── auth.js           # PBKDF2 口令 + HMAC 会话
├── public/
│   ├── index.html        # SPA 骨架
│   ├── app.css           # 全部样式（含响应式与夜间模式）
│   ├── app.js            # 前端逻辑
│   └── favicon.svg
├── tests/run.mjs         # 核心逻辑单测（57 项）
├── schema.sql            # D1 表结构
└── wrangler.jsonc
```

## 部署

### 1. 准备

```bash
npm install
npx wrangler login        # 或设置 CLOUDFLARE_API_TOKEN 环境变量
```

### 2. 建库

```bash
npx wrangler d1 create ant-reader-db
# 把输出的 database_id 填进 wrangler.jsonc
npx wrangler d1 execute ant-reader-db --remote --file=./schema.sql
```

### 3. 部署

```bash
npx wrangler deploy
```

首次访问站点会引导设置访问密码（至少 4 位），设完即进入。

### 4. 绑定自定义域名（可选）

在 `wrangler.jsonc` 增加：

```jsonc
"routes": [{ "pattern": "rss.example.com/*", "zone_name": "example.com" }]
```

并在 DNS 里加一条 `AAAA rss → 100::`（橙色云 / 已代理）即可。
> 用「DNS 记录 + Worker Route」而不是「Workers 自定义域」，可以避免独立签发证书造成子域名进入 CT 日志。

### 5. 会话密钥（可选）

不设置时，首次启动会在 D1 的 `settings` 表生成一个随机密钥；也可以显式指定：

```bash
npx wrangler secret put SESSION_SECRET
```

## API 一览

所有接口在 `/api` 下，除 `health` / `status` / `setup` / `login` 外都需要会话 Cookie。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | 初始化状态、登录状态、计数 |
| POST | `/setup` | 首次设置密码 |
| POST | `/login` / `/logout` | 登录 / 退出 |
| GET | `/bootstrap` | 分组 + 订阅源 + 计数 + 设置 |
| POST | `/feeds` | 添加订阅（`{url,groupId}`） |
| POST | `/feeds/discover` | 只探测，不入库 |
| PATCH/DELETE | `/feeds/:id` | 改名、换组、删除 |
| POST | `/feeds/:id/refresh` | 刷新单个源 |
| POST | `/refresh` | 批量刷新（按最久未抓排序） |
| GET | `/items` | 列表（`feed_id`/`group_id`/`unread`/`starred`/`q`/`limit`/`offset`） |
| GET/PATCH | `/items/:id` | 详情 / 改已读、收藏 |
| POST | `/read-all` | 全部已读（可限定 feed） |
| GET/POST | `/opml` | 导出 / 导入 |
| POST | `/groups`、PATCH/DELETE `/groups/:id` | 分组 |
| PATCH | `/settings` | 刷新间隔等 |
| POST | `/password` | 改密码 |

## 设计说明

- **为什么自己写 XML 解析**：Workers 没有 DOM，引入 `fast-xml-parser` 就要打包步骤。自带一个 ~200 行的容错解析器，可以覆盖 RSS/Atom/RDF 的常见畸形写法（未转义 HTML、CDATA、命名空间前缀、属性内含 `>`），并且能直接在 Node 里跑单测。
- **为什么不在服务端做正文抓取**：标准版只存 Feed 自带内容。遇到只给摘要的源（如少数派），阅读页底部会出现「去原文阅读」入口。
- **Cron 轮转**：每次取 `last_fetch_at` 最早的 40 个源、并发 5 个抓取，避免 Workers 子请求上限与执行时长问题；订阅源超过 40 个时自动轮转。
- **保留策略**：已读、未收藏、超过 180 天的文章在每次 Cron 后清理（`settings.retention_days` 可调）。

## 测试

```bash
node tests/run.mjs
```

覆盖：XML 解析（RSS2/Atom/RDF/JSON Feed/畸形输入）、实体与 CDATA、Feed 发现、HTML 净化（脚本/事件属性/协议/相对链接）、OPML 解析、口令哈希与会话签名。

## 许可

MIT
