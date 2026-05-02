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
      region: 'KR',
      shipToCountry: 'KR',
      language: 'ko',
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
    const items = data?.result?.resultList || data?.items || data?.data?.items || [];

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

function toHttps(url: string): string {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http://')) return url.replace('http://', 'https://');
  return url;
}

function parseAliItem(item: any, keyword: string): Product1688 | null {
  // API 응답 구조: { item: { itemId, title, image, sku, sales, averageStarRate }, ... }
  const info = item?.item || item;

  // 가격: sku.def.promotionPrice 우선, 없으면 price
  const promoPrice = parseFloat(String(info?.sku?.def?.promotionPrice || '0'));
  const basePrice = parseFloat(String(info?.sku?.def?.price || '0'));
  const priceUsd = promoPrice > 0 ? promoPrice : basePrice;
  if (!priceUsd || priceUsd <= 0) return null;

  const priceKrw = Math.round(priceUsd * USD_TO_KRW);
  const id = String(info?.itemId || info?.productId || Math.random().toString(36).slice(2));

  // 이미지: item.image 는 문자열 (//ae-pic... 형태)
  const imageUrl = toHttps(info?.image || '');

  const title: string = info?.title || keyword;

  // 상품 URL: item.itemUrl 또는 itemId로 구성
  const itemUrl = info?.itemUrl
    ? toHttps(info.itemUrl)
    : `https://www.aliexpress.com/item/${id}.html`;

  const orders = parseInt(String(info?.sales || info?.tradeCount || '0').replace(/[^0-9]/g, ''));
  const rating = parseFloat(String(info?.averageStarRate || info?.averageStar || '4.5')) || 4.5;

  const sellerName: string =
    info?.store?.storeName ||
    info?.sellerInfo?.storeName ||
    info?.shopName || '판매자';

  return {
    id,
    title,
    price_min: priceUsd,
    price_min_krw: priceKrw,
    price_max: priceUsd * 1.2,
    price_max_krw: Math.round(priceUsd * 1.2 * USD_TO_KRW),
    image_url: imageUrl,
    detail_url: itemUrl,
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
