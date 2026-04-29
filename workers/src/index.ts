import { Env } from './types';
import { handleScheduled } from './scheduler';

export default {
  // HTTP 요청 처리 (대시보드 API)
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS 헤더
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
      // ─── 대시보드 데이터 API ───

      // GET /api/dashboard - 메인 통계
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

      // GET /api/products - 상품 목록
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

      // POST /api/products - 상품 수동 등록
      if (path === '/api/products' && request.method === 'POST') {
        const body = await request.json() as any;
        const result = await env.DB.prepare(
          `INSERT INTO products (name, keyword, smart_store_url, price, margin_rate, status)
           VALUES (?, ?, ?, ?, ?, 'active')`
        )
          .bind(body.name, body.keyword, body.smart_store_url, body.price, body.margin_rate)
          .run();

        return json({ id: result.meta.last_row_id, message: '상품이 등록되었습니다' }, 201);
      }

      // PUT /api/products/:id - 상품 상태 변경
      if (path.match(/^\/api\/products\/\d+$/) && request.method === 'PUT') {
        const id = path.split('/').pop();
        const body = await request.json() as any;
        await env.DB.prepare(
          `UPDATE products SET status = ?, updated_at = datetime('now') WHERE id = ?`
        ).bind(body.status, id).run();
        return json({ message: '업데이트 완료' });
      }

      // GET /api/campaigns - 캠페인 목록
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
           ORDER BY c.created_at DESC
           LIMIT 50`
        ).all();
        return json(result.results);
      }

      // GET /api/metrics/chart - 차트 데이터 (최근 30일)
      if (path === '/api/metrics/chart' && request.method === 'GET') {
        const days = parseInt(url.searchParams.get('days') || '30');
        const since = new Date();
        since.setDate(since.getDate() - days);

        const result = await env.DB.prepare(
          `SELECT date, SUM(spend) as spend, SUM(revenue) as revenue,
                  SUM(purchases) as purchases, AVG(roas) as roas, SUM(clicks) as clicks
           FROM ad_metrics
           WHERE date >= ?
           GROUP BY date
           ORDER BY date ASC`
        ).bind(since.toISOString().split('T')[0]).all();

        return json(result.results);
      }

      // GET /api/trends - 수집된 트렌드 키워드
      if (path === '/api/trends' && request.method === 'GET') {
        const result = await env.DB.prepare(
          `SELECT * FROM trend_keywords ORDER BY trend_score DESC LIMIT 50`
        ).all();
        return json(result.results);
      }

      // POST /api/run/:job - 수동 Job 실행 (테스트용)
      if (path.match(/^\/api\/run\/.+$/) && request.method === 'POST') {
        const jobName = path.split('/').pop();
        if (!jobName) return json({ error: 'job name required' }, 400);

        // 직접 job 함수를 실행 (scheduler의 시간 분기를 우회)
        const { runJobDirectly } = await import('./scheduler');
        
        // 비동기로 실행하되 ctx.waitUntil 대신 직접 await (수동 실행이므로 응답 대기)
        try {
          const result = await runJobDirectly(env, jobName);
          return json({ message: `${jobName} 완료`, result });
        } catch (e: any) {
          return json({ message: `${jobName} 실패`, error: e.message }, 500);
        }
      }

      // GET /api/logs - 자동화 로그
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

  // Cron 트리거 처리
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    await handleScheduled(event, env);
  },
};
