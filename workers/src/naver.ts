import { Env, TrendKeyword } from './types';

// 현재 키로 사용 가능한 API: datalab/search (검색어 트렌드)
// 카테고리별 대표 키워드를 직접 정의하고, 각 키워드의 트렌드 지수를 조회

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  '패션의류':    ['원피스', '반팔티', '청바지', '레깅스', '후드티', '니트', '슬랙스', '자켓'],
  '스포츠레저':  ['폼롤러', '요가매트', '덤벨', '헬스글러브', '런닝화', '자전거', '등산화', '수영복'],
  '화장품미용':  ['선크림', '쿠션팩트', '마스크팩', '립스틱', '세럼', '토너', '클렌징', '아이크림'],
  '생활건강':   ['공기청정기', '비타민', '프로바이오틱스', '마스크', '체온계', '혈압계', '안마기', '족욕기'],
  '출산육아':   ['기저귀', '분유', '유아식', '아기띠', '유모차', '딸랑이', '보행기', '아기매트'],
  '식품':       ['단백질쉐이크', '그래놀라', '오트밀', '견과류', '홍삼', '콜라겐', '다이어트식품', '건강즙'],
  '반려동물':   ['강아지간식', '고양이사료', '강아지옷', '고양이모래', '강아지하네스', '펫패드', '스크래쳐', '캣타워'],
};

// 검색어 트렌드 API로 키워드 그룹별 트렌드 지수 조회
async function getSearchTrend(
  env: Env,
  keywords: string[],
  categoryName: string
): Promise<{ keyword: string; avgRatio: number }[]> {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 30); // 최근 30일

  // API는 최대 5개 그룹 / 그룹당 최대 5개 키워드
  const groups = keywords.slice(0, 5).map(kw => ({
    groupName: kw,
    keywords: [kw],
  }));

  const body = {
    startDate: formatDate(startDate),
    endDate: formatDate(endDate),
    timeUnit: 'week',
    keywordGroups: groups,
  };

  try {
    const response = await fetch('https://openapi.naver.com/v1/datalab/search', {
      method: 'POST',
      headers: {
        'X-Naver-Client-Id': env.NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': env.NAVER_CLIENT_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      console.error(`datalab/search failed: ${response.status}`, await response.text());
      return [];
    }

    const data = await response.json() as any;
    const results: { keyword: string; avgRatio: number }[] = [];

    if (data.results) {
      for (const result of data.results) {
        const ratios = result.data?.map((d: any) => d.ratio as number) ?? [];
        const avg = ratios.length > 0
          ? ratios.reduce((a: number, b: number) => a + b, 0) / ratios.length
          : 0;
        // 최근 트렌드 가중치: 마지막 2주 평균이 전체 평균보다 높으면 상승세
        const recentRatios = ratios.slice(-2);
        const recentAvg = recentRatios.length > 0
          ? recentRatios.reduce((a: number, b: number) => a + b, 0) / recentRatios.length
          : 0;
        const trendBonus = recentAvg > avg ? (recentAvg - avg) * 0.3 : 0;

        results.push({
          keyword: result.title,
          avgRatio: avg + trendBonus,
        });
      }
    }

    return results;
  } catch (e) {
    console.error('datalab/search error:', e);
    return [];
  }
}

// 네이버 쇼핑 검색으로 경쟁 상품 수 추정
async function getCompetitionCount(env: Env, keyword: string): Promise<number> {
  try {
    const response = await fetch(
      `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(keyword)}&display=1`,
      {
        headers: {
          'X-Naver-Client-Id': env.NAVER_CLIENT_ID,
          'X-Naver-Client-Secret': env.NAVER_CLIENT_SECRET,
        },
      }
    );
    if (!response.ok) return 500; // API 미지원 시 중간값 반환
    const data = await response.json() as any;
    return data.total ?? 500;
  } catch {
    return 500;
  }
}

// 트렌드 점수 계산 (검색 트렌드 지수 기반)
function calculateTrendScore(avgRatio: number, competition: number): number {
  const trendScore = Math.min(avgRatio, 100) * 0.7;           // 트렌드 지수 (최대 70점)
  const compScore = Math.max(0, 1 - competition / 2000) * 30; // 경쟁도 역산 (최대 30점)
  return Math.round((trendScore + compScore) * 10) / 10;
}

// 메인 수집 함수
export async function collectTrendKeywords(env: Env): Promise<TrendKeyword[]> {
  const allKeywords: TrendKeyword[] = [];

  for (const [categoryName, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    try {
      // 5개씩 나눠서 요청 (API 제한)
      const chunks = chunkArray(keywords, 5);
      for (const chunk of chunks) {
        const trends = await getSearchTrend(env, chunk, categoryName);

        for (const { keyword, avgRatio } of trends) {
          const competition = await getCompetitionCount(env, keyword);
          const trendScore = calculateTrendScore(avgRatio, competition);

          allKeywords.push({
            keyword,
            category: categoryName,
            search_volume: Math.round(avgRatio * 1000), // 트렌드 지수를 검색량 추정치로 변환
            competition_count: competition,
            trend_score: trendScore,
          });
        }

        await sleep(200); // API 레이트 리밋 방지
      }
    } catch (e) {
      console.error(`Category ${categoryName} failed:`, e);
    }
  }

  // 트렌드 점수 높은 순 정렬 → 상위 50개
  return allKeywords
    .sort((a, b) => (b.trend_score ?? 0) - (a.trend_score ?? 0))
    .slice(0, 50);
}

// DB에 저장 (중복 키워드는 업데이트)
export async function saveTrendKeywords(env: Env, keywords: TrendKeyword[]): Promise<void> {
  for (const kw of keywords) {
    // 이미 오늘 수집된 키워드면 업데이트
    const existing = await env.DB.prepare(
      `SELECT id FROM trend_keywords WHERE keyword = ? AND date(collected_at) = date('now')`
    ).bind(kw.keyword).first();

    if (existing) {
      await env.DB.prepare(
        `UPDATE trend_keywords
         SET search_volume = ?, competition_count = ?, trend_score = ?, collected_at = datetime('now')
         WHERE id = ?`
      ).bind(kw.search_volume ?? 0, kw.competition_count ?? 0, kw.trend_score ?? 0, (existing as any).id).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO trend_keywords (keyword, category, search_volume, competition_count, trend_score)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(kw.keyword, kw.category ?? '', kw.search_volume ?? 0, kw.competition_count ?? 0, kw.trend_score ?? 0).run();
    }
  }
}

// 유틸
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
