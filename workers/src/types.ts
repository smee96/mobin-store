export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  NAVER_CLIENT_ID: string;
  NAVER_CLIENT_SECRET: string;
  META_ACCESS_TOKEN: string;
  META_AD_ACCOUNT_ID: string;
  META_PAGE_ID: string;
  CLAUDE_API_KEY: string;
  REMOVEBG_API_KEY: string;
  RAPIDAPI_KEY: string;        // RapidAPI Key (AliExpress Datahub)
  COUPANG_ACCESS_KEY: string;
  COUPANG_SECRET_KEY: string;
  COUPANG_VENDOR_ID: string;
  COUPANG_VENDOR_USER_ID: string;
  COUPANG_OUTBOUND_SHIPPING_PLACE_CODE: string;
  COUPANG_DELIVERY_COMPANY_CODE: string;
  COUPANG_RETURN_CENTER_CODE: string;
  COUPANG_RETURN_SHIPPING_PLACE_ID?: string;
  COUPANG_RETURN_ZIP_CODE?: string;
  COUPANG_RETURN_ADDRESS?: string;
  COUPANG_RETURN_ADDRESS_DETAIL?: string;
  COUPANG_RETURN_CONTACT_NAME?: string;
  COUPANG_RETURN_PHONE?: string;
  SMART_STORE_URL: string;
  MIN_ROAS: string;
  DAILY_BUDGET_PER_AD: string;
  MAX_ADS_RUNNING: string;
  // ── 노노프라이스(shark-lee-api) 연동 ──
  NONOPRICE_INTERNAL_SECRET: string;   // X-Internal-Key 헤더값 (shark-lee-api와 동일 값 공유)
  NONOPRICE_RESELLER_ID: string;       // 판매자 #1 ID — 이규한 계정 (resellers.id)
  NONOPRICE_RESELLER_ID_2?: string;    // 판매자 #2 ID — 이재성 계정 (선택, 설정 시 병렬 등록)
  NONOPRICE_API_URL: string;           // shark-lee-api Worker URL (fallback)
  SHARK_LEE_API: Fetcher;              // Service Binding (workers.dev 1042 오류 우회)
}

export interface Product {
  id?: number;
  name: string;
  keyword: string;
  smart_store_url?: string;
  coupang_product_id?: number;
  coupang_url?: string;
  price?: number;
  margin_rate?: number;
  monthly_search_volume?: number;
  competition_count?: number;
  score?: number;
  status?: string;
  source_url?: string;
  source_image?: string;
}

export interface AdCreative {
  id?: number;
  product_id: number;
  headline: string;
  body_text: string;
  cta?: string;
  hashtags?: string[];
  image_url?: string;
  image_prompt?: string;
  status?: string;
}

export interface Campaign {
  id?: number;
  product_id: number;
  creative_id: number;
  meta_campaign_id?: string;
  meta_adset_id?: string;
  meta_ad_id?: string;
  status?: string;
  daily_budget?: number;
  targeting?: MetaTargeting;
}

export interface MetaTargeting {
  age_min: number;
  age_max: number;
  genders?: number[];
  interests?: { id: string; name: string }[];
  geo_locations: { countries: string[] };
}

export interface AdMetrics {
  campaign_id: number;
  date: string;
  impressions: number;
  clicks: number;
  spend: number;
  purchases: number;
  revenue: number;
  ctr: number;
  cpc: number;
  roas: number;
}

export interface TrendKeyword {
  keyword: string;
  category?: string;
  search_volume?: number;
  competition_count?: number;
  trend_score?: number;
}

export interface AutomationLog {
  job_type: string;
  status: 'running' | 'success' | 'failed';
  message?: string;
  details?: Record<string, unknown>;
}
