/**
 * nonoprice.ts — mobin-store → 노노프라이스(shark-lee-api) 연동 모듈
 *
 * 주요 기능:
 *   1. Claude AI로 판매용 상품설명 자동 생성
 *   2. 코스트코 이미지 URL 수집 (allImages 활용)
 *   3. shark-lee-api internal 엔드포인트로 상품 등록
 *
 * 엔드포인트:
 *   POST https://{NONOPRICE_API_URL}/api/v1/internal/products       (단건)
 *   POST https://{NONOPRICE_API_URL}/api/v1/internal/products/batch (일괄)
 *   GET  https://{NONOPRICE_API_URL}/api/v1/internal/reseller/:id
 *
 * 인증: X-Internal-Key: {NONOPRICE_INTERNAL_SECRET}
 */

import { Env } from './types';
import { CostcoProduct } from './costco';

// ─── 응답 타입 ────────────────────────────────────────────────────
export interface NonoPriceRegisterResult {
  success: boolean;
  id?: string;
  name?: string;
  price?: number;
  nonopriceUrl?: string;
  duplicate?: boolean;
  message?: string;
  error?: string;
}

export interface NonoPriceBatchResult {
  success: boolean;
  total: number;
  created: number;
  errors: number;
  results: Array<{
    name: string;
    id?: string;
    status: 'created' | 'duplicate' | 'error';
    error?: string;
  }>;
  error?: string;
}

export interface NonoPriceResellerInfo {
  id: string;
  businessName: string;
  ownerName: string;
  subscriptionStatus: string;
}

// ─── 설정 확인 ────────────────────────────────────────────────────
export function isNonoPriceConfigured(env: Env): boolean {
  return !!(
    env.NONOPRICE_INTERNAL_SECRET &&
    env.NONOPRICE_RESELLER_ID &&
    env.NONOPRICE_API_URL
  );
}

// ─── Claude AI 상품설명 생성 ──────────────────────────────────────
/**
 * 코스트코 상품 정보를 바탕으로 Claude API로 판매용 설명 생성
 * - CLAUDE_API_KEY 없으면 기본 설명(템플릿) 반환
 * - 실패해도 등록 자체는 계속 진행
 */
export async function generateProductDescription(
  env: Env,
  product: CostcoProduct
): Promise<string> {
  // API 키 없으면 기본 템플릿 반환
  if (!env.CLAUDE_API_KEY) {
    return buildFallbackDescription(product);
  }

  // 프롬프트 구성 (코스트코 키워드·URL·가격 제외)
  const productInfo = [
    `상품명: ${product.name}`,
    product.period      ? `행사기간: ${product.period}` : '',
    product.unit        ? `단위/용량: ${product.unit}` : '',
    product.freeShipping === true ? '무료배송' : product.shippingFeeText || '',
    product.isSoldOut   ? '현재 품절' : '',
  ].filter(Boolean).join('\n');

  const prompt = `당신은 온라인 쇼핑몰 상품설명 전문 카피라이터입니다.
아래 상품 정보를 바탕으로 판매 플랫폼에 등록할 상품설명을 작성해주세요.

[상품 정보]
${productInfo}

[작성 규칙]
- 200~350자 이내로 간결하게
- 가격 정보(판매가, 정가, 할인율, 할인금액)는 절대 언급하지 말 것
- 최대 구매 수량은 절대 언급하지 말 것
- '코스트코' 단어는 절대 언급하지 말 것
- 상품의 특징, 용도, 품질을 중심으로 설명
- 행사기간이 있으면 한정 기간 강조
- 딱딱한 나열식 X → 자연스러운 문장으로
- 마지막에 구매 유도 문구 1줄 추가
- 이모지 적절히 사용 (과하지 않게, 줄당 1개 이하)
- 절대 허위/과장 금지, 실제 상품 정보만 기반으로 작성

상품설명만 출력하세요. 제목이나 부연설명 없이 설명 본문만 바로 출력하세요.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      console.error(`[nonoprice] Claude API error ${res.status}`);
      return buildFallbackDescription(product);
    }

    const data = await res.json() as any;
    const text = data?.content?.[0]?.text?.trim();
    if (!text) return buildFallbackDescription(product);

    return text;
  } catch (e) {
    console.error('[nonoprice] Claude API exception:', e);
    return buildFallbackDescription(product);
  }
}

/**
 * Claude 실패 시 사용하는 기본 템플릿 설명
 */
function buildFallbackDescription(product: CostcoProduct): string {
  const parts: string[] = [];

  if (product.period)      parts.push(`📅 행사기간: ${product.period}`);
  if (product.unit)        parts.push(`📦 용량/단위: ${product.unit}`);
  if (product.freeShipping === true) parts.push(`🚚 무료배송`);
  else if (product.shippingFeeText)  parts.push(`🚚 ${product.shippingFeeText}`);
  if (product.isSoldOut)    parts.push(`⚠️ 현재 품절 상태`);

  return parts.join('\n');
}

// ─── 이미지 URL 수집 ──────────────────────────────────────────────
/**
 * 코스트코 상품의 이미지 URL 목록을 반환
 * - allImages 우선 (여러 장), 없으면 imageUrl 단건
 * - 코스트코 CDN URL을 그대로 사용 (프록시 불필요)
 * - 최대 5장 제한
 */
export function collectProductImages(product: CostcoProduct): string[] {
  const MAX_IMAGES = 5;

  // allImages 배열이 있으면 우선 사용
  if (product.allImages && product.allImages.length > 0) {
    return product.allImages
      .filter((url): url is string => typeof url === 'string' && url.startsWith('http'))
      .slice(0, MAX_IMAGES);
  }

  // 단건 썸네일
  if (product.imageUrl && product.imageUrl.startsWith('http')) {
    return [product.imageUrl];
  }

  return [];
}

// ─── 내부 HTTP 호출 헬퍼 ─────────────────────────────────────────
/**
 * shark-lee-api에 단건 상품 등록 요청 전송
 * Service Binding 우선, fallback은 NONOPRICE_API_URL
 */
async function callRegisterAPI(
  env: Env,
  payload: Record<string, unknown>
): Promise<NonoPriceRegisterResult> {
  const reqInit: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': env.NONOPRICE_INTERNAL_SECRET,
    },
    body: JSON.stringify(payload),
  };

  let res: Response;
  if (env.SHARK_LEE_API) {
    res = await env.SHARK_LEE_API.fetch(
      new Request('https://shark-lee-api/api/v1/internal/products', reqInit)
    );
  } else {
    res = await fetch(`${env.NONOPRICE_API_URL.replace(/\/$/, '')}/api/v1/internal/products`, reqInit);
  }

  let data: any;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    data = await res.json();
  } else {
    const text = await res.text();
    console.error(`[nonoprice] non-JSON response ${res.status}:`, text.slice(0, 200));
    return { success: false, error: `shark-lee-api 비정상 응답 (${res.status}): ${text.slice(0, 80)}` };
  }

  if (!res.ok) {
    // zod validation 실패: { success: false, error: { issues: [{path,message},...] } }
    // errorResponse():      { success: false, error: { message, code } }
    const zodIssues = Array.isArray(data?.error?.issues)
      ? data.error.issues.map((i: any) => `${i.path?.join('.')}: ${i.message}`).join(', ')
      : null;
    const errDetail =
      zodIssues ??
      data?.error?.message ??
      data?.message ??
      JSON.stringify(data) ??
      `HTTP ${res.status}`;
    console.error(`[nonoprice] register failed ${res.status}:`, JSON.stringify(data));
    console.error(`[nonoprice] sent payload:`, JSON.stringify({
      name: payload.name,
      price: payload.price,
      regularPrice: payload.regularPrice,
      salePrice: (payload as any).salePrice,
      unit: payload.unit,
      resellerId: payload.resellerId,
    }));
    return {
      success: false,
      error: errDetail,
      _debug: {
        status: res.status,
        serverResponse: data,
        payload: { name: payload.name, price: payload.price, regularPrice: payload.regularPrice, unit: payload.unit },
      },
    } as any;
  }

  return {
    success: true,
    id: data?.data?.id,
    name: data?.data?.name,
    price: data?.data?.price,
    nonopriceUrl: data?.data?.nonopriceUrl,
    duplicate: data?.data?.duplicate ?? false,
    message: data?.data?.duplicate ? '이미 등록된 상품' : '등록 완료',
  };
}

// ─── 코스트코 상품 → 노노프라이스 페이로드 변환 ──────────────────
async function buildPayload(
  env: Env,
  product: CostcoProduct,
  options: { status?: 'active' | 'soldout' | 'hidden'; skipAI?: boolean; resellerId?: string; marginRate?: number } = {}
) {
  // 가격 — 코스트코 가격을 있는 그대로 전달 (마진은 노노프라이스 플랫폼에서 적용)
  //   priceNum      = 총결제금액 (할인 후 최종가)
  //   discountNum   = 할인금액
  //   originalPriceNum = 판매금액 (정가, = priceNum + discountNum)

  const priceNum    = product.priceNum > 0 ? product.priceNum : 0;
  const discountNum = product.discountNum ?? 0;

  // regularPrice: 판매금액(정가) = 총결제금액 + 할인금액 — 항상 전송
  const regularPrice = priceNum + discountNum;

  // salePrice: 총결제금액(할인가) — discountNum > 0 일 때만 전송, 0이면 생략
  const salePrice = discountNum > 0 ? priceNum : undefined;

  // 날짜 검증 (YYYY-MM-DD) — 형식 불일치 시 undefined
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  const toSafeDate = (d?: string): string | undefined => {
    if (!d) return undefined;
    const s = d.slice(0, 10);
    return dateRegex.test(s) ? s : undefined;
  };
  const saleStartDate = toSafeDate(product.promoStartDate);
  const saleEndDate   = toSafeDate(product.promoEndDate);

  // 단위
  const unit = product.unit
    ? product.unit.replace(/당\s*[\d,]+원/g, '').trim() || '1개'
    : '1개';

  // AI 상품설명 생성 (skipAI=true 이면 기본 템플릿 사용)
  const description = options.skipAI
    ? buildFallbackDescription(product)
    : await generateProductDescription(env, product);

  // 이미지
  const images = collectProductImages(product);

  // 상태
  const status = product.isSoldOut ? 'soldout' : (options.status ?? 'active');

  // ── 검증 / 정제 ──────────────────────────────────────────────
  // unit: 공백/빈값 방지
  const safeUnit = unit.trim() || '1개';

  // images: http(s) URL만, 최대 5장
  const safeImages = images
    .filter(u => {
      try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; }
      catch { return false; }
    })
    .slice(0, 5);

  // ── 마진 적용 판매가 계산 ─────────────────────────────────────────
  // shark-lee-api DB: price NOT NULL 필수
  // price = ceil((salePrice ?? regularPrice) × (1 + marginRate/100))
  const appliedMarginRate = options.marginRate ?? 15;
  const costcoPrice = salePrice ?? regularPrice;
  const price = Math.ceil(costcoPrice * (1 + appliedMarginRate / 100));

  return {
    resellerId: options.resellerId ?? env.NONOPRICE_RESELLER_ID,
    name: product.name,
    description,
    unit: safeUnit,
    price,                                             // 코스트코가 × (1 + marginRate/100), ceil 처리
    marginRate: appliedMarginRate,                     // 마진율 — DB 저장 (상품마다 다를 수 있음)
    images: safeImages,
    status,
    sortOrder: 0,
    sourceRef: `costco:${product.id}`,
    // ── 판매기간별 이중가격 ─────────────────────────────────────────
    regularPrice,                                      // basePrice.value (판매금액/정가) — 항상 전송
    ...(salePrice !== undefined ? { salePrice } : {}), // priceNum (총결제금액/할인가) — discountNum>0 일 때만
    ...(saleStartDate ? { saleStartDate } : {}),       // 행사 시작일 YYYY-MM-DD
    ...(saleEndDate   ? { saleEndDate }   : {}),       // 행사 종료일 YYYY-MM-DD
  };
}

// ─── 단건 등록 (단일 계정) ───────────────────────────────────────
export async function registerToNonoprice(
  env: Env,
  product: CostcoProduct,
  options: { status?: 'active' | 'soldout' | 'hidden'; skipAI?: boolean; resellerId?: string; marginRate?: number } = {}
): Promise<NonoPriceRegisterResult> {
  if (!isNonoPriceConfigured(env)) {
    return { success: false, error: '노노프라이스 연동 설정이 없습니다. (NONOPRICE_* 환경변수 확인)' };
  }

  const payload = await buildPayload(env, product, options);
  if (!payload.price || (payload.price as number) <= 0) {
    return { success: false, error: `상품 가격을 파싱할 수 없습니다: ${product.name}` };
  }

  try {
    return await callRegisterAPI(env, payload);
  } catch (e: any) {
    return { success: false, error: e.message ?? '네트워크 오류' };
  }
}

// ─── 단건 등록 (전체 계정 병렬) ──────────────────────────────────
/**
 * NONOPRICE_RESELLER_ID (이규한) + NONOPRICE_RESELLER_ID_2 (이재성, 설정 시)
 * 두 계정에 동시에 상품을 등록한다.
 *
 * 반환값:
 *   result1  — 이규한 계정 결과
 *   result2  — 이재성 계정 결과 (RESELLER_ID_2 미설정 시 null)
 *   success  — result1 성공 여부 (기존 호환)
 */
export async function registerToNonopriceAll(
  env: Env,
  product: CostcoProduct,
  options: { status?: 'active' | 'soldout' | 'hidden'; skipAI?: boolean; marginRate?: number } = {}
): Promise<{
  success: boolean;
  result1: NonoPriceRegisterResult;
  result2: NonoPriceRegisterResult | null;
  message?: string;
  error?: string;
}> {
  if (!isNonoPriceConfigured(env)) {
    const err = { success: false, error: '노노프라이스 연동 설정이 없습니다.' };
    return { success: false, result1: err, result2: null, error: err.error };
  }

  // AI 설명은 한 번만 생성 (두 계정 공용)
  // buildPayload를 resellerId만 바꿔 두 번 호출하되, description은 미리 공유
  const [payload1, payload2] = await Promise.all([
    buildPayload(env, product, { ...options, resellerId: env.NONOPRICE_RESELLER_ID }),
    env.NONOPRICE_RESELLER_ID_2
      ? buildPayload(env, product, { ...options, skipAI: true, resellerId: env.NONOPRICE_RESELLER_ID_2 })
      : Promise.resolve(null),
  ]);

  if (!payload1.price || (payload1.price as number) <= 0) {
    const err = { success: false, error: `가격 파싱 불가: ${product.name}` };
    return { success: false, result1: err, result2: null, error: err.error };
  }

  // payload1 description 공유 → payload2 skipAI 비용 절감 + 동일 설명 유지
  if (payload2) {
    (payload2 as any).description = (payload1 as any).description;
  }

  // 두 계정 병렬 호출
  const [result1, result2] = await Promise.all([
    callRegisterAPI(env, payload1).catch((e: any) => ({ success: false, error: e.message } as NonoPriceRegisterResult)),
    payload2
      ? callRegisterAPI(env, payload2).catch((e: any) => ({ success: false, error: e.message } as NonoPriceRegisterResult))
      : Promise.resolve(null),
  ]);

  const allOk = result1.success && (result2 === null || result2.success);
  const messages: string[] = [];
  if (result1.success) messages.push(`#1(이규한): ${result1.duplicate ? '중복' : '등록완료'}`);
  else messages.push(`#1(이규한) 실패: ${result1.error}`);
  if (result2) {
    if (result2.success) messages.push(`#2(이재성): ${result2.duplicate ? '중복' : '등록완료'}`);
    else messages.push(`#2(이재성) 실패: ${result2.error}`);
  }

  return {
    success: result1.success,   // 기본 계정(이규한) 성공 여부를 최상위 success로
    result1,
    result2,
    message: messages.join(' / '),
    ...(!allOk ? { error: messages.filter(m => m.includes('실패')).join('; ') } : {}),
  };
}

// ─── 일괄 등록 (batch, AI 설명은 각각 생성) ─────────────────────
export async function batchRegisterToNonoprice(
  env: Env,
  products: CostcoProduct[],
  options: { status?: 'active' | 'soldout' | 'hidden'; skipAI?: boolean; marginRate?: number } = {}
): Promise<NonoPriceBatchResult> {
  if (!isNonoPriceConfigured(env)) {
    return {
      success: false, total: products.length, created: 0, errors: products.length,
      results: [], error: '노노프라이스 연동 설정이 없습니다.',
    };
  }

  // 가격 있는 상품만 필터 후 페이로드 병렬 생성
  const validProducts = products.filter(p => p.priceNum > 0);

  if (validProducts.length === 0) {
    return {
      success: false, total: products.length, created: 0, errors: products.length,
      results: [], error: '가격 정보가 있는 상품이 없습니다.',
    };
  }

  // batch API는 AI 설명 개별 생성 비용 고려 → skipAI=true로 일괄 처리
  // (단건 등록은 AI 사용, 일괄은 템플릿 사용으로 속도 우선)
  const batchSkipAI = options.skipAI ?? true;

  const payloads = await Promise.all(
    validProducts.map(p => buildPayload(env, p, { ...options, skipAI: batchSkipAI }))
  );

  // resellerId는 최상위에서 한 번만
  const items = payloads.map(({ resellerId: _, ...rest }) => rest);

  // batch API 호출 헬퍼
  const callBatchAPI = async (resellerId: string): Promise<NonoPriceBatchResult> => {
    const batchReqInit: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Key': env.NONOPRICE_INTERNAL_SECRET },
      body: JSON.stringify({ resellerId, products: items }),
    };
    const res = env.SHARK_LEE_API
      ? await env.SHARK_LEE_API.fetch(new Request('https://shark-lee-api/api/v1/internal/products/batch', batchReqInit))
      : await fetch(`${env.NONOPRICE_API_URL.replace(/\/$/, '')}/api/v1/internal/products/batch`, batchReqInit);

    const data = await res.json() as any;
    if (!res.ok) {
      return {
        success: false, total: validProducts.length, created: 0, errors: validProducts.length,
        results: [], error: data?.error?.message ?? data?.message ?? `HTTP ${res.status}`,
      };
    }
    return {
      success: true,
      total: data?.data?.total ?? items.length,
      created: data?.data?.created ?? 0,
      errors: data?.data?.errors ?? 0,
      results: data?.data?.results ?? [],
    };
  };

  try {
    // 계정 #1 (이규한) + 계정 #2 (이재성, 설정 시) 병렬 호출
    const [res1, res2] = await Promise.all([
      callBatchAPI(env.NONOPRICE_RESELLER_ID),
      env.NONOPRICE_RESELLER_ID_2
        ? callBatchAPI(env.NONOPRICE_RESELLER_ID_2)
        : Promise.resolve(null),
    ]);

    // 두 계정 결과 합산 (created/errors 합계)
    const totalCreated = res1.created + (res2?.created ?? 0);
    const totalErrors  = res1.errors  + (res2?.errors  ?? 0);

    return {
      success: res1.success,
      total: res1.total,
      created: totalCreated,
      errors: totalErrors,
      results: res1.results,
      ...(res2 && !res2.success ? { error: `#2(이재성) 실패: ${res2.error}` } : {}),
    };
  } catch (e: any) {
    return {
      success: false, total: products.length, created: 0, errors: products.length,
      results: [], error: e.message ?? '네트워크 오류',
    };
  }
}

// ─── 판매자 정보 조회 ────────────────────────────────────────────
export async function getNonoPriceResellerInfo(
  env: Env,
  resellerId?: string
): Promise<{ success: boolean; reseller?: NonoPriceResellerInfo; error?: string }> {
  if (!isNonoPriceConfigured(env)) {
    return { success: false, error: '노노프라이스 연동 설정이 없습니다.' };
  }

  const id = resellerId ?? env.NONOPRICE_RESELLER_ID;
  try {
    const resellerReqInit: RequestInit = { headers: { 'X-Internal-Key': env.NONOPRICE_INTERNAL_SECRET } };
    const res = env.SHARK_LEE_API
      ? await env.SHARK_LEE_API.fetch(new Request(`https://shark-lee-api/api/v1/internal/reseller/${id}`, resellerReqInit))
      : await fetch(`${env.NONOPRICE_API_URL.replace(/\/$/, '')}/api/v1/internal/reseller/${id}`, resellerReqInit);

    const data = await res.json() as any;
    if (!res.ok) {
      return { success: false, error: data?.error?.message ?? `HTTP ${res.status}` };
    }

    return { success: true, reseller: data?.data };
  } catch (e: any) {
    return { success: false, error: e.message ?? '네트워크 오류' };
  }
}
