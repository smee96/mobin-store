import { Env, TrendKeyword } from './types';

// 카테고리별 트렌드 키워드 수집
export async function collectTrendKeywords(env: Env): Promise<TrendKeyword[]> {
  const categories = [
    { name: '패션의류', id: '50000000' },
    { name: '스포츠레저', id: '50000075' },
    { name: '화장품미용', id: '50000006' },
    { name: '생활건강', id: '50000005' },
    { name: '출산육아', id: '50000007' },
    { name: '식품', id: '50000004' },
    { name: '반려동물', id: '50000047' },
  ];

  const allKeywords: TrendKeyword[] = [];

  for (const category of categories) {
    try {
      const keywords = await getNaverShoppingTrend(env, category.name, category.id);
      allKeywords.push(...keywords);
      await sleep(300); // API 레이트 리밋 방지
    } catch (e) {
      console.error(`Category ${category.name} failed:`, e);
    }
  }

  // 점수 계산 및 필터링 (검색량 높고 경쟁 낮은 순)
  const scored = allKeywords
    .filter(k => (k.search_volume ?? 0) >= 2000)
    .map(k => ({
      ...k,
      trend_score: calculateTrendScore(k),
    }))
    .sort((a, b) => (b.trend_score ?? 0) - (a.trend_score ?? 0))
    .slice(0, 50); // 상위 50개만

  return scored;
}

async function getNaverShoppingTrend(
  env: Env,
  categoryName: string,
  categoryId: string
): Promise<TrendKeyword[]> {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 7); // 최근 7일

  const body = {
    startDate: formatDate(startDate),
    endDate: formatDate(endDate),
    timeUnit: 'date',
    category: categoryId,
    keyword: [],
    device: '',
    gender: '',
    ages: [],
  };

  const response = await fetch(
    'https://openapi.naver.com/v1/datalab/shopping/category/keywords/ratio',
    {
      method: 'POST',
      headers: {
        'X-Naver-Client-Id': env.NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': env.NAVER_CLIENT_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    // 데이터랩 API가 실패하면 키워드 검색 API로 폴백
    return await getNaverKeywordStats(env, categoryName);
  }

  const data = await response.json() as any;
  const keywords: TrendKeyword[] = [];

  if (data.results) {
    for (const result of data.results) {
      const keyword = result.title;
      const stats = await getNaverKeywordStats(env, keyword);
      if (stats.length > 0) {
        keywords.push({
          keyword,
          category: categoryName,
          search_volume: stats[0].search_volume,
          competition_count: stats[0].competition_count,
        });
      }
    }
  }

  return keywords;
}

// 네이버 키워드 통계 API
async function getNaverKeywordStats(env: Env, keyword: string): Promise<TrendKeyword[]> {
  const response = await fetch(
    `https://api.naver.com/keywordstool?hintKeywords=${encodeURIComponent(keyword)}&showDetail=1`,
    {
      headers: {
        'X-Naver-Client-Id': env.NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': env.NAVER_CLIENT_SECRET,
      },
    }
  );

  if (!response.ok) return [];

  const data = await response.json() as any;
  const keywords: TrendKeyword[] = [];

  if (data.keywordList) {
    for (const item of data.keywordList.slice(0, 5)) {
      const monthlyPc = parseInt(item.monthlyPcQcCnt?.replace(/[^0-9]/g, '') || '0');
      const monthlyMobile = parseInt(item.monthlyMobileQcCnt?.replace(/[^0-9]/g, '') || '0');
      const totalSearchVolume = monthlyPc + monthlyMobile;
      const competition = parseCompetitionLevel(item.compIdx);

      if (totalSearchVolume >= 1000) {
        keywords.push({
          keyword: item.relKeyword,
          search_volume: totalSearchVolume,
          competition_count: competition,
        });
      }
    }
  }

  return keywords;
}

// 트렌드 점수 계산
// 검색량이 높고, 경쟁이 낮을수록 점수 높음
function calculateTrendScore(keyword: TrendKeyword): number {
  const searchScore = Math.min((keyword.search_volume ?? 0) / 10000, 1) * 60;
  const competitionScore = Math.max(0, 1 - (keyword.competition_count ?? 500) / 1000) * 40;
  return searchScore + competitionScore;
}

function parseCompetitionLevel(level: string): number {
  const map: Record<string, number> = {
    '낮음': 100,
    '중간': 500,
    '높음': 1000,
  };
  return map[level] ?? 500;
}

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// DB에 저장
export async function saveTrendKeywords(
  env: Env,
  keywords: TrendKeyword[]
): Promise<void> {
  for (const kw of keywords) {
    await env.DB.prepare(
      `INSERT INTO trend_keywords (keyword, category, search_volume, competition_count, trend_score)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(
        kw.keyword,
        kw.category ?? '',
        kw.search_volume ?? 0,
        kw.competition_count ?? 0,
        kw.trend_score ?? 0
      )
      .run();
  }
}
