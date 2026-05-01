export interface Env {
  // D1 Database
  DB: D1Database;
  // KV Cache
  CACHE: KVNamespace;
  // Secrets
  NAVER_CLIENT_ID: string;
  NAVER_CLIENT_SECRET: string;
  META_ACCESS_TOKEN: string;
  META_AD_ACCOUNT_ID: string;
  META_PAGE_ID: string;
  CLAUDE_API_KEY: string;
  REMOVEBG_API_KEY: string;
  // 쿠팡 API (신규)
  COUPANG_ACCESS_KEY: string;
  COUPANG_SECRET_KEY: string;
  COUPANG_VENDOR_ID: string;
  // Vars
  SMART_STORE_URL: string;
  MIN_ROAS: string;
  DAILY_BUDGET_PER_AD: string;
  MAX_ADS_RUNNING: string;
}

export interface Product {
  id?: number;
  name: string;
  keyword: string;
  smart_store_url?: string;
  coupang_product_id?: number;      // 쿠팡 상품 ID (신규)
  coupang_vendor_item_id?: number;  // 쿠팡 벤더 아이템 ID (신규)
  coupang_url?: string;             // 쿠팡 상품 URL (신규)
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
