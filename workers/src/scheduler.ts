import { Env } from './types';
import { collectTrendKeywords, saveTrendKeywords } from './naver';
import { generateCopiesForNewProducts } from './ai';
import { createInstagramAd, fetchAdMetrics, updateAdStatus, updateAdSetBudget } from './meta';
import { prepareAdImage } from './image';

// Cron 트리거 분기
export async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  const hour = new Date(event.scheduledTime).getUTCHours();
  const dayOfWeek = new Date(event.scheduledTime).getUTCDay(); // 0=일, 1=월

  if (hour === 0) await runJob(env, 'trend_collect', collectTrendsJob);
  if (hour === 1) await runJob(env, 'creative_gen', creativeGenJob);
  if (hour === 2) await runJob(env, 'ad_launch', adLaunchJob);
  if (hour === 12) await runJob(env, 'metrics_collect', metricsCollectJob);
  if (hour === 0 && dayOfWeek === 1) await runJob(env, 'optimize', optimizeJob);
}

// 공통 Job 래퍼 (로깅 + 에러 처리)
async function runJob(
  env: Env,
  jobType: string,
  fn: (env: Env) => Promise<string>
): Promise<void> {
  const logId = await startLog(env, jobType);
  try {
    const message = await fn(env);
    await finishLog(env, logId, 'success', message);
  } catch (e: any) {
    await finishLog(env, logId, 'failed', e.message);
    console.error(`[${jobType}] failed:`, e);
  }
}

// ─────────────────────────────────────────
// JOB 1: 트렌드 키워드 수집 (매일 09:00 KST)
// ─────────────────────────────────────────
async function collectTrendsJob(env: Env): Promise<string> {
  const keywords = await collectTrendKeywords(env);
  await saveTrendKeywords(env, keywords);

  // 점수 상위 키워드를 자동으로 상품 후보로 등록
  const top = keywords.filter(k => (k.trend_score ?? 0) >= 50).slice(0, 10);
  for (const kw of top) {
    // 이미 등록된 키워드 중복 방지
    const existing = await env.DB.prepare(
      `SELECT id FROM products WHERE keyword = ?`
    ).bind(kw.keyword).first();

    if (!existing) {
      await env.DB.prepare(
        `INSERT INTO products (name, keyword, monthly_search_volume, competition_count, score, status)
         VALUES (?, ?, ?, ?, ?, 'active')`
      )
        .bind(
          kw.keyword,
          kw.keyword,
          kw.search_volume ?? 0,
          kw.competition_count ?? 0,
          kw.trend_score ?? 0
        )
        .run();
    }

    await env.DB.prepare(
      `UPDATE trend_keywords SET processed = 1 WHERE keyword = ?`
    ).bind(kw.keyword).run();
  }

  return `${keywords.length}개 키워드 수집, ${top.length}개 상품 후보 등록`;
}

// ─────────────────────────────────────────
// JOB 2: AI 광고 소재 생성 (매일 10:00 KST)
// ─────────────────────────────────────────
async function creativeGenJob(env: Env): Promise<string> {
  const count = await generateCopiesForNewProducts(env);
  return `${count}개 광고 소재 생성 완료`;
}

// ─────────────────────────────────────────
// JOB 3: 광고 집행 (매일 11:00 KST)
// ─────────────────────────────────────────
async function adLaunchJob(env: Env): Promise<string> {
  // 현재 실행 중인 광고 수 확인
  const activeCount = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM campaigns WHERE status = 'active'`
  ).first<{ cnt: number }>();

  const maxAds = parseInt(env.MAX_ADS_RUNNING);
  const current = activeCount?.cnt ?? 0;
  if (current >= maxAds) {
    return `이미 ${current}개 광고 실행 중 (최대 ${maxAds}개)`;
  }

  const slots = maxAds - current;

  // 소재가 있지만 광고가 없는 상품 조회
  const result = await env.DB.prepare(
    `SELECT p.*, ac.id as creative_id, ac.headline, ac.body_text, ac.cta, ac.hashtags, ac.image_prompt
     FROM products p
     JOIN ad_creatives ac ON p.id = ac.product_id
     LEFT JOIN campaigns c ON p.id = c.product_id AND c.status = 'active'
     WHERE p.status = 'active' AND ac.status = 'approved' AND c.id IS NULL
     ORDER BY p.score DESC
     LIMIT ?`
  ).bind(slots).all();

  let launched = 0;
  for (const row of result.results as any[]) {
    // 이미지 준비
    const imageUrl = row.smart_store_url
      ? await prepareAdImage(env, row.smart_store_url)
      : null;

    if (!imageUrl) {
      console.warn(`No image for product ${row.id}, skipping`);
      continue;
    }

    const creative = {
      id: row.creative_id,
      product_id: row.id,
      headline: row.headline,
      body_text: row.body_text,
      cta: row.cta,
      hashtags: JSON.parse(row.hashtags || '[]'),
      image_url: imageUrl,
    };

    const adResult = await createInstagramAd(env, row, creative, imageUrl);

    if (adResult) {
      await env.DB.prepare(
        `INSERT INTO campaigns (product_id, creative_id, meta_campaign_id, meta_adset_id, meta_ad_id, status, daily_budget)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`
      )
        .bind(
          row.id,
          row.creative_id,
          adResult.campaignId,
          adResult.adsetId,
          adResult.adId,
          parseInt(env.DAILY_BUDGET_PER_AD)
        )
        .run();

      launched++;
    }
  }

  return `${launched}개 광고 집행 완료`;
}

// ─────────────────────────────────────────
// JOB 4: 성과 수집 & 저조 광고 중단 (매일 21:00 KST)
// ─────────────────────────────────────────
async function metricsCollectJob(env: Env): Promise<string> {
  const today = new Date().toISOString().split('T')[0];
  const minRoas = parseFloat(env.MIN_ROAS) / 100; // 150 → 1.5

  const campaigns = await env.DB.prepare(
    `SELECT * FROM campaigns WHERE status = 'active' AND meta_ad_id IS NOT NULL`
  ).all();

  let collected = 0;
  let paused = 0;

  for (const campaign of campaigns.results as any[]) {
    const metrics = await fetchAdMetrics(env, campaign.meta_ad_id, today);
    if (!metrics.impressions) continue;

    // 성과 저장
    await env.DB.prepare(
      `INSERT OR REPLACE INTO ad_metrics
       (campaign_id, date, impressions, clicks, spend, purchases, revenue, ctr, cpc, roas)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        campaign.id, today,
        metrics.impressions ?? 0, metrics.clicks ?? 0,
        metrics.spend ?? 0, metrics.purchases ?? 0,
        metrics.revenue ?? 0, metrics.ctr ?? 0,
        metrics.cpc ?? 0, metrics.roas ?? 0
      )
      .run();

    collected++;

    // ROAS가 최소 기준 이하이고, 지출이 10,000원 이상이면 광고 중단
    const hasEnoughSpend = (metrics.spend ?? 0) >= 10000;
    const poorPerformance = (metrics.roas ?? 0) < minRoas && hasEnoughSpend;

    if (poorPerformance) {
      await updateAdStatus(env, campaign.meta_ad_id, 'PAUSED');
      await env.DB.prepare(
        `UPDATE campaigns SET status = 'paused', updated_at = datetime('now') WHERE id = ?`
      ).bind(campaign.id).run();
      paused++;
    }
  }

  return `${collected}개 성과 수집, ${paused}개 광고 일시정지`;
}

// ─────────────────────────────────────────
// JOB 5: 주간 최적화 (매주 월요일 09:00 KST)
// ─────────────────────────────────────────
async function optimizeJob(env: Env): Promise<string> {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const since = sevenDaysAgo.toISOString().split('T')[0];

  // 최근 7일 평균 ROAS 계산
  const result = await env.DB.prepare(
    `SELECT c.id, c.meta_adset_id, c.daily_budget,
            AVG(m.roas) as avg_roas, SUM(m.spend) as total_spend,
            SUM(m.purchases) as total_purchases
     FROM campaigns c
     JOIN ad_metrics m ON c.id = m.campaign_id
     WHERE c.status = 'active' AND m.date >= ?
     GROUP BY c.id
     HAVING total_spend > 5000`
  ).bind(since).all();

  let boosted = 0;
  let stopped = 0;

  for (const row of result.results as any[]) {
    const avgRoas = row.avg_roas ?? 0;

    if (avgRoas >= 3.0) {
      // ROAS 300% 이상: 예산 50% 증액
      const newBudget = Math.min(row.daily_budget * 1.5, 50000); // 최대 5만원/일
      await updateAdSetBudget(env, row.meta_adset_id, newBudget);
      await env.DB.prepare(
        `UPDATE campaigns SET daily_budget = ?, updated_at = datetime('now') WHERE id = ?`
      ).bind(newBudget, row.id).run();
      boosted++;
    } else if (avgRoas < 1.0 && row.total_spend > 20000) {
      // ROAS 100% 미만 + 2만원 이상 지출: 광고 완전 중단
      await updateAdStatus(env, row.meta_adset_id, 'PAUSED');
      await env.DB.prepare(
        `UPDATE campaigns SET status = 'stopped', updated_at = datetime('now') WHERE id = ?`
      ).bind(row.id).run();
      stopped++;
    }
  }

  return `주간 최적화: ${boosted}개 예산 증액, ${stopped}개 광고 중단`;
}

// ─── 로깅 헬퍼 ───
async function startLog(env: Env, jobType: string): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO automation_logs (job_type, status) VALUES (?, 'running')`
  ).bind(jobType).run();
  return result.meta.last_row_id as number;
}

async function finishLog(
  env: Env,
  logId: number,
  status: 'success' | 'failed',
  message: string
): Promise<void> {
  await env.DB.prepare(
    `UPDATE automation_logs SET status = ?, message = ?, finished_at = datetime('now') WHERE id = ?`
  ).bind(status, message, logId).run();
}
