import { Env } from './types';
import { handleScheduled } from './scheduler';
import { search1688 } from './search1688';
import { registerCoupangProduct, getCoupangProduct, convertToCoupangProduct, getCoupangDisplayCategories, findBestCategoryCode } from './coupang';
import { getCostcoDealsByKeywords, searchCostcoByKeyword } from './costco';
import { comparePrices } from './priceCompare';
import {
  registerToNonopriceAll,
  batchRegisterToNonoprice,
  getNonoPriceResellerInfo,
  isNonoPriceConfigured,
} from './nonoprice';

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

      // GET /api/coupang/categories?keyword=...
      if (path === '/api/coupang/categories' && request.method === 'GET') {
        const keyword = url.searchParams.get('keyword') || '';
        try {
          const categories = await getCoupangDisplayCategories(env);
          if (!keyword) {
            return json({ results: categories.slice(0, 100) });
          }
          // 키워드 필터링 (findBestCategoryCode 로직과 동일하게 점수순 정렬)
          const kw = keyword.toLowerCase();
          const scored = categories
            .map(c => {
              const fn = c.fullName.toLowerCase();
              const n = c.name.toLowerCase();
              let score = 0;
              if (fn === kw || n === kw) score = 100;
              else if (fn.includes(kw) || n.includes(kw)) score = 80;
              else {
                const tokens = kw.split(/\s+/).filter(t => t.length >= 2);
                for (const t of tokens) {
                  if (fn.includes(t) || n.includes(t)) { score = Math.max(score, 50); }
                }
              }
              return { ...c, score };
            })
            .filter(c => c.score > 0)
            .sort((a, b) => b.score - a.score);
          // 결과 없으면 guessCategoryId fallback 포함해서 안내
          const bestCode = scored.length ? null : findBestCategoryCode(categories, keyword);
          return json({
            results: scored.length ? scored : (bestCode ? categories.filter(c => c.code === bestCode) : []),
            total: categories.length,
          });
        } catch (e: any) {
          return json({ error: e.message ?? '카테고리 조회 오류' }, 500);
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

      // GET /api/costco/search?keyword=...&page=0 — 키워드 검색
      if (path === '/api/costco/search' && request.method === 'GET') {
        const keyword = url.searchParams.get('keyword') || '';
        const page = parseInt(url.searchParams.get('page') || '0');
        if (!keyword) return json({ error: 'keyword 파라미터가 필요합니다' }, 400);
        try {
          const data = await searchCostcoByKeyword(keyword, page, 20);
          return json(data);
        } catch (e: any) {
          return json({ error: e.message ?? '코스트코 검색 오류' }, 500);
        }
      }

      // ══════════════════════════════════════════
      // 노노프라이스(nonoprice.co.kr) 연동
      // ══════════════════════════════════════════

      // GET /api/nonoprice/status — 연동 설정 상태 + 판매자 정보 확인
      if (path === '/api/nonoprice/status' && request.method === 'GET') {
        const configured = isNonoPriceConfigured(env);
        if (!configured) {
          return json({
            configured: false,
            message: 'NONOPRICE_INTERNAL_SECRET, NONOPRICE_RESELLER_ID, NONOPRICE_API_URL 환경변수를 설정하세요.',
          });
        }
        const info = await getNonoPriceResellerInfo(env);
        return json({
          configured: true,
          resellerId: env.NONOPRICE_RESELLER_ID,
          apiUrl: env.NONOPRICE_API_URL,
          reseller: info.reseller ?? null,
          resellerError: info.error ?? null,
        });
      }

      // POST /api/nonoprice/register — 코스트코 상품 단건 등록 (AI 설명 생성 포함)
      if (path === '/api/nonoprice/register' && request.method === 'POST') {
        const item = await request.json() as any;
        // name 은 필수
        if (!item.name) {
          return json({ error: 'name 필드가 필요합니다' }, 400);
        }
        // id 없으면 name 기반으로 자동 생성 (Math.random fallback 대응)
        if (!item.id || item.id.startsWith('0.')) {
          item.id = 'costco-' + Buffer.from(item.name).toString('base64').slice(0, 16);
        }
        // priceNum 없으면 price 문자열에서 파싱 시도
        if (!item.priceNum || item.priceNum <= 0) {
          const parsed = parseInt((item.price || '').replace(/[^0-9]/g, ''));
          if (parsed > 0) {
            item.priceNum = parsed;
          } else {
            return json({ error: '가격 정보가 없는 상품은 등록할 수 없습니다' }, 400);
          }
        }
        // skipAI 파라미터 지원 (일괄 등록 시 속도 우선)
        const skipAI = item._skipAI === true;
        // marginRate 파라미터 수신 (기본값 15)
        const marginRate = typeof item._marginRate === 'number' ? item._marginRate : 15;
        // 두 계정(이규한 #1 + 이재성 #2) 병렬 등록
        const allResult = await registerToNonopriceAll(env, item, { skipAI, marginRate });
        const result = allResult.result1;  // 기본 계정(이규한) 결과로 성공/실패 판단
        if (result.success) {
          return json({
            success: true,
            id: result.id,
            name: result.name,
            price: result.price,
            duplicate: result.duplicate,
            nonopriceUrl: result.nonopriceUrl,
            message: allResult.message ?? result.message,
            aiDescription: !skipAI,
            // 계정 #2 결과 (참고용)
            ...(allResult.result2 ? { result2: { success: allResult.result2.success, id: allResult.result2.id, duplicate: allResult.result2.duplicate, error: allResult.result2.error } } : {}),
          }, result.duplicate ? 200 : 201);
        } else {
          return json({ success: false, error: result.error, _debug: (result as any)._debug }, 400);
        }
      }

      // POST /api/nonoprice/batch — 코스트코 특가 전체 일괄 등록
      if (path === '/api/nonoprice/batch' && request.method === 'POST') {
        const body = await request.json() as any;
        const products = Array.isArray(body) ? body : body.products;
        if (!Array.isArray(products) || products.length === 0) {
          return json({ error: 'products 배열이 필요합니다' }, 400);
        }
        const result = await batchRegisterToNonoprice(env, products);
        return json(result, result.success && result.created > 0 ? 201 : (result.success ? 200 : 400));
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
