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
  // 사용자가 모달에서 직접 지정하는 필드
  noticeCategory?: string;   // 고시정보 카테고리 (가공식품, 농수축산물 등)
  adultOnlyYn?: string;      // 성인여부 (N/Y)
  overseasYn?: string;       // 해외구매대행여부 (N/Y)
  buyCountPeriod?: string;   // 최대구매수량 기간 (DAY/MONTH/ONCE)
  buyCount?: number;         // 최대구매수량
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

interface ReturnShippingPlace {
  code: string;
  zipCode: string;
  address: string;
  addressDetail: string;
  contactName: string;
  phoneNumber: string;
}

// ─── 반품지 전체 정보 조회 (코드 + 주소 상세) ───
async function fetchReturnShippingPlaceInfo(env: Env): Promise<ReturnShippingPlace> {
  const empty: ReturnShippingPlace = { code: '', zipCode: '', address: '', addressDetail: '', contactName: '', phoneNumber: '' };
  const paths = [
    `/v2/providers/seller_api/apis/api/v1/marketplace/vendor/${env.COUPANG_VENDOR_ID}/return-ship-place-list`,
    `/v2/providers/seller_api/apis/api/v1/marketplace/meta/return-ship-place-list`,
    `/v2/providers/seller_api/apis/api/v1/marketplace/seller-return-centers`,
    `/v2/providers/openapi/apis/api/v3/vendors/${env.COUPANG_VENDOR_ID}/returnShipmentInfos`,
    `/v2/providers/seller_api/apis/api/v1/marketplace/seller/${env.COUPANG_VENDOR_ID}/return-ship-places`,
  ];
  for (const p of paths) {
    try {
      const { status, data } = await callCoupangViaProxy(env, 'GET', p);
      console.log('반품센터 API:', p.split('/').pop(), 'status:', status, 'code:', data?.code, 'keys:', Object.keys(data || {}).join(','));
      if (status === 200) {
        let list: any[] = [];
        if (data.code === 'SUCCESS') {
          list = Array.isArray(data.data) ? data.data : (data.data?.content || []);
        } else if (Array.isArray(data.content)) {
          list = data.content;
        } else if (Array.isArray(data)) {
          list = data;
        }
        const first = list[0];
        if (first) {
          console.log('반품센터 전체 데이터:', JSON.stringify(first));
          const code = first?.returnShippingPlaceId || first?.centerCode || first?.returnCenterCode || first?.shippingPlaceCode || first?.code || '';
          if (code) {
            console.log('반품센터 코드 조회 성공:', code, 'from', p.split('/').pop());
            return {
              code: String(code),
              zipCode: String(first?.zipCode || first?.returnZipCode || first?.postalCode || first?.postCode || ''),
              address: String(first?.addr || first?.address || first?.returnAddress || first?.streetAddress || ''),
              addressDetail: String(first?.addrDetail || first?.addressDetail || first?.detailAddress || first?.addr2 || ''),
              contactName: String(first?.contactName || first?.chargePersonName || first?.managerName || first?.name || ''),
              phoneNumber: String(first?.phone || first?.phoneNumber || first?.contactPhone || first?.mobile || ''),
            };
          }
        }
      }
    } catch (e) { console.error('반품센터 API 오류:', p.split('/').pop(), e); }
  }

  // 기존 등록 상품에서 코드만 추출 (주소는 알 수 없음)
  try {
    const { status, data } = await callCoupangViaProxy(
      env, 'GET',
      `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products?vendorId=${env.COUPANG_VENDOR_ID}&status=AVAILABLE&limit=1`
    );
    if (status === 200 && data.code === 'SUCCESS') {
      const product = Array.isArray(data.data) ? data.data[0] : data.data?.content?.[0];
      const code = product?.returnCenterCode || '';
      if (code) { console.log('기존 상품에서 반품센터 코드 추출:', code); return { ...empty, code: String(code) }; }
    }
  } catch {}

  return empty;
}

export async function fetchReturnCenterCode(env: Env): Promise<string> {
  return (await fetchReturnShippingPlaceInfo(env)).code;
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

// 고시정보 카테고리별 첫번째 세부항목명 매핑
const NOTICE_DETAIL_MAP: Record<string, string> = {
  '농수축산물': '품목 또는 명칭',
  '가공식품': '제품명',
  '건강기능식품': '제품명',
  '생활화학제품': '품명',
  '공산품': '품명 및 모델명',
  '기타 재화': '품명 및 모델명',
  '의류': '제품 소재',
  '섬유·의류': '제품 소재',
  '신발': '소재',
  '가방': '소재',
  '쥬얼리': '소재',
};

function getNoticeDetailName(
  catName: string,
  details: Array<{ noticeCategoryDetailName: string }>
): string {
  if (details.length > 0) return details[0].noticeCategoryDetailName;
  return NOTICE_DETAIL_MAP[catName] ?? '품명 및 모델명';
}

// ─── 상품 등록 ───
export async function registerCoupangProduct(
  env: Env,
  product: CoupangProduct
): Promise<{ success: boolean; productId?: number; error?: string; _debug?: any }> {
  const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`;

  // 반품지 전체 정보 조회 (코드 + 주소)
  const returnPlace = await fetchReturnShippingPlaceInfo(env);
  const returnCenterCode = env.COUPANG_RETURN_SHIPPING_PLACE_ID
    || returnPlace.code
    || env.COUPANG_RETURN_CENTER_CODE
    || product.returnCenterCode
    || '';

  // 카테고리 메타에서 고시 카테고리 조회
  const meta = await getCoupangCategoryMeta(env, product.categoryId);

  // 고시정보 구성
  let notices: any[];
  if (product.noticeCategory) {
    notices = [{
      noticeCategoryName: product.noticeCategory,
      noticeCategoryDetailName: NOTICE_DETAIL_MAP[product.noticeCategory] ?? '품명 및 모델명',
      content: '상세페이지 참조',
    }];
  } else if (meta.noticeCategories.length > 0) {
    notices = meta.noticeCategories.map(cat => ({
      noticeCategoryName: cat.noticeCategoryName,
      noticeCategoryDetailName: getNoticeDetailName(cat.noticeCategoryName, cat.details),
      content: '상세페이지 참조',
    }));
  } else {
    notices = [{
      noticeCategoryName: '기타 재화',
      noticeCategoryDetailName: '품명 및 모델명',
      content: '상세페이지 참조',
    }];
  }

  console.log('등록 디버그:', JSON.stringify({
    categoryId: product.categoryId,
    returnCenterCode,
    returnPlace,
    noticeCount: notices.length,
    firstNotice: notices[0],
    adultOnly: product.adultOnlyYn,
    overseasYn: product.overseasYn,
    buyCountPeriod: product.buyCountPeriod,
    buyCount: product.buyCount,
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
    returnCenterCode: returnCenterCode ? Number(returnCenterCode) : undefined,
    returnZipCode: returnPlace.zipCode || undefined,
    returnAddress: returnPlace.address || undefined,
    returnAddressDetail: returnPlace.addressDetail || undefined,
    returnContactName: returnPlace.contactName || undefined,
    returnPhoneNumber: returnPlace.phoneNumber || undefined,
    outboundShippingTimeDay: 2,
    unionDeliveryType: 'UNION_DELIVERY',
    deliveryMethod: 'SEQUENCIAL',
    deliveryCompanyCode: 'LOGEN',
    deliveryChargeType: 'FREE',
    deliveryCharge: 0,
    freeShipOverAmount: 0,
    remoteAreaYn: 'N',
    returnCharge: 5000,
    returnChargeWithPackage: 5000,
    initialReturnCharge: 5000,
    pccNeeded: false,
    brand: product.brandName || '',
    manufacture: product.brandName || '',
    items: [
      {
        itemName: product.optionName || product.vendorItemName,
        taxType: 'TAX',
        adultOnly: product.adultOnlyYn === 'Y',
        overseasPurchaseAgencyYn: product.overseasYn === 'Y',
        originalPrice: product.originalPrice,
        salePrice: product.salePrice,
        maximumBuyCount: product.buyCount ?? 999,
        maximumBuyCountPeriod: product.buyCountPeriod || 'DAY',
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

  console.log('전송 payload (items[0] key 목록):', Object.keys(payload.items[0]));
  console.log('delivery:', payload.deliveryMethod, payload.deliveryCompanyCode, 'remoteAreaYn:', payload.remoteAreaYn);
  console.log('item.adultOnly:', (payload.items[0] as any).adultOnly, 'overseasPurchaseAgencyYn:', (payload.items[0] as any).overseasPurchaseAgencyYn);
  console.log('maximumBuyCount:', (payload.items[0] as any).maximumBuyCount, 'period:', (payload.items[0] as any).maximumBuyCountPeriod);

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
    notice_category?: string;
    adult_only?: string;
    overseas_yn?: string;
    buy_count_period?: string;
    buy_count?: number;
    category_code?: number;
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

  // 카테고리: 사용자 지정 → Coupang API 조회 → 폴백 맵 순서로 결정
  let categoryId: number;
  if (source.category_code) {
    categoryId = source.category_code;
    console.log('카테고리 사용자 지정:', categoryId);
  } else {
    const searchKw = source.keyword || source.title;
    categoryId = guessCategoryId(searchKw);
    try {
      const categories = await getCoupangDisplayCategories(env);
      const found = findBestCategoryCode(categories, searchKw);
      if (found) categoryId = found;
    } catch (e) {
      console.warn('카테고리 API 조회 실패, 폴백 사용:', e);
    }
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
    noticeCategory: source.notice_category,
    adultOnlyYn: source.adult_only || 'N',
    overseasYn: source.overseas_yn || 'N',
    buyCountPeriod: source.buy_count_period || 'DAY',
    buyCount: source.buy_count ?? 999,
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
