/**
 * 쿠팡 파트너스 API + 네이버쇼핑 검색 링크 제공
 *
 * 쿠팡: 파트너스 오픈API 상품 검색 (COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY)
 * 네이버: search/shop.json 권한 없음 → 검색 URL + RapidAPI 폴백 방식
 */

import { Env } from './types';

export interface PriceResult {
  price: number | null;
  title: string;
  url: string;
  image?: string;
  found: boolean;
}

export interface PriceInfo {
  coupang: PriceResult | null;
  naver:   PriceResult | null;
  keyword: string;
}

/* ─────────────────────────────────────────
   핵심 키워드 추출
───────────────────────────────────────── */
export function extractKeyword(name: string): string {
  return name
    .replace(/\s*\d+(?:\.\d+)?(?:ml|mL|L|g|kg|m{1,2}|㎡|㎖|매|입|개|롤|정|장|팩|박스|호|미터)[^\s]*/gi, '')
    .replace(/\s*(x|×|\*)\s*\d+/gi, '')
    .replace(/\([^)]{1,30}\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .split(/\s+/).slice(0, 4).join(' ');
}

/* ─────────────────────────────────────────
   쿠팡 파트너스 HMAC-SHA256
   datetime: YYYYMMDDTHHmmssZ
   message:  datetime + method + path(쿼리 포함)
───────────────────────────────────────── */
async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function coupangDatetime(): string {
  // YYYYMMDDTHHmmssZ (UTC)
  return new Date().toISOString()
    .replace(/[-:]/g, '')   // 2026-05-15T17:00:15.000Z → 20260515T170015.000Z
    .replace(/\.\d{3}/, ''); // → 20260515T170015Z
}

async function searchCoupang(keyword: string, env: Env): Promise<PriceResult | null> {
  try {
    const q = encodeURIComponent(keyword);
    // 파트너스 상품 링크 검색 엔드포인트
    const apiPath = `/v2/providers/affiliate_open_api/apis/openapi/products/search?keyword=${q}&limit=5&sortBy=PRICE_ASC&subId=mobin`;
    const datetime = coupangDatetime();
    const message  = `${datetime}GET${apiPath}`;
    const sig      = await hmacHex(env.COUPANG_SECRET_KEY, message);
    const auth     = `CEA algorithm=HmacSHA256, access-key=${env.COUPANG_ACCESS_KEY}, signed-date=${datetime}, signature=${sig}`;

    const res = await fetch(`https://api-gateway.coupang.com${apiPath}`, {
      headers: { Authorization: auth, 'Content-Type': 'application/json;charset=UTF-8' },
    });

    if (!res.ok) {
      console.error('[coupang]', res.status, await res.text());
      return null;
    }

    const data: any = await res.json();
    // rCode === 'OK' / data.productData: []
    const items: any[] = data?.data?.productData ?? [];
    if (!items.length) {
      // 상품 없음: 검색 URL만 제공
      return {
        price: null, found: false,
        title: keyword,
        url: `https://www.coupang.com/np/search?q=${q}`,
      };
    }

    const first = items[0];
    return {
      price: Number(first.productPrice) || null,
      title: first.productName ?? keyword,
      url:   first.productUrl  ?? `https://www.coupang.com/np/search?q=${q}`,
      image: first.productImage,
      found: true,
    };
  } catch(e) {
    console.error('[coupang]', e);
    return null;
  }
}

/* ─────────────────────────────────────────
   네이버쇼핑 — search/shop.json (권한 필요)
   실패 시 검색 URL만 반환
───────────────────────────────────────── */
async function searchNaver(keyword: string, env: Env): Promise<PriceResult | null> {
  const q = encodeURIComponent(keyword);
  const searchUrl = `https://search.shopping.naver.com/search/all?query=${q}&sort=price_asc`;

  try {
    const res = await fetch(
      `https://openapi.naver.com/v1/search/shop.json?query=${q}&display=5&sort=asc`,
      {
        headers: {
          'X-Naver-Client-Id':     env.NAVER_CLIENT_ID,
          'X-Naver-Client-Secret': env.NAVER_CLIENT_SECRET,
        },
      }
    );

    if (!res.ok) {
      // 권한 없음 → 검색 링크만 반환
      return { price: null, found: false, title: keyword, url: searchUrl };
    }

    const data: any = await res.json();
    const items: any[] = data?.items ?? [];
    if (!items.length) return { price: null, found: false, title: keyword, url: searchUrl };

    // lprice = 최저가
    const sorted = items
      .map((it: any) => ({
        price: parseInt(it.lprice || '0'),
        title: (it.title ?? '').replace(/<[^>]+>/g, '').trim(),
        url:   it.link ?? searchUrl,
        image: it.image,
      }))
      .filter(i => i.price > 0)
      .sort((a, b) => a.price - b.price);

    if (!sorted.length) return { price: null, found: false, title: keyword, url: searchUrl };
    return { ...sorted[0], found: true };
  } catch(e) {
    console.error('[naver]', e);
    return { price: null, found: false, title: keyword, url: searchUrl };
  }
}

/* ─────────────────────────────────────────
   Public
───────────────────────────────────────── */
export async function comparePrices(productName: string, env: Env): Promise<PriceInfo> {
  const keyword = extractKeyword(productName);
  const [coupang, naver] = await Promise.all([
    searchCoupang(keyword, env),
    searchNaver(keyword, env),
  ]);
  return { coupang, naver, keyword };
}
