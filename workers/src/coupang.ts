import { Env } from './types';

export interface CoupangProduct {
  vendorId: string;
  vendorItemName: string;
  originalPrice: number;
  salePrice: number;
  stockQuantity: number;
  images: string[];
  description: string;
  categoryId: number;
  keyword: string;
  sourceUrl: string;
  shippingFee?: number;
}

export interface CoupangRegisteredProduct {
  productId: number;
  vendorItemId: number;
  sellerProductName: string;
  salePrice: number;
  status: string;
  productUrl: string;
}

// ─── 쿠팡 공식 HMAC-SHA256 서명 생성 ───
// 참고: https://developers.coupang.com/ko/auth
async function generateCoupangSignature(
  secretKey: string,
  method: string,
  path: string,
  datetime: string
): Promise<string> {
  // 쿠팡 서명 메시지 형식: datetime + method + path
  const message = `${datetime}${method}${path}`;

  const encoder = new TextEncoder();

  // Secret Key를 그대로 UTF-8로 인코딩 (hex decode 안 함)
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

  // hex 인코딩으로 반환
  return Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── 쿠팡 API 인증 헤더 ───
async function getCoupangHeaders(
  env: Env,
  method: string,
  path: string
): Promise<Record<string, string>> {
  const datetime = new Date().toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '')
    .replace('T', 'T');

  const signature = await generateCoupangSignature(
    env.COUPANG_SECRET_KEY,
    method,
    path,
    datetime
  );

  const authorization = `CEA algorithm=HmacSHA256, access-key=${env.COUPANG_ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`;

  return {
    'Content-Type': 'application/json;charset=UTF-8',
    'Authorization': authorization,
  };
}

const COUPANG_BASE = 'https://api-gateway.coupang.com';

// ─── 상품 등록 ───
export async function registerCoupangProduct(
  env: Env,
  product: CoupangProduct
): Promise<{ success: boolean; productId?: number; error?: string }> {
  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`;

  const shippingFee = product.shippingFee ?? 0;

  const payload = {
    displayCategoryCode: product.categoryId,
    sellerProductName: product.vendorItemName,
    vendorId: env.COUPANG_VENDOR_ID,
    saleStartedAt: new Date().toISOString().split('T')[0] + 'T00:00:00',
    saleEndedAt: '2099-12-31T00:00:00',
    vendorUserId: env.COUPANG_VENDOR_ID,
    productType: 1,
    returnCenterCode: '',
    outboundShippingTimeDay: 3,
    unionDeliveryType: 'UNION_DELIVERY',
    deliveryMethod: 'PARCEL',
    deliveryCompanyCode: 'CJGLS',
    deliveryChargeType: shippingFee === 0 ? 'FREE' : 'NOT_FREE',
    deliveryCharge: shippingFee,
    freeShipOverAmount: shippingFee === 0 ? 0 : 50000,
    returnCharge: 5000,
    returnChargeName: '반품 배송비',
    pccNeeded: false,
    items: [
      {
        itemName: product.vendorItemName,
        originalPrice: product.originalPrice,
        salePrice: product.salePrice,
        maximumBuyCount: 999,
        maximumBuyForPerson: 999,
        unitCount: 1,
        stockQuantity: product.stockQuantity || 999,
        outboundShippingTimeDay: 3,
        images: product.images.filter(Boolean).slice(0, 10).map((url, i) => ({
          imageType: i === 0 ? 'REPRESENTATION' : 'DETAIL',
          cdnPath: url,
          vendorPath: url,
        })),
        notices: [],
        attributes: [],
        contents: [{
          contentsType: 'TEXT',
          contentDetails: [{
            content: product.description,
            detailType: 'TEXT',
          }],
        }],
        searchTags: [product.keyword],
        certifications: [],
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

    const responseText = await response.text();
    console.log('쿠팡 API 응답 status:', response.status);
    console.log('쿠팡 API 응답 텍스트:', responseText.slice(0, 500));

    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch {
      return { success: false, error: `쿠팡 API 응답 오류 (${response.status}): ${responseText.slice(0, 200)}` };
    }

    if (response.ok && data.code === 'SUCCESS') {
      return { success: true, productId: data.data?.productId };
    } else {
      return {
        success: false,
        error: data.message || data.code || `HTTP ${response.status}`,
      };
    }
  } catch (e: any) {
    console.error('registerCoupangProduct error:', e);
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
    const response = await fetch(`${COUPANG_BASE}${path}`, { method: 'GET', headers });
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
  } catch { return null; }
}

// ─── 1688/알리 상품 → 쿠팡 상품 변환 ───
export function convertToCoupangProduct(
  env: Env,
  source: {
    title: string;
    keyword: string;
    suggested_sell_price: number;
    image_url: string;
    detail_url: string;
    shipping_fee?: number;
    margin_rate?: number;
  }
): CoupangProduct {
  const salePrice = source.suggested_sell_price;
  const originalPrice = Math.round(salePrice * 1.2);

  return {
    vendorId: env.COUPANG_VENDOR_ID,
    vendorItemName: source.title,
    originalPrice,
    salePrice,
    stockQuantity: 999,
    images: [source.image_url].filter(Boolean),
    description: `${source.title}\n\n✅ 빠른 배송\n✅ 품질 보장\n✅ 고객 만족 A/S\n\n원산지: 중국\n배송: 해외직구 (7-20일 소요)`,
    categoryId: guessCategoryId(source.keyword),
    keyword: source.keyword,
    sourceUrl: source.detail_url,
    shippingFee: source.shipping_fee ?? 0,
  };
}

// ─── 카테고리 ID 추정 ───
export function guessCategoryId(keyword: string): number {
  const kw = keyword.toLowerCase();
  const map: Record<string, number> = {
    '패션': 15760014, '옷': 15760014, '의류': 15760014,
    '화장품': 15760004, '스킨': 15760004, '마스크팩': 15760004, '세럼': 15760004,
    '운동': 15760029, '헬스': 15760029, '스포츠': 15760029, '요가': 15760029,
    '반려동물': 15760044, '강아지': 15760044, '고양이': 15760044,
    '주방': 15760001, '조리': 15760001,
    '식품': 15760027, '건강식품': 15760026, '비타민': 15760026,
    '육아': 15760010, '아기': 15760010, '유아': 15760010,
    '족욕': 15760001, '안마': 15760001, '마사지': 15760001,
    '청소': 15760001, '생활': 15760001,
  };
  for (const [key, id] of Object.entries(map)) {
    if (kw.includes(key)) return id;
  }
  return 15760001;
}
