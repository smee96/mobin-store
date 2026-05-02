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

      // ── 상품 검색 (AliExpress Datahub via RapidAPI) ──
      if (path === '/api/search/1688' && request.method === 'GET') {
        const keyword = url.searchParams.get('keyword');
        const page = parseInt(url.searchParams.get('page') || '1');
        if (!keyword) return json({ error: 'keyword 파라미터가 필요합니다' }, 400);

        // KV 캐시 확인 (1시간)
        const cacheKey = `search:${keyword}:${page}`;
        const cached = await env.CACHE.get(cacheKey);
        if (cached) {
          return new Response(cached, {
            headers: { 'Content-Type': 'application/json', ...corsHeaders, 'X-Cache': 'HIT' },
          });
        }

        // RapidAPI Key를 env에서 전달
        const products = await search1688(keyword, page, env.RAPIDAPI_KEY);
        const resultJson = JSON.stringify({ products, keyword, page, total: products.length });

        // 실제 데이터면 캐시 저장, 목업이면 짧게 캐시
        const isMock = products[0]?.id?.startsWith('mock_');
        await env.CACHE.put(cacheKey, resultJson, { expirationTtl: isMock ? 60 : 3600 });

        return new Response(resultJson, {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // ── 검색 상품 DB 등록 ──
      if (path === '/api/search/register' && request.method === 'POST') {
        const body = await request.json() as any;
        const { title, keyword, price_min_krw, suggested_sell_price, image_url, detail_url, estimated_margin } = body;
        if (!title || !keyword) return json({ error: 'title, keyword 필수' }, 400);

        const existing = await env.DB.prepare(
          `SELECT id FROM products WHERE keyword = ? AND source_url = ?`
        ).bind(keyword, detail_url || '').first();
        if (existing) return json({ error: '이미 등록된 상품입니다', id: (existing as any).id }, 409);

        const result = await env.DB.prepare(
          `INSERT INTO products (name, keyword, price, margin_rate, source_url, source_image, status, score)
           VALUES (?, ?, ?, ?, ?, ?, 'active', 50)`
        ).bind(title, keyword, suggested_sell_price || price_min_krw * 3, estimated_margin || 60, detail_url || '', image_url || '').run();

        return json({ id: result.meta.last_row_id, message: '상품이 등록되었습니다!' }, 201);
      }

      // ── 대시보드 ──
      if (path === '/api/dashboard' && request.method === 'GET') {
        const today = new Date().toISOString().split('T')[0];
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const since = thirtyDaysAgo.toISOString().split('T')[0];

        const [products, campaigns, todayMetrics, monthMetrics, recentLogs] = await Promise.all([
          env.DB.prepare(`SELECT status, COUNT(*) as cnt FROM products GROUP BY status`).all(),
          env.DB.prepare(`SELECT status, COUNT(*) as cnt FROM campaigns GROUP BY status`).all(),
          env.DB.prepare(`SELECT SUM(spend) as spend, SUM(revenue) as revenue, SUM(purchases) as purchases, AVG(roas) as roas, SUM(clicks) as clicks FROM ad_metrics WHERE date = ?`).bind(today).first(),
          env.DB.prepare(`SELECT SUM(spend) as spend, SUM(revenue) as revenue, SUM(purchases) as purchases, AVG(roas) as roas FROM ad_metrics WHERE date >= ?`).bind(since).first(),
          env.DB.prepare(`SELECT * FROM automation_logs ORDER BY started_at DESC LIMIT 10`).all(),
        ]);

        return json({ products: products.results, campaigns: campaigns.results, today: todayMetrics, month: monthMetrics, logs: recentLogs.results });
      }

      // ── 상품 목록 ──
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

      // ── 상품 등록 ──
      if (path === '/api/products' && request.method === 'POST') {
        const body = await request.json() as any;
        const result = await env.DB.prepare(
          `INSERT INTO products (name, keyword, smart_store_url, price, margin_rate, status) VALUES (?, ?, ?, ?, ?, 'active')`
        ).bind(body.name, body.keyword, body.smart_store_url, body.price, body.margin_rate).run();
        return json({ id: result.meta.last_row_id, message: '상품이 등록되었습니다' }, 201);
      }

      // ── 상품 상태 변경 ──
      if (path.match(/^\/api\/products\/\d+$/) && request.method === 'PUT') {
        const id = path.split('/').pop();
        const body = await request.json() as any;
        await env.DB.prepare(`UPDATE products SET status = ?, updated_at = datetime('now') WHERE id = ?`).bind(body.status, id).run();
        return json({ message: '업데이트 완료' });
      }

      // ── 캠페인 ──
      if (path === '/api/campaigns' && request.method === 'GET') {
        const result = await env.DB.prepare(
          `SELECT c.*, p.name as product_name, p.keyword, ac.headline, ac.body_text,
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

      // ── 차트 데이터 ──
      if (path === '/api/metrics/chart' && request.method === 'GET') {
        const days = parseInt(url.searchParams.get('days') || '30');
        const since = new Date();
        since.setDate(since.getDate() - days);
        const result = await env.DB.prepare(
          `SELECT date, SUM(spend) as spend, SUM(revenue) as revenue, SUM(purchases) as purchases, AVG(roas) as roas, SUM(clicks) as clicks
           FROM ad_metrics WHERE date >= ? GROUP BY date ORDER BY date ASC`
        ).bind(since.toISOString().split('T')[0]).all();
        return json(result.results);
      }

      // ── 트렌드 키워드 ──
      if (path === '/api/trends' && request.method === 'GET') {
        const result = await env.DB.prepare(`SELECT * FROM trend_keywords ORDER BY trend_score DESC LIMIT 50`).all();
        return json(result.results);
      }

      // ── 수동 Job 실행 ──
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

      // ── 로그 ──
      if (path === '/api/logs' && request.method === 'GET') {
        const result = await env.DB.prepare(`SELECT * FROM automation_logs ORDER BY started_at DESC LIMIT 30`).all();
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
