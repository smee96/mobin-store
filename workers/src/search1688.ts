// ─────────────────────────────────────────────────────────────
// 1688 상품 검색 모듈
// 나중에 AliExpress Affiliate API로 교체 가능한 구조로 설계
// ─────────────────────────────────────────────────────────────

export interface Product1688 {
  id: string;
  title: string;
  price_min: number;            // 최소 가격 (위안)
  price_min_krw: number;        // 최소 가격 (원)
  price_max: number;
  price_max_krw: number;
  image_url: string;
  detail_url: string;
  seller_name: string;
  monthly_orders: number;
  rating: number;
  keyword: string;
  estimated_margin: number;     // 예상 마진율 (%)
  suggested_sell_price: number; // 스마트스토어 권장 판매가 (원)
  source: '1688' | 'aliexpress'; // 나중에 알리 추가 대비
}

// 환율 / 마진 상수
const CNY_TO_KRW = 190;   // 1위안 ≈ 190원 (추후 환율 API 연동 가능)
const MARKUP_RATE = 3.0;  // 원가의 3배로 판매
const SHIPPING_EST = 3000; // 예상 배송비

// ─── 메인 검색 함수 ───
export async function search1688(
  keyword: string,
  page = 1
): Promise<Product1688[]> {
  try {
    // 1688 모바일 검색 API (파싱이 비교적 안정적)
    const url = `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(keyword)}&beginPage=${page}`;

    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://www.1688.com/',
      },
    });

    if (!res.ok) {
      console.warn('1688 fetch failed:', res.status, '→ using mock data');
      return getMockProducts(keyword);
    }

    const html = await res.text();
    const products = parse1688Response(html, keyword);
    return products.length > 0 ? products : getMockProducts(keyword);

  } catch (e) {
    console.error('search1688 error:', e);
    return getMockProducts(keyword);
  }
}

// ─── HTML / JSON 파싱 ───
function parse1688Response(html: string, keyword: string): Product1688[] {
  const products: Product1688[] = [];

  // 1688은 __INIT_DATA__ 또는 window.DATA 형식으로 상품 JSON 제공
  const patterns = [
    /window\.__INIT_DATA__\s*=\s*({[\s\S]+?});\s*<\/script>/,
    /window\.DATA\s*=\s*({[\s\S]+?});\s*<\/script>/,
    /"offerList"\s*:\s*(\[[\s\S]+?\])\s*,\s*"[a-z]/,
  ];

  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (!m) continue;
    try {
      const raw = m[1].startsWith('[') ? `{"list":${m[1]}}` : m[1];
      const data = JSON.parse(raw);
      const list: any[] =
        data?.data?.result?.offerList ||
        data?.result?.offerList ||
        data?.list || [];

      for (const item of list.slice(0, 24)) {
        const p = itemToProduct(item, keyword);
        if (p) products.push(p);
      }
      if (products.length > 0) break;
    } catch { /* 다음 패턴 시도 */ }
  }

  return products;
}

function itemToProduct(item: any, keyword: string): Product1688 | null {
  const priceRaw =
    item?.tradePrice ||
    item?.priceInfo?.price ||
    item?.price ||
    item?.minPrice || '0';

  const priceMin = parseFloat(String(priceRaw).replace(/[^\d.]/g, ''));
  if (!priceMin || priceMin <= 0) return null;

  const priceMax = parseFloat(item?.maxPrice || String(priceMin * 1.3));
  const priceMinKrw = Math.round(priceMin * CNY_TO_KRW);
  const priceMaxKrw = Math.round(priceMax * CNY_TO_KRW);
  const id = String(item?.offerId || item?.id || Math.random().toString(36).slice(2));

  // 이미지 URL 정규화
  let imageUrl: string = item?.imgUrl || item?.image || '';
  if (imageUrl.startsWith('//')) imageUrl = `https:${imageUrl}`;
  if (!imageUrl) imageUrl = `https://placehold.co/300x300?text=${encodeURIComponent(keyword)}`;

  const title: string = item?.subject || item?.title || keyword;
  const sellerName: string = item?.sellerInfo?.sellerLoginId || item?.companyName || '판매자';
  const monthlyOrders = parseInt(item?.tradeCount || item?.soldCount || '0');
  const rating = parseFloat(item?.sellerInfo?.serviceScore || '4.5');

  return {
    id,
    title,
    price_min: priceMin,
    price_min_krw: priceMinKrw,
    price_max: priceMax,
    price_max_krw: priceMaxKrw,
    image_url: imageUrl,
    detail_url: `https://detail.1688.com/offer/${id}.html`,
    seller_name: sellerName,
    monthly_orders: monthlyOrders,
    rating,
    keyword,
    estimated_margin: calcMargin(priceMinKrw),
    suggested_sell_price: calcSellPrice(priceMinKrw),
    source: '1688',
  };
}

// ─── 가격 계산 헬퍼 ───
function calcSellPrice(costKrw: number): number {
  // 원가 × 3배 + 배송비, 100원 단위 반올림
  return Math.round((costKrw * MARKUP_RATE + SHIPPING_EST) / 100) * 100;
}

function calcMargin(costKrw: number): number {
  const sell = calcSellPrice(costKrw);
  return Math.round(((sell - costKrw - SHIPPING_EST) / sell) * 100);
}

// ─── 목업 데이터 (스크래핑 실패 시 / 개발 테스트용) ───
function getMockProducts(keyword: string): Product1688[] {
  const mockItems = [
    { title: `${keyword} 프리미엄 세트`, price: 12.5, orders: 1243, rating: 4.8 },
    { title: `${keyword} 베이직 A형`, price: 6.8,  orders: 3821, rating: 4.6 },
    { title: `${keyword} 고급형 패키지`, price: 25.0, orders: 587,  rating: 4.9 },
    { title: `${keyword} 가성비 모델`,   price: 3.5,  orders: 9102, rating: 4.3 },
    { title: `${keyword} 신상 2024`,    price: 18.0, orders: 241,  rating: 4.7 },
    { title: `${keyword} OEM 대량구매`, price: 8.0,  orders: 2304, rating: 4.5 },
  ];

  return mockItems.map((m, i) => {
    const priceMinKrw = Math.round(m.price * CNY_TO_KRW);
    return {
      id: `mock_${keyword}_${i}`,
      title: m.title,
      price_min: m.price,
      price_min_krw: priceMinKrw,
      price_max: m.price * 1.3,
      price_max_krw: Math.round(m.price * 1.3 * CNY_TO_KRW),
      image_url: `https://placehold.co/300x300/f0f0f0/333?text=${encodeURIComponent(m.title.slice(0, 8))}`,
      detail_url: `https://detail.1688.com/offer/mock_${i}.html`,
      seller_name: `판매자_${i + 1}`,
      monthly_orders: m.orders,
      rating: m.rating,
      keyword,
      estimated_margin: calcMargin(priceMinKrw),
      suggested_sell_price: calcSellPrice(priceMinKrw),
      source: '1688' as const,
    };
  });
}
