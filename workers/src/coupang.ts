// ─────────────────────────────────────────────────────────────
// 쿠팡 파트너스 API 연동 모듈
// 상품 자동 등록 / 조회 / 가격 수정
// ─────────────────────────────────────────────────────────────

import { Env } from './types';

export interface CoupangProduct {
  vendorId: string;
  vendorItemName: string;           // 상품명
  originalPrice: number;            // 정가
  salePrice: number;                // 판매가
  unitCount: number;                // 수량 (무재고: 999)
  stockQuantity: number;
  images: string[];                 // 상품 이미지 URL 배열
  description: string;              // 상품 상세 설명
  categoryId: number;               // 쿠팡 카테고리 ID
  keyword: string;                  // 검색 키워드
  sourceUrl: string;                // 1688/알리 원본 URL
}

export interface CoupangRegisteredProduct {
  productId: number;
  vendorItemId: number;
  sellerProductName: string;
  salePrice: number;
  status: string;
  productUrl: string;
}

// ─── HMAC-SHA256 서명 생성 ───
async function generateHmacSignature(
  secretKey: string,
  message: string
): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secretKey);
  const messageData = encoder.encode(message);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageData);
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── 쿠팡 API 인증 헤더 생성 ───
async function getCoupangHeaders(
  env: Env,
  method: string,
  path: string,
  query = ''
): Promise<Record<string, string>> {
  const datetime = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const message = `${datetime}${method}${path}${query}`;
  const signature = await generateHmacSignature(env.COUPANG_SECRET_KEY, message);

  return {
    'Content-Type': 'application/json;charset=UTF-8',
    'Authorization': `CEA algorithm=HmacSHA256, access-key=${env.COUPANG_ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`,
  };
}

const COUPANG_BASE = 'https://api-gateway.coupang.com';

// ─── 상품 등록 ───
export async function registerCoupangProduct(
  env: Env,
  product: CoupangProduct
): Promise<{ success: boolean; productId?: number; error?: string }> {
  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`;

  // 쿠팡 상품 등록 페이로드
  const payload = {
    vendorId: env.COUPANG_VENDOR_ID,
    sellerProductName: product.vendorItemName,
    vendorUserId: env.COUPANG_VENDOR_ID,
    saleStartedAt: new Date().toISOString().split('T')[0] + 'T00:00:00',
    saleEndedAt: '2099-12-31T00:00:00',
    displayCategoryCode: product.categoryId,
    productType: 1,
    items: [
      {
        itemName: product.vendorItemName,
        originalPrice: product.originalPrice,
        salePrice: product.salePrice,
        unitCount: product.unitCount || 1,
        stockQuantity: product.stockQuantity || 999,
        maximumBuyCount: 999,
        maximumBuyForPerson: 999,
        outboundShippingTimeDay: 3,
        images: product.images.slice(0, 10).map((url, i) => ({
          imageType: i === 0 ? 'REPRESENTATION' : 'DETAIL',
          cdnPath: url,
          vendorPath: url,
        })),
        notices: [],
        attributes: [],
        contents: [
          {
            contentsType: 'TEXT',
            contentDetails: [
              {
                content: product.description,
                detailType: 'TEXT',
              }
            ]
          }
        ],
        searchTags: [product.keyword],
      }
    ],
    requiredDocuments: [],
  };

  try {
    const headers = await getCoupangHeaders(env, 'POST', path);
    const response = await fetch(`${COUPANG_BASE}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const data = await response.json() as any;

    if (response.ok && data.code === 'SUCCESS') {
      return {
        success: true,
        productId: data.data?.productId,
      };
    } else {
      return {
        success: false,
        error: data.message || `쿠팡 API 오류: ${response.status}`,
      };
    }
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// ─── 상품 조회 ───
export async function getCoupangProduct(
  env: Env,
  productId: number
): Promise<CoupangRegisteredProduct | null> {
  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${productId}`;

  try {
    const headers = await getCoupangHeaders(env, 'GET', path);
    const response = await fetch(`${COUPANG_BASE}${path}`, {
      method: 'GET',
      headers,
    });

    const data = await response.json() as any;
    if (!response.ok || data.code !== 'SUCCESS') return null;

    const item = data.data?.items?.[0];
    return {
      productId: data.data.productId,
      vendorItemId: item?.vendorItemId,
      sellerProductName: data.data.sellerProductName,
      salePrice: item?.salePrice,
      status: data.data.statusName,
      productUrl: `https://www.coupang.com/vp/products/${productId}`,
    };
  } catch {
    return null;
  }
}

// ─── 가격 수정 ───
export async function updateCoupangPrice(
  env: Env,
  productId: number,
  vendorItemId: number,
  newPrice: number
): Promise<boolean> {
  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${productId}/items/${vendorItemId}/prices`;

  try {
    const headers = await getCoupangHeaders(env, 'PUT', path);
    const response = await fetch(`${COUPANG_BASE}${path}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ originalPrice: Math.round(newPrice * 1.1), salePrice: newPrice }),
    });

    const data = await response.json() as any;
    return data.code === 'SUCCESS';
  } catch {
    return false;
  }
}

// ─── 카테고리 ID 추정 (키워드 기반) ───
export function guessCategoryId(keyword: string): number {
  const keyword_lower = keyword.toLowerCase();

  const categoryMap: Record<string, number> = {
    '패션': 15760014,
    '옷': 15760014,
    '의류': 15760014,
    '화장품': 15760004,
    '스킨': 15760004,
    '마스크팩': 15760004,
    '운동': 15760029,
    '헬스': 15760029,
    '스포츠': 15760029,
    '반려동물': 15760044,
    '강아지': 15760044,
    '고양이': 15760044,
    '주방': 15760001,
    '식품': 15760027,
    '건강': 15760026,
    '생활': 15760001,
    '청소': 15760001,
    '육아': 15760010,
    '아기': 15760010,
  };

  for (const [key, id] of Object.entries(categoryMap)) {
    if (keyword_lower.includes(key)) return id;
  }

  return 15760001; // 기본: 생활용품
}

// ─── 1688 상품 → 쿠팡 상품 변환 ───
export function convertToCoupangProduct(
  env: Env,
  source: {
    title: string;
    keyword: string;
    suggested_sell_price: number;
    image_url: string;
    detail_url: string;
  }
): CoupangProduct {
  const salePrice = source.suggested_sell_price;
  const originalPrice = Math.round(salePrice * 1.2); // 정가는 판매가의 120%

  return {
    vendorId: env.COUPANG_VENDOR_ID,
    vendorItemName: source.title,
    originalPrice,
    salePrice,
    unitCount: 1,
    stockQuantity: 999, // 무재고 위탁판매
    images: [source.image_url],
    description: `${source.title}\n\n✅ 빠른 배송\n✅ 품질 보장\n✅ 고객 만족 A/S`,
    categoryId: guessCategoryId(source.keyword),
    keyword: source.keyword,
    sourceUrl: source.detail_url,
  };
}
