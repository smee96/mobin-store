export interface CostcoProduct {
  id: string;
  name: string;
  price: string;
  priceNum: number;
  originalPrice: string;
  originalPriceNum: number;
  discount: string;
  discountAmount: string;
  period: string;
  url: string;
  imageUrl: string;
  unit: string;
  maxPurchase: string;
  maxPurchaseNum: number;
  freeShipping: boolean | null;
  shippingFeeText: string;
  isSoldOut: boolean;
  isMemberOnly: boolean;
  matchedKeyword?: string;
  rating?: number;
  reviewCount?: number;
  allImages?: string[];
  promoStartDate?: string;
  promoEndDate?: string;
}

const PROXY_URL = 'https://proxy.mobin-inc.com';
const PROXY_SECRET = 'mobin-proxy-2024-xK9mP3nQ';

// ── 특가 상품 전체 조회 (트렌드 키워드 필터링 포함) ──
export async function getCostcoDealsByKeywords(
  keywords: string[],
  page: number = 0,
  pageSize: number = 20
): Promise<{
  products: CostcoProduct[];
  total: number;
  hasMore: boolean;
  keywords: string[];
  mode: string;
}> {
  const url = `${PROXY_URL}/proxy/costco?category=SpecialPriceOffers&pageSize=100&page=0`;

  const res = await fetch(url, {
    headers: { 'x-proxy-secret': PROXY_SECRET },
  });

  if (!res.ok) throw new Error(`프록시 오류: ${res.status}`);
  const data = await res.json() as any;

  let products: CostcoProduct[] = (data.products || []).map((p: any) => parseCostcoProduct(p));

  // 트렌드 키워드 필터링
  if (keywords.length > 0) {
    const filtered = products.filter(p =>
      keywords.some(kw =>
        p.name.toLowerCase().includes(kw.toLowerCase()) ||
        kw.toLowerCase().split(' ').some((w: string) => w.length > 1 && p.name.includes(w))
      )
    );
    // 매칭 결과가 너무 적으면 전체 반환
    if (filtered.length >= 3) {
      products = filtered.map(p => ({
        ...p,
        matchedKeyword: keywords.find(kw => p.name.toLowerCase().includes(kw.toLowerCase()))
      }));
    }
  }

  const total = products.length;
  const start = page * pageSize;
  const sliced = products.slice(start, start + pageSize);

  return {
    products: sliced,
    total,
    hasMore: start + pageSize < total,
    keywords,
    mode: 'special_price',
  };
}

// ── 키워드로 코스트코 검색 ──
export async function searchCostcoByKeyword(
  keyword: string,
  page: number = 0,
  pageSize: number = 20
): Promise<{
  products: CostcoProduct[];
  total: number;
  hasMore: boolean;
  keyword: string;
}> {
  const url = `${PROXY_URL}/proxy/costco?keyword=${encodeURIComponent(keyword)}&page=${page}&pageSize=${pageSize}`;

  const res = await fetch(url, {
    headers: { 'x-proxy-secret': PROXY_SECRET },
  });

  if (!res.ok) throw new Error(`프록시 오류: ${res.status}`);
  const data = await res.json() as any;

  const products = (data.products || []).map((p: any) => parseCostcoProduct(p, keyword));
  const total = data.pagination?.totalResults ?? products.length;

  return {
    products,
    total,
    hasMore: (page + 1) * pageSize < total,
    keyword,
  };
}

// ── 코스트코 API 응답 → CostcoProduct 변환 ──
function parseCostcoProduct(p: any, keyword?: string): CostcoProduct {
  const code = p.code || p.id || String(Math.random());
  const name = p.name || '';

  // 이미지
  const images = p.images || [];
  const thumb = images.find((i: any) => i.imageType === 'PRIMARY') || images[0];
  const imageUrl = thumb?.url
    ? (thumb.url.startsWith('http') ? thumb.url : `https://www.costco.co.kr${thumb.url}`)
    : '';

  // 가격 (이미 할인 적용된 최종가)
  const priceNum = p.price?.value ?? 0;
  const price = p.price?.formattedValue ?? '';

  // 할인 금액 (promotions에서 추출)
  const promos = p.promotions || [];
  const discountNum = promos[0]?.discount?.value ?? 0;
  const discountAmount = discountNum > 0 ? discountNum.toLocaleString('ko-KR') + '원' : '';
  const originalPriceNum = discountNum > 0 ? priceNum + discountNum : 0;
  const originalPrice = originalPriceNum > 0
    ? originalPriceNum.toLocaleString('ko-KR') + '원' : '';
  const discount = discountNum > 0 && originalPriceNum > 0
    ? Math.round((discountNum / originalPriceNum) * 100) + '%' : '';

  // 행사기간 (promotions 또는 couponDiscount 어디서든 추출)
  const cd = p.couponDiscount;
  const promoStartDate: string | undefined =
    promos[0]?.startDate || cd?.discountStartDate || cd?.localDiscountStartDate || undefined;
  const promoEndDate: string | undefined =
    promos[0]?.endDate || cd?.discountEndDate || cd?.localDiscountEndDate || undefined;
  const period = promoEndDate ? `~ ${promoEndDate.slice(0, 10)}` : '';

  const isSoldOut = p.stock?.stockLevelStatus === 'outOfStock' || false;
  const isMemberOnly = p.memberOnly ?? false;
  const rating = p.averageRating ?? 0;
  const reviewCount = p.numberOfReviews ?? 0;

  // 최대구매수량
  const maxPurchaseNum: number =
    p.purchaseQuantityLimit ?? p.maxOrderQuantity ?? p.maxQuantity ?? p.unitQuantity ?? 0;
  const maxPurchase = maxPurchaseNum > 0 ? `${maxPurchaseNum}개` : '';

  // 배송비
  const deliveryInfo = p.deliveryInfo || p.deliveryInformation || {};
  const freeShipping: boolean | null =
    p.freeShipping != null ? Boolean(p.freeShipping) :
    deliveryInfo.freeDelivery != null ? Boolean(deliveryInfo.freeDelivery) :
    (p.deliveryFee?.value === 0 || deliveryInfo.deliveryFee?.value === 0) ? true : null;
  const shippingFeeText =
    freeShipping === true ? '무료배송' :
    freeShipping === false ? (deliveryInfo.deliveryFee?.formattedValue || '유료배송') :
    '';

  // 전체 이미지 목록 (product → results → thumbnail 순)
  const sortOrder = ['product', 'results', 'thumbnail'];
  const allImages = [...images]
    .sort((a: any, b: any) => {
      const ai = sortOrder.indexOf(a.format || '');
      const bi = sortOrder.indexOf(b.format || '');
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    })
    .map((i: any) => i.url?.startsWith('http') ? i.url : `https://www.costco.co.kr${i.url}`)
    .filter(Boolean);

  return {
    id: code,
    name,
    price,
    priceNum,
    originalPrice,
    originalPriceNum,
    discount,
    discountAmount,
    period,
    url: `https://www.costco.co.kr/p/${code}`,
    imageUrl,
    unit: '',
    maxPurchase,
    maxPurchaseNum,
    freeShipping,
    shippingFeeText,
    isSoldOut,
    isMemberOnly,
    matchedKeyword: keyword,
    rating,
    reviewCount,
    allImages,
    promoStartDate,
    promoEndDate,
  };
}

// ── 여러 트렌드 키워드로 검색 후 중복 제거 집계 ──
export async function searchCostcoByTrendKeywords(
  keywords: string[],
  maxPerKeyword: number = 10
): Promise<{ products: CostcoProduct[]; total: number; keywords: string[] }> {
  const seen = new Set<string>();
  const products: CostcoProduct[] = [];

  for (const kw of keywords) {
    try {
      const result = await searchCostcoByKeyword(kw, 0, maxPerKeyword);
      for (const p of result.products) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          products.push(p);
        }
      }
    } catch {
      // 키워드별 실패는 무시하고 계속
    }
  }

  return { products, total: products.length, keywords };
}
