import { Env } from './types';
import { handleScheduled } from './scheduler';
import { search1688 } from './search1688';
import { registerCoupangProduct, getCoupangProduct, convertToCoupangProduct, getCoupangDisplayCategories, fetchReturnCenterCode } from './coupang';
import { getCostcoDealsByKeywords } from './costco';
import { comparePrices } from './priceCompare';

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
        const {
          title, keyword, suggested_sell_price, image_url, all_images, detail_url, costco_price,
          id: productDbId,
          notice_category, adult_only, overseas_yn, buy_count_period, buy_count, return_center_code, category_code, delivery_company_code,
          promo_start_date, promo_end_date,
        } = body;
        if (!title) return json({ error: 'title 필수' }, 400);

        const coupangProduct = await convertToCoupangProduct(env, {
          title,
          keyword: keyword || title.split(' ').slice(0, 3).join(' '),
          suggested_sell_price: suggested_sell_price || 20000,
          image_url: image_url || '',
          all_images: all_images || (image_url ? [image_url] : []),
          detail_url: detail_url || '',
          costco_price: costco_price || 0,
          return_center_code: return_center_code || env.COUPANG_RETURN_CENTER_CODE || '',
          notice_category,
          adult_only,
          overseas_yn,
          buy_count_period,
          buy_count,
          category_code: category_code ? Number(category_code) : undefined,
          delivery_company_code,
          promo_start_date,
          promo_end_date,
        });

        const result = await registerCoupangProduct(env, coupangProduct);

        console.log('register result:', JSON.stringify(result).slice(0, 500));
        if (result.success) {
          const coupangUrl = result.productId ? `https://www.coupang.com/vp/products/${result.productId}` : null;

          // DB에 상품 저장
          const existing = productDbId
            ? await env.DB.prepare(`SELECT id FROM products WHERE id = ?`).bind(productDbId).first()
            : null;

          if (existing) {
            await env.DB.prepare(
              `UPDATE products SET coupang_product_id = ?, coupang_url = ?, status = 'active', updated_at = datetime('now') WHERE id = ?`
            ).bind(result.productId ?? null, coupangUrl ?? null, productDbId).run();
          } else {
            await env.DB.prepare(
              `INSERT INTO products (name, keyword, coupang_product_id, coupang_url, price, margin_rate, source_url, source_image, status, score)
               VALUES (?, ?, ?, ?, ?, 60, ?, ?, 'active', 50)`
            ).bind(title, keyword, result.productId ?? null, coupangUrl ?? null, suggested_sell_price ?? null, detail_url ?? null, image_url ?? null).run();
          }

          return json({ success: true, productId: result.productId, coupangUrl, message: '쿠팡에 상품이 등록되었습니다!' }, 201);
        } else {
          return json({ success: false, error: result.error, _debug: (result as any)._debug }, 400);
        }
      }

      // GET /api/coupang/delivery-companies — 유효한 택배사 코드 목록
      if (path === '/api/coupang/delivery-companies' && request.method === 'GET') {
        const tryPath = async (p: string) => {
          const res = await fetch('https://proxy.mobin-inc.com/proxy/coupang', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-proxy-secret': 'mobin-proxy-2024-xK9mP3nQ' },
            body: JSON.stringify({ path: p, method: 'GET', accessKey: env.COUPANG_ACCESS_KEY, secretKey: env.COUPANG_SECRET_KEY }),
          });
          const d = await res.json() as any;
          return { path: p.split('/').pop(), status: res.status, code: d?.code, data: JSON.stringify(d).slice(0, 500) };
        };
        const results = await Promise.all([
          tryPath(`/v2/providers/seller_api/apis/api/v1/marketplace/vendor/${env.COUPANG_VENDOR_ID}/outbound-shipping-places`),
          tryPath(`/v2/providers/openapi/apis/api/v3/vendors/${env.COUPANG_VENDOR_ID}/outbound-shipping-places`),
          tryPath(`/v2/providers/seller_api/apis/api/v1/marketplace/seller/${env.COUPANG_VENDOR_ID}/outbound-shipping-place-list`),
          tryPath(`/v2/providers/openapi/apis/api/v3/vendors/${env.COUPANG_VENDOR_ID}/warehouse`),
          tryPath(`/v2/providers/seller_api/apis/api/v1/marketplace/meta/courier-company-codes`),
        ]);
        return json(results);
      }

      // GET /api/coupang/categories?keyword=xxx  — 유효한 카테고리 ID 탐색용
      if (path === '/api/coupang/categories' && request.method === 'GET') {
        const keyword = url.searchParams.get('keyword') || '';
        const debug = url.searchParams.get('debug') === '1';

        // debug=1 이면 반품센터 목록 + 카테고리 메타 raw 응답 반환
        if (debug) {
          const proxyCall = async (p: string) => {
            const res = await fetch(`https://proxy.mobin-inc.com/proxy/coupang`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-proxy-secret': 'mobin-proxy-2024-xK9mP3nQ' },
              body: JSON.stringify({ path: p, method: 'GET', accessKey: env.COUPANG_ACCESS_KEY, secretKey: env.COUPANG_SECRET_KEY }),
            });
            return { status: res.status, data: await res.json() as any };
          };
          const catCode = url.searchParams.get('catCode') || '59411';
          // 반품센터: 여러 경로 시도
          const rcPaths = [
            `/v2/providers/seller_api/apis/api/v1/marketplace/vendor/${env.COUPANG_VENDOR_ID}/return-ship-place-list`,
            `/v2/providers/seller_api/apis/api/v1/marketplace/meta/return-ship-place-list`,
            `/v2/providers/seller_api/apis/api/v1/marketplace/seller-return-centers`,
          ];
          const rcResults: any[] = [];
          for (const p of rcPaths) {
            const r = await proxyCall(p);
            rcResults.push({ path: p.split('/').pop(), status: r.status, code: r.data.code, msg: (r.data.message || '').slice(0, 80) });
          }
          // 카테고리 메타: noticeCategories 만 추출
          const meta = await proxyCall(`/v2/providers/seller_api/apis/api/v1/marketplace/meta/category-related-metas/display-category-codes/${catCode}`);
          const noticeCategories = meta.data.data?.noticeCategories;
          return json({
            returnCenterTests: rcResults,
            categoryMeta: {
              status: meta.status, code: meta.data.code,
              noticeCategories: JSON.stringify(noticeCategories).slice(0, 1000),
              keys: Object.keys(meta.data.data || {}),
            },
          });
        }

        const categories = await getCoupangDisplayCategories(env);
        const filtered = keyword
          ? categories.filter(c =>
              c.fullName.includes(keyword) || c.name.includes(keyword)
            )
          : categories.slice(0, 100);
        return json({ total: categories.length, results: filtered });
      }

      // GET /api/coupang/commission?code=80297  — 카테고리별 수수료율 조회
      if (path === '/api/coupang/commission' && request.method === 'GET') {
        const code = url.searchParams.get('code');
        if (!code) return json({ error: 'code 필수' }, 400);
        const cacheKey = `coupang:commission:${code}`;
        const cached = await env.CACHE.get(cacheKey);
        if (cached) return json(JSON.parse(cached));

        const proxyBody = {
          path: `/v2/providers/seller_api/apis/api/v1/marketplace/meta/category-related-metas/display-category-codes/${code}`,
          method: 'GET',
          accessKey: env.COUPANG_ACCESS_KEY,
          secretKey: env.COUPANG_SECRET_KEY,
        };
        const res = await fetch('https://proxy.mobin-inc.com/proxy/coupang', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-proxy-secret': 'mobin-proxy-2024-xK9mP3nQ' },
          body: JSON.stringify(proxyBody),
        });
        const meta = await res.json() as any;
        const d = meta?.data || {};
        // 수수료율 필드 탐색 (응답 구조에 따라 여러 경로 시도)
        const rate: number | null =
          d.commissionRate ??
          d.commissionRates?.[0]?.commissionRate ??
          d.vendorCommissionRate ??
          d.sellerCommissionRate ??
          null;
        const allKeys = Object.keys(d);
        const result = { commissionRate: rate, allKeys, raw: JSON.stringify(d).slice(0, 500) };
        if (rate !== null) await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 });
        return json(result);
      }

      // GET /api/coupang/product/:id
      if (path.match(/^\/api\/coupang\/product\/\d+$/) && request.method === 'GET') {
        const productId = parseInt(path.split('/').pop()!);
        const product = await getCoupangProduct(env, productId);
        if (!product) return json({ error: '상품을 찾을 수 없습니다' }, 404);
        return json(product);
      }

      // GET /api/coupang/raw/:id  — 등록된 상품 원시 JSON (필드명 확인용)
      if (path.match(/^\/api\/coupang\/raw\/\d+$/) && request.method === 'GET') {
        const productId = path.split('/').pop()!;
        const res = await fetch('https://proxy.mobin-inc.com/proxy/coupang', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-proxy-secret': 'mobin-proxy-2024-xK9mP3nQ' },
          body: JSON.stringify({
            path: `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${productId}`,
            method: 'GET',
            accessKey: env.COUPANG_ACCESS_KEY,
            secretKey: env.COUPANG_SECRET_KEY,
          }),
        });
        return json(await res.json());
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

      // ══════════════════════════════════════════
      // 쿠팡 / 네이버 가격 비교 (상품명으로 스크레이핑)
      // ══════════════════════════════════════════

      if (path === '/api/price-compare' && request.method === 'GET') {
        const name = url.searchParams.get('name');
        if (!name) return json({ error: 'name 파라미터가 필요합니다' }, 400);

        const cacheKey = `price:${name.slice(0, 60)}`;
        const cached = await env.CACHE.get(cacheKey);
        if (cached) {
          return new Response(cached, {
            headers: { 'Content-Type': 'application/json', ...corsHeaders, 'X-Cache': 'HIT' },
          });
        }

        const result = await comparePrices(name, env);
        const resultJson = JSON.stringify(result);
        // 30분 캐시 (가격은 자주 바뀌지 않음)
        await env.CACHE.put(cacheKey, resultJson, { expirationTtl: 1800 });

        return new Response(resultJson, {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      if (path === '/api/costco' && request.method === 'GET') {
        const page = parseInt(url.searchParams.get('page') || '0');
        const size = parseInt(url.searchParams.get('size') || '20');
        const nocache = url.searchParams.get('nocache') === '1';

        const cacheKey = `costco:deals:${new Date().toISOString().slice(0, 10)}:${page}`;

        if (!nocache) {
          const cached = await env.CACHE.get(cacheKey);
          if (cached) {
            return new Response(cached, {
              headers: { 'Content-Type': 'application/json', ...corsHeaders, 'X-Cache': 'HIT' },
            });
          }
        }

        // 오늘 트렌드 키워드 가져오기
        const trendRows = await env.DB.prepare(
          `SELECT keyword FROM trend_keywords ORDER BY trend_score DESC LIMIT 20`
        ).all();
        const keywords = (trendRows.results as any[]).map(r => r.keyword);

        const data = await getCostcoDealsByKeywords(keywords, page, size);
        const resultJson = JSON.stringify(data);
        await env.CACHE.put(cacheKey, resultJson, { expirationTtl: 600 });

        return new Response(resultJson, {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

            if (path === '/api/costco/search-all' && request.method === 'GET') {
        const nocache = url.searchParams.get('nocache') === '1';
        const cacheKey = `costco:all:${new Date().toISOString().slice(0, 10)}`;
        if (!nocache) {
          const cached = await env.CACHE.get(cacheKey);
          if (cached) {
            return new Response(cached, {
              headers: { 'Content-Type': 'application/json', ...corsHeaders, 'X-Cache': 'HIT' },
            });
          }
        }
        const trendRows = await env.DB.prepare(
          `SELECT keyword FROM trend_keywords ORDER BY trend_score DESC LIMIT 10`
        ).all();
        const keywords = (trendRows.results as any[]).map(r => r.keyword);
        if (!keywords.length) return json({ error: '트렌드 키워드가 없습니다. 먼저 트렌드 수집을 실행하세요.' }, 400);

        const { searchCostcoByTrendKeywords } = await import('./costco');
        const result = await searchCostcoByTrendKeywords(keywords, 10);
        const resultJson = JSON.stringify(result);
        await env.CACHE.put(cacheKey, resultJson, { expirationTtl: 3600 });
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
