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
  brandName?: string;
  optionName?: string;
  returnCenterCode?: string;
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

const PROXY_URL = 'https://proxy.mobin-inc.com';
const PROXY_SECRET = 'mobin-proxy-2024-xK9mP3nQ';

// ─── 프록시 서버를 통한 쿠팡 API 호출 ───
async function callCoupangViaProxy(
  env: Env,
  method: string,
  path: string,
  body?: any
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${PROXY_URL}/proxy/coupang`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-proxy-secret': PROXY_SECRET,
    },
    body: JSON.stringify({
      path,
      method,
      body,
      accessKey: env.COUPANG_ACCESS_KEY,
      secretKey: env.COUPANG_SECRET_KEY,
    }),
  });
  const data = await res.json();
  return { status: res.status, data };
}

// ─── 반품센터 코드 자동 조회 ───
export async function fetchReturnCenterCode(env: Env): Promise<string> {
  // 알려진 API 경로 순서대로 시도
  const paths = [
    `/v2/providers/seller_api/apis/api/v1/marketplace/vendor/${env.COUPANG_VENDOR_ID}/return-ship-place-list`,
    `/v2/providers/openapi/apis/api/v3/vendors/${env.COUPANG_VENDOR_ID}/returnShipmentInfos`,
    `/v2/providers/seller_api/apis/api/v1/marketplace/seller/${env.COUPANG_VENDOR_ID}/return-ship-places`,
  ];
  for (const p of paths) {
    try {
      const { status, data } = await callCoupangViaProxy(env, 'GET', p);
      if (status === 200 && data.code === 'SUCCESS') {
        const list = Array.isArray(data.data) ? data.data : (data.data?.content || []);
        const first = list[0];
        const code = first?.returnCenterCode || first?.shippingPlaceCode || first?.code || '';
        if (code) { console.log('반품센터 코드 조회 성공:', code, 'from', p); return String(code); }
      }
    } catch {}
  }
  return '';
}

// ─── 카테고리 메타정보 조회 ───
async function getCoupangCategoryMeta(env: Env, categoryId: number): Promise<{
  noticeCategories: Array<{
    noticeCategoryName: string;
    details: Array<{ noticeCategoryDetailName: string }>;
  }>;
}> {
  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/meta/category-related-metas/display-category-codes/${categoryId}`;
  try {
    const { status, data } = await callCoupangViaProxy(env, 'GET', path);
    if (status === 200 && data.code === 'SUCCESS') {
      const rawCats = data.data?.noticeCategories || [];
      console.log('noticeCategories raw:', JSON.stringify(rawCats).slice(0, 400));
      const cats = rawCats.map((c: any) => {
        // 가능한 세부 항목 필드명 전부 시도
        const rawDetails: any[] =
          c.noticeCategoryDetails || c.noticeDetails || c.details || c.noticeItems || [];
        return {
          noticeCategoryName: c.noticeCategoryName,
          details: rawDetails
            .map((d: any) => ({
              noticeCategoryDetailName:
                d.noticeCategoryDetailName || d.detailName || d.name || '',
            }))
            .filter((d: any) => d.noticeCategoryDetailName),
        };
      });
      return { noticeCategories: cats };
    }
    console.error('getCoupangCategoryMeta failed:', status, JSON.stringify(data).slice(0, 200));
  } catch (e) {
    console.error('getCoupangCategoryMeta error:', e);
  }
  return { noticeCategories: [] };
}

// ─── 상품 등록 ───
export async function registerCoupangProduct(
  env: Env,
  product: CoupangProduct
): Promise<{ success: boolean; productId?: number; error?: string; _debug?: any }> {
  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`;

  // 반품센터: env 우선, 없으면 API 자동 조회
  let returnCenterCode = product.returnCenterCode || env.COUPANG_RETURN_CENTER_CODE || '';
  if (!returnCenterCode) {
    returnCenterCode = await fetchReturnCenterCode(env);
  }

  // 카테고리 메타에서 고시 카테고리 조회
  const meta = await getCoupangCategoryMeta(env, product.categoryId);

  // 고시정보 구성
  let notices: any[] = [];
  for (const cat of meta.noticeCategories) {
    for (const detail of cat.details) {
      notices.push({
        noticeCategoryName: cat.noticeCategoryName,
        noticeCategoryDetailName: detail.noticeCategoryDetailName,
        content: '상세페이지 참조',
      });
    }
  }

  // 고시정보가 없으면 식품 기본 항목으로 폴백
  if (notices.length === 0) {
    notices = [
      { noticeCategoryName: '농수축산물', noticeCategoryDetailName: '품목 또는 명칭', content: '상세페이지 참조' },
      { noticeCategoryName: '농수축산물', noticeCategoryDetailName: '포장단위별 용량(중량), 수량, 크기', content: '상세페이지 참조' },
      { noticeCategoryName: '농수축산물', noticeCategoryDetailName: '생산자, 수입품의 경우 생산국', content: '상세페이지 참조' },
      { noticeCategoryName: '농수축산물', noticeCategoryDetailName: '농수산물의 원산지', content: '상세페이지 참조' },
      { noticeCategoryName: '농수축산물', noticeCategoryDetailName: '제조연월일(포장일 또는 생산연도), 유통기한 또는 품질유지기한', content: '상세페이지 참조' },
      { noticeCategoryName: '농수축산물', noticeCategoryDetailName: '보관방법 또는 취급방법', content: '상세페이지 참조' },
      { noticeCategoryName: '농수축산물', noticeCategoryDetailName: 'GM 여부(표시대상 농수산물에 한함)', content: '해당없음' },
      { noticeCategoryName: '농수축산물', noticeCategoryDetailName: '방사선 조사여부', content: '해당없음' },
      { noticeCategoryName: '농수축산물', noticeCategoryDetailName: '소비자상담관련 전화번호', content: '상세페이지 참조' },
    ];
    console.log('고시정보 API 미조회 → 식품 기본 폴백 사용');
  }

  console.log('등록 디버그:', JSON.stringify({
    categoryId: product.categoryId,
    returnCenterCode,
    noticeCount: notices.length,
    firstNotice: notices[0],
    rawCategoryMeta: JSON.stringify(meta).slice(0, 300),
  }));

  const payload = {
    displayCategoryCode: product.categoryId,
    sellerProductName: product.vendorItemName,
    vendorId: env.COUPANG_VENDOR_ID,
    saleStartedAt: new Date().toISOString().split('T')[0] + 'T00:00:00',
    saleEndedAt: '2099-12-31T00:00:00',
    vendorUserId: env.COUPANG_VENDOR_ID,
    productType: 1,
    returnCenterCode,
    outboundShippingTimeDay: 2,
    unionDeliveryType: 'UNION_DELIVERY',
    deliveryMethod: 'PARCEL',
    deliveryCompanyCode: 'CJGLS',
    deliveryChargeType: 'FREE',
    deliveryCharge: 0,
    freeShipOverAmount: 0,
    remoteAreaYn: 'N',
    returnCharge: 5000,
    returnChargeWithPackage: 5000,
    pccNeeded: false,
    brand: product.brandName || '',
    manufacture: product.brandName || '',
    items: [
      {
        itemName: product.optionName || product.vendorItemName,
        taxType: 'TAX',
        adultOnly: 'ADULT_NONE',
        overseasPurchaseAgencyYn: 'N',
        originalPrice: product.originalPrice,
        salePrice: product.salePrice,
        maximumBuyCount: 0,
        maximumBuyForPerson: 0,
        unitCount: 1,
        stockQuantity: product.stockQuantity || 99,
        outboundShippingTimeDay: 2,
        remoteAreaYn: 'N',
        images: product.images.filter(Boolean).slice(0, 10).map((url, i) => ({
          imageType: i === 0 ? 'REPRESENTATION' : 'DETAIL',
          cdnPath: url,
          vendorPath: url,
        })),
        notices,
        attributes: [],
        contents: [{
          contentsType: 'HTML',
          contentDetails: [{
            content: product.description,
            detailType: 'TEXT',
          }],
        }],
        searchTags: [product.keyword].filter(Boolean),
        certifications: [],
      }
    ],
    requiredDocuments: [],
  };

  try {
    const { status, data } = await callCoupangViaProxy(env, 'POST', path, payload);
    console.log('쿠팡 API 응답 status:', status, JSON.stringify(data).slice(0, 500));

    if (status === 200 && data.code === 'SUCCESS') {
      return { success: true, productId: data.data?.productId };
    } else {
      return {
        success: false,
        error: data.message || data.code || `HTTP ${status}`,
        _debug: {
          categoryId: product.categoryId,
          returnCenterCode,
          noticeCount: notices.length,
          firstNotice: notices[0],
          rawMeta: JSON.stringify(meta).slice(0, 500),
        },
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
    const { status, data } = await callCoupangViaProxy(env, 'GET', path);
    if (status !== 200 || data.code !== 'SUCCESS') return null;
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

// ─── 코스트코 상품 → 쿠팡 상품 변환 (카테고리 API 우선 조회) ───
export async function convertToCoupangProduct(
  env: Env,
  source: {
    title: string;
    keyword: string;
    suggested_sell_price: number;
    image_url: string;
    detail_url: string;
    all_images?: string[];
    costco_price?: number;
    shipping_fee?: number;
    return_center_code?: string;
  }
): Promise<CoupangProduct> {
  const salePrice = source.suggested_sell_price;
  const originalPrice = Math.round(salePrice * 1.15);

  const brandName = source.title.split(' ')[0] || source.title;

  const optionMatch = source.title.match(
    /([\d.]+(?:ml|mL|L|g|kg|매|입|개|롤|정|장|팩|호|m)(?:\s*x\s*[\d]+)*)/i
  );
  const optionName = optionMatch ? optionMatch[0] : '1개';

  const allImages = (source.all_images || [source.image_url]).filter(Boolean);
  const fullImages = allImages.map(url =>
    url.startsWith('http') ? url : `https://www.costco.co.kr${url}`
  );

  const detailImgHtml = fullImages.map(url =>
    `<img src="${url}" style="width:100%;max-width:800px;display:block;margin:0 auto" />`
  ).join('\n');

  const description = `
<div style="text-align:center;font-family:sans-serif">
  <h2 style="font-size:18px;margin:20px 0">${source.title}</h2>
  ${detailImgHtml}
  <div style="margin:20px;padding:16px;background:#f8f8f8;border-radius:8px;text-align:left;font-size:14px">
    <p>✅ 코스트코 정품 상품</p>
    <p>✅ 빠른 출고 (주문 후 2일 이내)</p>
    <p>✅ 안전한 포장</p>
  </div>
</div>`.trim();

  // 카테고리: Coupang API 조회 → 폴백 맵 순서로 결정
  const searchKw = source.keyword || source.title;
  let categoryId = guessCategoryId(searchKw);
  try {
    const categories = await getCoupangDisplayCategories(env);
    const found = findBestCategoryCode(categories, searchKw);
    if (found) categoryId = found;
  } catch (e) {
    console.warn('카테고리 API 조회 실패, 폴백 사용:', e);
  }

  return {
    vendorId: env.COUPANG_VENDOR_ID,
    vendorItemName: source.title,
    originalPrice,
    salePrice,
    stockQuantity: 99,
    images: fullImages,
    description,
    categoryId,
    keyword: source.keyword,
    sourceUrl: source.detail_url,
    shippingFee: 0,
    brandName,
    optionName,
    returnCenterCode: source.return_center_code || env.COUPANG_RETURN_CENTER_CODE || '',
  };
}

// ─── 쿠팡 유효 카테고리 목록 조회 ───
export async function getCoupangDisplayCategories(
  env: Env
): Promise<Array<{ code: number; name: string; fullName: string }>> {
  const CACHE_KEY = 'coupang:categories:v1';
  const cached = await env.CACHE.get(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/meta/display-categories`;
  try {
    const { status, data } = await callCoupangViaProxy(env, 'GET', path);
    if (status === 200 && data.code === 'SUCCESS') {
      const result: Array<{ code: number; name: string; fullName: string }> = [];
      function flatten(nodes: any[], parentName = '') {
        for (const n of nodes || []) {
          const code = Number(n.displayItemCategoryCode ?? n.displayCategoryCode);
          const name: string = n.name || n.displayCategoryName || '';
          const fullName = parentName ? `${parentName} > ${name}` : name;
          if (n.child?.length) {
            flatten(n.child, fullName);
          } else if (code) {
            result.push({ code, name, fullName });
          }
        }
      }
      flatten(Array.isArray(data.data) ? data.data : [data.data]);
      // 24시간 캐시 (카테고리는 자주 바뀌지 않음)
      await env.CACHE.put(CACHE_KEY, JSON.stringify(result), { expirationTtl: 86400 });
      return result;
    }
    console.error('getCoupangDisplayCategories failed:', JSON.stringify(data).slice(0, 300));
  } catch (e) {
    console.error('getCoupangDisplayCategories error:', e);
  }
  return [];
}

// API에서 가져온 카테고리 목록에서 키워드로 최적 매칭
function findBestCategoryCode(
  categories: Array<{ code: number; name: string; fullName: string }>,
  keyword: string
): number | null {
  if (!categories.length) return null;
  const kw = keyword.toLowerCase();
  // 1순위: fullName 완전 포함
  for (const c of categories) {
    if (c.fullName.toLowerCase().includes(kw)) return c.code;
  }
  // 2순위: name 포함
  for (const c of categories) {
    if (c.name.toLowerCase().includes(kw)) return c.code;
  }
  // 3순위: 키워드 토큰 하나라도 매칭
  const tokens = kw.split(/\s+/).filter(t => t.length >= 2);
  for (const token of tokens) {
    for (const c of categories) {
      if (c.fullName.toLowerCase().includes(token) || c.name.toLowerCase().includes(token)) {
        return c.code;
      }
    }
  }
  return null;
}

// ─── 카테고리 ID 추정 (API 조회 실패 시 폴백) ───
// 아래 코드는 /api/coupang/categories 엔드포인트로 실제 검증된 값
const CATEGORY_FALLBACK_MAP: Record<string, number> = {
  // 식품 (ROOT > 식품)
  '식품': 59411, '견과': 59411, '과자': 59411, '라면': 58647,
  '음료': 59411, '커피': 59411, '올리브유': 59411, '참기름': 59411,
  // 생활용품/뷰티
  '샴푸': 56240, '화장품': 56240, '스킨': 56240, '마스크팩': 56240,
  '바디': 56240, '세제': 64470, '세탁': 64470,
  // 가전 (ROOT > 가전/디지털)
  '청소기': 63450, '로봇청소기': 63450,
  // 패션 (ROOT > 패션의류잡화)
  '패션': 69182, '의류': 69182, '옷': 69182,
};

export function guessCategoryId(keyword: string): number {
  const kw = keyword.toLowerCase();
  for (const [key, id] of Object.entries(CATEGORY_FALLBACK_MAP)) {
    if (kw.includes(key.toLowerCase())) return id;
  }
  // 59411: 식품 > 견과류 (코스트코 상품 대다수가 식품류)
  return 59411;
}
