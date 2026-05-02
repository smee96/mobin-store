// ─────────────────────────────────────────────────────────────
// 알리익스프레스 상품 검색 모듈
// RapidAPI - AliExpress Datahub API 사용
// ─────────────────────────────────────────────────────────────

export interface Product1688 {
  id: string;
  title: string;
  price_min: number;
  price_min_krw: number;
  price_max: number;
  price_max_krw: number;
  image_url: string;
  detail_url: string;
  seller_name: string;
  monthly_orders: number;
  rating: number;
  keyword: string;
  estimated_margin: number;
  suggested_sell_price: number;
  source: '1688' | 'aliexpress';
}

const USD_TO_KRW = 1380;
const MARKUP_RATE = 3.0;
const SHIPPING_EST = 3000;

export async function search1688(
  keyword: string,
  page = 1,
  rapidApiKey?: string
): Promise<Product1688[]> {
  if (!rapidApiKey) {
    console.warn('RAPIDAPI_KEY 없음 → 목업 데이터');
    return getMockProducts(keyword);
  }

  try {
    const params = new URLSearchParams({
      q: keyword,
      page: String(page),
      sort: 'BEST_MATCH',
      locale: 'ko_KR',
      currency: 'USD',
    });

    const res = await fetch(
      `https://aliexpress-datahub.p.rapidapi.com/item_search_4?${params}`,
      {
        headers: {
          'x-rapidapi-host': 'aliexpress-datahub.p.rapidapi.com',
          'x-rapidapi-key': rapidApiKey,
        },
      }
    );

    if (!res.ok) {
      console.error('RapidAPI 오류:', res.status);
      return getMockProducts(keyword);
    }

    const data = await res.json() as any;
    const items =
      data?.result?.resultList ||
      data?.items ||
      data?.data?.items || [];

    if (!items.length) return getMockProducts(keyword);

    return items
      .slice(0, 20)
      .map((item: any) => parseAliItem(item, keyword))
      .filter(Boolean) as Product1688[];

  } catch (e) {
    console.error('search aliexpress error:', e);
    return getMockProducts(keyword);
  }
}

function parseAliItem(item: any, keyword: string): Product1688 | null {
  const itemInfo = item?.item || item;

  const priceRaw =
    itemInfo?.sku?.def?.promotionPrice ||
    itemInfo?.sku?.def?.price ||
    itemInfo?.prices?.salePrice?.minPrice ||
    itemInfo?.salePrice ||
    itemInfo?.price || '0';

  const priceUsd = parseFloat(String(priceRaw).replace(/[^\d.]/g, ''));
  if (!priceUsd || priceUsd <= 0) return null;

  const priceKrw = Math.round(priceUsd * USD_TO_KRW);
  const id = String(itemInfo?.itemId || itemInfo?.productId || itemInfo?.id || Math.random().toString(36).slice(2));

  let imageUrl: string =
    itemInfo?.image?.imgUrl ||
    itemInfo?.images?.[0] ||
    itemInfo?.mainImage ||
    itemInfo?.imageUrl || '';
  if (imageUrl.startsWith('//')) imageUrl = `https:${imageUrl}`;

  const title: string =
    itemInfo?.title?.displayTitle ||
    itemInfo?.title ||
    itemInfo?.subject ||
    keyword;

  const orders = parseInt(
    String(itemInfo?.tradeDesc || itemInfo?.sales || itemInfo?.tradeCount || '0').replace(/[^0-9]/g, '')
  );

  const rating = parseFloat(String(itemInfo?.averageStar || itemInfo?.evaluate || itemInfo?.rating || '4.5'));

  const sellerName: string =
    itemInfo?.store?.storeName ||
    itemInfo?.sellerInfo?.storeName ||
    itemInfo?.shopName || '판매자';

  return {
    id,
    title,
    price_min: priceUsd,
    price_min_krw: priceKrw,
    price_max: priceUsd * 1.2,
    price_max_krw: Math.round(priceUsd * 1.2 * USD_TO_KRW),
    image_url: imageUrl,
    detail_url: `https://www.aliexpress.com/item/${id}.html`,
    seller_name: sellerName,
    monthly_orders: orders,
    rating,
    keyword,
    estimated_margin: calcMargin(priceKrw),
    suggested_sell_price: calcSellPrice(priceKrw),
    source: 'aliexpress',
  };
}

function calcSellPrice(costKrw: number): number {
  return Math.round((costKrw * MARKUP_RATE + SHIPPING_EST) / 100) * 100;
}

function calcMargin(costKrw: number): number {
  const sell = calcSellPrice(costKrw);
  return Math.round(((sell - costKrw - SHIPPING_EST) / sell) * 100);
}

function getMockProducts(keyword: string): Product1688[] {
  const searchUrl = `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(keyword)}`;
  const mockItems = [
    { title: `${keyword} Premium`, price: 8.5,  orders: 1243, rating: 4.8 },
    { title: `${keyword} Basic`,   price: 3.9,  orders: 3821, rating: 4.6 },
    { title: `${keyword} Pro`,     price: 15.0, orders: 587,  rating: 4.9 },
    { title: `${keyword} Budget`,  price: 2.1,  orders: 9102, rating: 4.3 },
    { title: `${keyword} New`,     price: 11.0, orders: 241,  rating: 4.7 },
    { title: `${keyword} Bulk`,    price: 5.0,  orders: 2304, rating: 4.5 },
  ];

  return mockItems.map((m, i) => {
    const priceKrw = Math.round(m.price * USD_TO_KRW);
    return {
      id: `mock_${keyword}_${i}`,
      title: m.title,
      price_min: m.price,
      price_min_krw: priceKrw,
      price_max: m.price * 1.2,
      price_max_krw: Math.round(m.price * 1.2 * USD_TO_KRW),
      image_url: `https://placehold.co/300x300/f5f0e8/6c47e8?text=${encodeURIComponent(keyword)}`,
      detail_url: searchUrl,
      seller_name: `Store_${i + 1}`,
      monthly_orders: m.orders,
      rating: m.rating,
      keyword,
      estimated_margin: calcMargin(priceKrw),
      suggested_sell_price: calcSellPrice(priceKrw),
      source: 'aliexpress' as const,
    };
  });
}
