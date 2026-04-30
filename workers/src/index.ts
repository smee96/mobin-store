import { Env } from './types';
import { handleScheduled } from './scheduler';
import { search1688 } from './search1688';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });

    try {

      // ══════════════════════════════════════════
      // 상품 검색 API (신규)
      // ══════════════════════════════════════════

      // GET /api/search/1688?keyword=폼롤러&page=1
      if (path === '/api/search/1688' && request.method === 'GET') {
        const keyword = url.searchParams.get('keyword');
        const page = parseInt(url.searchParams.get('page') || '1');

        if (!keyword) return json({ error: 'keyword 파라미터가 필요합니다' }, 400);

        // KV 캐시 확인 (같은 키워드 1시간 캐시)
        const cacheKey = `search1688:${keyword}:${page}`;
        const cached = await env.CACHE.get(cacheKey);
        if (cached) {
          return new Response(cached, {
            headers: { 'Content-Type': 'application/json', ...corsHeaders, 'X-Cache': 'HIT' },
          });
        }

        const products = await search1688(keyword, page);

        // 결과 캐시 저장 (1시간)
        const resultJson = JSON.stringify({ products, keyword, page, total: products.length });
        await env.CACHE.put(cacheKey, resultJson, { expirationTtl: 3600 });

        return new Response(resultJson, {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // POST /api/search/register - 검색한 상품을 스마트스토어 상품으로 등록
      if (path === '/api/search/register' && request.method === 'POST') {
        const body = await request.json() as any;
        const {
          title, keyword, price_min_krw, suggested_sell_price,
          image_url, detail_url, source, estimated_margin
        } = body;

        if (!title || !keyword) return json({ error: 'title, keyword 필수' }, 400);

        // 이미 등록된 상품인지 확인
        const existing = await env.DB.prepare(
          `SELECT id FROM products WHERE keyword = ? AND source_url = ?`
        ).bind(keyword, detail_url || '').first();

        if (existing) return json({ error: '이미 등록된 상품입니다', id: (existing as any).id }, 409);

        const result = await env.DB.prepare(
          `INSERT INTO products
            (name, keyword, smart_store_url, price, margin_rate, source_url, source_image, status, score)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 50)`
        ).bind(
          title,
          keyword,
          '',                          // 스마트스토어 URL은 등록 후 업데이트
          suggested_sell_price || price_min_krw * 3,
          estimated_margin || 60,
          detail_url || '',
          image_url || '',
        ).run();

        return json({ id: result.meta.last_row_id, message: '상품이 등록되었습니다! 광고 소재 생성 후 광고가 집행됩니다.' }, 201);
      }

      // ══════════════════════════════════════════
      // 기존 API (변경 없음)
      // ══════════════════════════════════════════

      // GET /api/dashboard
      if (path === '/api/dashboard' && request.method === 'GET') {
        const today = new Date().toISOString().split('T')[0];
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const since = thirtyDaysAgo.toISOString().split('T')[0];

        const [products, campaigns, todayMetrics, monthMetrics, recentLogs] = await Promise.all([
          env.DB.prepare(`SELECT status, COUNT(*) as cnt FROM products GROUP BY status`).all(),
          env.DB.prepare(`SELECT status, COUNT(*) as cnt FROM campaigns GROUP BY status`).all(),
          env.DB.prepare(
            `SELECT SUM(spend) as spend, SUM(revenue) as revenue, SUM(purchases) as purchases,
                    AVG(roas) as roas, SUM(clicks) as clicks
             FROM ad_metrics WHERE date = ?`
          ).bind(today).first(),
          env.DB.prepare(
            `SELECT SUM(spend) as spend, SUM(revenue) as revenue, SUM(purchases) as purchases,
                    AVG(roas) as roas
             FROM ad_metrics WHERE date >= ?`
          ).bind(since).first(),
          env.DB.prepare(
            `SELECT * FROM automation_logs ORDER BY started_at DESC LIMIT 10`
          ).all(),
        ]);

        return json({
          products: products.results,
          campaigns: campaigns.results,
          today: todayMetrics,
          month: monthMetrics,
          logs: recentLogs.results,
        });
      }

      // GET /api/products
      if (path === '/api/products' && request.method === 'GET') {
        const status = url.searchParams.get('status');
        const limit = parseInt(url.searchParams.get('limit') || '20');
        const query = status
          ? `SELECT * FROM products WHERE status = ? ORDER BY score DESC LIMIT ?`
          : `SELECT * FROM products ORDER BY score DESC LIMIT ?`;
        const result = status
          ? await env.DB.prepare(query).bind(status, limit).all()
          : await env.DB.prepare(query).bind(limit).all();
        return json(result.results);
      }

      // POST /api/products
      if (path === '/api/products' && request.method === 'POST') {
        const body = await request.json() as any;
        const result = await env.DB.prepare(
          `INSERT INTO products (name, keyword, smart_store_url, price, margin_rate, status)
           VALUES (?, ?, ?, ?, ?, 'active')`
        ).bind(body.name, body.keyword, body.smart_store_url, body.price, body.margin_rate).run();
        return json({ id: result.meta.last_row_id, message: '상품이 등록되었습니다' }, 201);
      }

      // PUT /api/products/:id
      if (path.match(/^\/api\/products\/\d+$/) && request.method === 'PUT') {
        const id = path.split('/').pop();
        const body = await request.json() as any;
        await env.DB.prepare(
          `UPDATE products SET status = ?, updated_at = datetime('now') WHERE id = ?`
        ).bind(body.status, id).run();
        return json({ message: '업데이트 완료' });
      }

      // GET /api/campaigns
      if (path === '/api/campaigns' && request.method === 'GET') {
        const result = await env.DB.prepare(
          `SELECT c.*, p.name as product_name, p.keyword,
                  ac.headline, ac.body_text,
                  (SELECT AVG(roas) FROM ad_metrics m WHERE m.campaign_id = c.id) as avg_roas,
                  (SELECT SUM(spend) FROM ad_metrics m WHERE m.campaign_id = c.id) as total_spend,
                  (SELECT SUM(revenue) FROM ad_metrics m WHERE m.campaign_id = c.id) as total_revenue
           FROM campaigns c
           JOIN products p ON c.product_id = p.id
           JOIN ad_creatives ac ON c.creative_id = ac.id
           ORDER BY c.created_at DESC LIMIT 50`
        ).all();
        return json(result.results);
      }

      // GET /api/metrics/chart
      if (path === '/api/metrics/chart' && request.method === 'GET') {
        const days = parseInt(url.searchParams.get('days') || '30');
        const since = new Date();
        since.setDate(since.getDate() - days);
        const result = await env.DB.prepare(
          `SELECT date, SUM(spend) as spend, SUM(revenue) as revenue,
                  SUM(purchases) as purchases, AVG(roas) as roas, SUM(clicks) as clicks
           FROM ad_metrics WHERE date >= ?
           GROUP BY date ORDER BY date ASC`
        ).bind(since.toISOString().split('T')[0]).all();
        return json(result.results);
      }

      // GET /api/trends
      if (path === '/api/trends' && request.method === 'GET') {
        const result = await env.DB.prepare(
          `SELECT * FROM trend_keywords ORDER BY trend_score DESC LIMIT 50`
        ).all();
        return json(result.results);
      }

      // POST /api/run/:job
      if (path.match(/^\/api\/run\/.+$/) && request.method === 'POST') {
        const jobName = path.split('/').pop();
        if (!jobName) return json({ error: 'job name required' }, 400);
        const { runJobDirectly } = await import('./scheduler');
        try {
          const result = await runJobDirectly(env, jobName);
          return json({ message: `${jobName} 완료`, result });
        } catch (e: any) {
          return json({ message: `${jobName} 실패`, error: e.message }, 500);
        }
      }

      // GET /api/logs
      if (path === '/api/logs' && request.method === 'GET') {
        const result = await env.DB.prepare(
          `SELECT * FROM automation_logs ORDER BY started_at DESC LIMIT 30`
        ).all();
        return json(result.results);
      }

      return json({ error: 'Not found' }, 404);

    } catch (e: any) {
      console.error('API error:', e);
      return json({ error: e.message }, 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    await handleScheduled(event, env);
  },
};
