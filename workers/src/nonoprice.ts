import { Env } from './types';

export interface NonoPriceRegisterPayload {
  resellerId: string;
  name: string;
  unit: string;
  costPrice: number;        // 코스트코 판매금액 (정상가)
  platformMargin: number;   // 플랫폼 마진 (%)
  discountAmount?: number;  // 할인금액 (행사 있을 때만)
  saleStartDate?: string;   // 행사기간 시작
  saleEndDate?: string;     // 행사기간 종료
  sourceRef?: string;
  status?: 'active' | 'soldout' | 'hidden';
  images?: string[];
}

export interface NonoPriceUpdatePayload {
  price?: number;
  salePrice?: number | null;
  saleStartDate?: string | null;
  saleEndDate?: string | null;
  status?: 'active' | 'soldout' | 'hidden';
}

async function nonopriceFetch(
  env: Env,
  path: string,
  init: RequestInit
): Promise<{ ok: boolean; status: number; data: any }> {
  const req = new Request(`https://nonoprice-internal${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Key': env.NONOPRICE_INTERNAL_SECRET,
      ...(init.headers as Record<string, string> || {}),
    },
  });
  const res = await env.NONOPRICE_API.fetch(req);
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

export async function registerToNonoPrice(
  payload: NonoPriceRegisterPayload,
  env: Env
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const { ok, status, data } = await nonopriceFetch(env, '/api/v1/internal/products', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${status}`;
    return { success: false, error: msg };
  }
  return { success: true, data };
}

export async function updateNonoPriceBySourceRef(
  sourceRef: string,
  payload: NonoPriceUpdatePayload,
  env: Env
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const { ok, status, data } = await nonopriceFetch(
    env,
    `/api/v1/internal/products/by-source/${encodeURIComponent(sourceRef)}`,
    { method: 'PUT', body: JSON.stringify(payload) }
  );
  if (!ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${status}`;
    return { success: false, error: msg };
  }
  return { success: true, data };
}
