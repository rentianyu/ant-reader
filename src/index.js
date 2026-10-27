import { handleApi } from './api.js';
import { feedsForRefresh, getSetting } from './db.js';
import { syncFeed } from './feeds.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }

    // 静态资源（SPA）
    return env.ASSETS.fetch(request);
  },

  /**
   * 定时抓取：按 last_fetch_at 升序轮转，每次最多 40 个订阅源，
   * 并发 5 个，兼顾 Workers 子请求上限与执行时长。
   */
  async scheduled(event, env, ctx) {
    const job = async () => {
      const limit = parseInt(await getSetting(env.DB, 'cron_batch_size', '40'), 10) || 40;
      const feeds = await feedsForRefresh(env.DB, limit);
      if (!feeds.length) return;

      const concurrency = 5;
      let cursor = 0;
      let added = 0;
      const failed = [];

      const worker = async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= feeds.length) return;
          try {
            const r = await syncFeed(env, feeds[idx]);
            added += r.added;
          } catch (err) {
            failed.push(`${feeds[idx].title || feeds[idx].url}: ${err?.message || err}`);
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, feeds.length) }, worker));

      // 保留策略：默认不按天数清理（每个源 300 条的硬上限在抓取时已处理）
      try {
        const retention = parseInt(await getSetting(env.DB, 'retention_days', '0'), 10);
        if (retention > 0) {
          const cutoff = Date.now() - retention * 86400000;
          await env.DB.prepare('DELETE FROM items WHERE is_read = 1 AND is_starred = 0 AND COALESCE(published_at, fetched_at) < ?')
            .bind(cutoff)
            .run();
        }
      } catch (err) {
        console.warn('retention cleanup failed', err);
      }

      console.log(`[cron] feeds=${feeds.length} added=${added} failed=${failed.length}`);
    };

    ctx.waitUntil(job());
  },
};
