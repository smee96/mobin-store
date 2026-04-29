import { Env, Campaign, AdCreative, Product, MetaTargeting, AdMetrics } from './types';

const META_API_VERSION = 'v21.0';
const META_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

// 인스타그램 광고 자동 생성 (캠페인 → 광고세트 → 광고)
export async function createInstagramAd(
  env: Env,
  product: Product,
  creative: AdCreative,
  imageUrl: string
): Promise<{ campaignId: string; adsetId: string; adId: string } | null> {
  try {
    // 1. 캠페인 생성
    const campaignId = await createCampaign(env, product.name);
    
    // 2. 광고세트 생성 (타겟팅 + 예산)
    const targeting = buildTargeting(product);
    const adsetId = await createAdSet(env, campaignId, product, targeting);
    
    // 3. 광고 소재 업로드
    const creativeId = await uploadCreative(env, creative, imageUrl, product);
    
    // 4. 광고 생성
    const adId = await createAd(env, adsetId, creativeId, product.name);

    return { campaignId, adsetId, adId };
  } catch (e) {
    console.error('createInstagramAd error:', e);
    return null;
  }
}

async function createCampaign(env: Env, productName: string): Promise<string> {
  const response = await metaPost(env, `act_${env.META_AD_ACCOUNT_ID}/campaigns`, {
    name: `[Movin] ${productName} - ${new Date().toISOString().split('T')[0]}`,
    objective: 'OUTCOME_SALES',
    status: 'ACTIVE',
    special_ad_categories: [],
  });

  return response.id;
}

async function createAdSet(
  env: Env,
  campaignId: string,
  product: Product,
  targeting: MetaTargeting
): Promise<string> {
  const dailyBudget = parseInt(env.DAILY_BUDGET_PER_AD) * 10; // 원 → 원 (Meta는 최소 단위)
  
  const response = await metaPost(env, `act_${env.META_AD_ACCOUNT_ID}/adsets`, {
    name: `[Movin] ${product.keyword} 타겟`,
    campaign_id: campaignId,
    daily_budget: dailyBudget,
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'OFFSITE_CONVERSIONS',
    targeting: {
      age_min: targeting.age_min,
      age_max: targeting.age_max,
      genders: targeting.genders,
      geo_locations: targeting.geo_locations,
      interests: targeting.interests,
      publisher_platforms: ['instagram'],
      instagram_positions: ['stream', 'story', 'reels'],
    },
    destination_type: 'WEBSITE',
    status: 'ACTIVE',
    // 전환 이벤트 (픽셀 설정 후 활성화)
    // promoted_object: { pixel_id: 'YOUR_PIXEL_ID', custom_event_type: 'PURCHASE' }
  });

  return response.id;
}

async function uploadCreative(
  env: Env,
  creative: AdCreative,
  imageUrl: string,
  product: Product
): Promise<string> {
  // 이미지 업로드 (base64 또는 URL)
  let imageHash: string;

  if (imageUrl.startsWith('data:')) {
    // base64 이미지 업로드
    const base64Data = imageUrl.split(',')[1];
    const imgResponse = await metaPost(env, `act_${env.META_AD_ACCOUNT_ID}/adimages`, {
      bytes: base64Data,
    });
    imageHash = Object.values(imgResponse.images as Record<string, { hash: string }>)[0].hash;
  } else {
    // URL로 이미지 업로드
    const imgResponse = await metaPost(env, `act_${env.META_AD_ACCOUNT_ID}/adimages`, {
      url: imageUrl,
    });
    imageHash = Object.values(imgResponse.images as Record<string, { hash: string }>)[0].hash;
  }

  // 광고 소재 생성
  const hashtags = (creative.hashtags || []).map(h => `#${h}`).join(' ');
  const fullMessage = `${creative.body_text}\n\n${hashtags}`;

  const creativeResponse = await metaPost(env, `act_${env.META_AD_ACCOUNT_ID}/adcreatives`, {
    name: `[Movin] ${creative.headline}`,
    object_story_spec: {
      page_id: env.META_PAGE_ID,
      link_data: {
        image_hash: imageHash,
        link: product.smart_store_url || env.SMART_STORE_URL,
        message: fullMessage,
        name: creative.headline,
        call_to_action: {
          type: 'SHOP_NOW',
          value: { link: product.smart_store_url || env.SMART_STORE_URL },
        },
      },
    },
    instagram_actor_id: env.META_PAGE_ID,
  });

  return creativeResponse.id;
}

async function createAd(
  env: Env,
  adsetId: string,
  creativeId: string,
  productName: string
): Promise<string> {
  const response = await metaPost(env, `act_${env.META_AD_ACCOUNT_ID}/ads`, {
    name: `[Movin] ${productName} Ad`,
    adset_id: adsetId,
    creative: { creative_id: creativeId },
    status: 'ACTIVE',
  });

  return response.id;
}

// 광고 성과 수집 (ROAS 체크)
export async function fetchAdMetrics(
  env: Env,
  metaAdId: string,
  date?: string
): Promise<Partial<AdMetrics>> {
  const targetDate = date || new Date().toISOString().split('T')[0];

  const params = new URLSearchParams({
    fields: 'impressions,clicks,spend,actions,action_values',
    time_range: JSON.stringify({ since: targetDate, until: targetDate }),
    access_token: env.META_ACCESS_TOKEN,
  });

  const response = await fetch(`${META_BASE}/${metaAdId}/insights?${params}`);
  if (!response.ok) return {};

  const data = await response.json() as any;
  if (!data.data?.[0]) return {};

  const insight = data.data[0];
  const spend = parseFloat(insight.spend || '0') * 1000; // USD → 원 (대략)
  const impressions = parseInt(insight.impressions || '0');
  const clicks = parseInt(insight.clicks || '0');

  // 구매 전환 추출
  const purchaseAction = insight.actions?.find((a: any) => a.action_type === 'purchase');
  const purchases = parseInt(purchaseAction?.value || '0');

  const purchaseValue = insight.action_values?.find((a: any) => a.action_type === 'purchase');
  const revenue = parseFloat(purchaseValue?.value || '0') * 1000;

  return {
    impressions,
    clicks,
    spend,
    purchases,
    revenue,
    ctr: clicks / Math.max(impressions, 1),
    cpc: spend / Math.max(clicks, 1),
    roas: revenue / Math.max(spend, 1),
  };
}

// 광고 상태 변경 (활성/일시정지)
export async function updateAdStatus(
  env: Env,
  metaAdId: string,
  status: 'ACTIVE' | 'PAUSED'
): Promise<boolean> {
  try {
    await metaPost(env, metaAdId, { status }, 'POST');
    return true;
  } catch {
    return false;
  }
}

// 예산 변경
export async function updateAdSetBudget(
  env: Env,
  metaAdsetId: string,
  newDailyBudget: number
): Promise<boolean> {
  try {
    const response = await fetch(`${META_BASE}/${metaAdsetId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        daily_budget: newDailyBudget,
        access_token: env.META_ACCESS_TOKEN,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// 상품 카테고리 기반 타겟팅 빌드
function buildTargeting(product: Product): MetaTargeting {
  const keyword = product.keyword.toLowerCase();

  // 키워드 기반 관심사 매핑
  const interestMap: Record<string, { id: string; name: string }[]> = {
    '패션': [{ id: '6003107902433', name: 'Fashion' }, { id: '6003397576786', name: 'Online shopping' }],
    '운동': [{ id: '6003270539536', name: 'Physical fitness' }, { id: '6004064067424', name: 'Health & wellness' }],
    '화장품': [{ id: '6003197636786', name: 'Beauty' }, { id: '6003109012786', name: 'Skin care' }],
    '반려동물': [{ id: '6004007814894', name: 'Pets' }, { id: '6003206483572', name: 'Dogs' }],
    '육아': [{ id: '6003207145786', name: 'Parenting' }, { id: '6003325226786', name: 'Babies' }],
  };

  let interests = [{ id: '6003397576786', name: 'Online shopping' }];
  for (const [key, value] of Object.entries(interestMap)) {
    if (keyword.includes(key)) {
      interests = [...interests, ...value];
      break;
    }
  }

  return {
    age_min: 20,
    age_max: 45,
    geo_locations: { countries: ['KR'] },
    interests,
  };
}

// Meta API 공통 POST 헬퍼
async function metaPost(
  env: Env,
  endpoint: string,
  body: Record<string, unknown>,
  method: string = 'POST'
): Promise<any> {
  const url = endpoint.startsWith('http') ? endpoint : `${META_BASE}/${endpoint}`;

  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: env.META_ACCESS_TOKEN }),
  });

  const data = await response.json() as any;

  if (!response.ok || data.error) {
    throw new Error(data.error?.message || `Meta API error: ${response.status}`);
  }

  return data;
}
