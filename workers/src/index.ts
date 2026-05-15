import { Env } from './types';
import { handleScheduled } from './scheduler';
import { search1688 } from './search1688';
import { registerCoupangProduct, getCoupangProduct, convertToCoupangProduct } from './coupang';
import { crawlCostcoDeals } from './costco';

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
      // 알리익스프레스 상품 검색 (RapidAPI)
      // ══════════════════════════════════════════

      if (path === '/api/search/1688' && request.method === 'GET') {
        const keyword = url.searchParams.get('keyword');
        const page = parseInt(url.searchParams.get('page') || '1');
        if (!keyword) return json({ error: 'keyword 파라미터가 필요합니다' }, 400);

        const cacheKey = `search_v2:${keyword}:${page}`;
        const cached = await env.CACHE.get(cacheKey);
        if (cached) {
          return new Response(cached, {
            headers: { 'Content-Type': 'application/json', ...corsHeaders, 'X-Cache': 'HIT' },
          });
        }

        const products = await search1688(keyword, page, env.RAPIDAPI_KEY);
        const resultJson = JSON.stringify({ products, keyword, page, total: products.length });
        const isMock = products[0]?.id?.startsWith('mock_');
        await env.CACHE.put(cacheKey, resultJson, { expirationTtl: isMock ? 60 : 3600 });

        return new Response(resultJson, {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // ══════════════════════════════════════════
      // 쿠팡 상품 자동 등록
      // ══════════════════════════════════════════

      if (path === '/api/coupang/register' && request.method === 'POST') {
        const body = await request.json() as any;
        const { title, keyword, suggested_sell_price, image_url, detail_url, id: productDbId } = body;
        if (!title || !keyword) return json({ error: 'title, keyword 필수' }, 400);

        const coupangProduct = convertToCoupangProduct(env, {
          title,
          keyword,
          suggested_sell_price: suggested_sell_price || 20000,
          image_url: image_url || '',
          detail_url: detail_url || '',
        });

        const result = await registerCoupangProduct(env, coupangProduct);

        if (result.success && result.productId) {
          const coupangUrl = `https://www.coupang.com/vp/products/${result.productId}`;

          // DB에 상품 저장
          const existing = productDbId
            ? await env.DB.prepare(`SELECT id FROM products WHERE id = ?`).bind(productDbId).first()
            : null;

          if (existing) {
            await env.DB.prepare(
              `UPDATE products SET coupang_product_id = ?, coupang_url = ?, status = 'active', updated_at = datetime('now') WHERE id = ?`
            ).bind(result.productId, coupangUrl, productDbId).run();
          } else {
            await env.DB.prepare(
              `INSERT INTO products (name, keyword, coupang_product_id, coupang_url, price, margin_rate, source_url, source_image, status, score)
               VALUES (?, ?, ?, ?, ?, 60, ?, ?, 'active', 50)`
            ).bind(title, keyword, result.productId, coupangUrl, suggested_sell_price, detail_url, image_url).run();
          }

          return json({ success: true, productId: result.productId, coupangUrl, message: '쿠팡에 상품이 등록되었습니다!' }, 201);
        } else {
          return json({ success: false, error: result.error }, 400);
        }
      }

      // GET /api/coupang/product/:id
      if (path.match(/^\/api\/coupang\/product\/\d+$/) && request.method === 'GET') {
        const productId = parseInt(path.split('/').pop()!);
        const product = await getCoupangProduct(env, productId);
        if (!product) return json({ error: '상품을 찾을 수 없습니다' }, 404);
        return json(product);
      }

      // ══════════════════════════════════════════
      // 검색 상품 DB 등록
      // ══════════════════════════════════════════

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

      // ══════════════════════════════════════════
      // 대시보드
      // ══════════════════════════════════════════

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

      // ══════════════════════════════════════════
      // 상품 관리
      // ══════════════════════════════════════════

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

      if (path === '/api/products' && request.method === 'POST') {
        const body = await request.json() as any;
        const result = await env.DB.prepare(
          `INSERT INTO products (name, keyword, smart_store_url, price, margin_rate, status) VALUES (?, ?, ?, ?, ?, 'active')`
        ).bind(body.name, body.keyword, body.smart_store_url, body.price, body.margin_rate).run();
        return json({ id: result.meta.last_row_id, message: '상품이 등록되었습니다' }, 201);
      }

      if (path.match(/^\/api\/products\/\d+$/) && request.method === 'PUT') {
        const id = path.split('/').pop();
        const body = await request.json() as any;
        await env.DB.prepare(`UPDATE products SET status = ?, updated_at = datetime('now') WHERE id = ?`).bind(body.status, id).run();
        return json({ message: '업데이트 완료' });
      }

      // ══════════════════════════════════════════
      // 캠페인 / 차트 / 트렌드 / 로그
      // ══════════════════════════════════════════

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

      if (path === '/api/trends' && request.method === 'GET') {
        const result = await env.DB.prepare(`SELECT * FROM trend_keywords ORDER BY trend_score DESC LIMIT 50`).all();
        return json(result.results);
      }

      // ══════════════════════════════════════════
      // 코스트코 특가 상품 크롤링
      // ══════════════════════════════════════════

      if (path === '/api/costco' && request.method === 'GET') {
        const page = parseInt(url.searchParams.get('page') || '0');
        const size = parseInt(url.searchParams.get('size') || '20');
        const nocache = url.searchParams.get('nocache') === '1';

        const cacheKey = `costco:page:${page}:${size}`;

        if (!nocache) {
          const cached = await env.CACHE.get(cacheKey);
          if (cached) {
            return new Response(cached, {
              headers: { 'Content-Type': 'application/json', ...corsHeaders, 'X-Cache': 'HIT' },
            });
          }
        }

        const data = await crawlCostcoDeals(page, size);
        const resultJson = JSON.stringify(data);
        // 10분 캐시 (nocache=1이어도 결과 자체는 캐싱해서 다음 요청엔 활용)
        await env.CACHE.put(cacheKey, resultJson, { expirationTtl: 600 });

        return new Response(resultJson, {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

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
