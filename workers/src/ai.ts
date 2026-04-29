import { Env, AdCreative, Product } from './types';

// Claude API로 광고 카피 자동 생성
export async function generateAdCopy(
  env: Env,
  product: Product
): Promise<Omit<AdCreative, 'product_id' | 'image_url'>> {
  const prompt = `당신은 한국 인스타그램 광고 카피라이터 전문가입니다.
아래 상품에 대해 인스타그램 광고 카피를 작성해주세요.

상품명: ${product.name}
키워드: ${product.keyword}
가격: ${product.price ? `${product.price.toLocaleString()}원` : '미정'}
스마트스토어 URL: ${product.smart_store_url || ''}

다음 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{
  "headline": "15자 이내 강렬한 헤드라인",
  "body_text": "50-80자 사이 본문 (가치 제안 + 긴급성)",
  "cta": "클릭 유도 문구 (10자 이내)",
  "hashtags": ["해시태그1", "해시태그2", "해시태그3", "해시태그4", "해시태그5"],
  "image_prompt": "Canva나 AI 이미지 생성용 영문 프롬프트 (상품 이미지 설명)"
}

규칙:
- 한국어 감성에 맞는 자연스러운 표현
- 과장 광고 금지, 진실된 가치 전달
- 해시태그는 검색량 높은 것 위주
- 이모지 1-2개 적절히 활용`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Claude API error: ${response.status}`);
  }

  const data = await response.json() as any;
  const text = data.content[0].text;

  try {
    const parsed = JSON.parse(text);
    return {
      headline: parsed.headline,
      body_text: parsed.body_text,
      cta: parsed.cta || '지금 구매하기',
      hashtags: parsed.hashtags || [],
      image_prompt: parsed.image_prompt,
      status: 'draft',
    };
  } catch {
    // JSON 파싱 실패 시 기본값
    return {
      headline: `✨ ${product.name}`,
      body_text: `지금 스마트스토어에서 특가로 만나보세요! 한정 수량으로 서두르세요.`,
      cta: '지금 구매하기',
      hashtags: [product.keyword, '특가', '쇼핑', '스마트스토어', '추천'],
      image_prompt: `product photo of ${product.name}, clean white background, professional e-commerce`,
      status: 'draft',
    };
  }
}

// 여러 상품에 대한 카피 일괄 생성
export async function generateCopiesForNewProducts(env: Env): Promise<number> {
  // 카피가 없는 활성 상품 조회
  const result = await env.DB.prepare(
    `SELECT p.* FROM products p
     LEFT JOIN ad_creatives ac ON p.id = ac.product_id
     WHERE p.status = 'active' AND ac.id IS NULL
     LIMIT 5`
  ).all();

  const products = result.results as unknown as Product[];
  let count = 0;

  for (const product of products) {
    try {
      const copy = await generateAdCopy(env, product);

      await env.DB.prepare(
        `INSERT INTO ad_creatives (product_id, headline, body_text, cta, hashtags, image_prompt, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          product.id!,
          copy.headline,
          copy.body_text,
          copy.cta,
          JSON.stringify(copy.hashtags),
          copy.image_prompt || '',
          'approved' // 자동 승인 (검토가 필요하면 'draft'로 변경)
        )
        .run();

      count++;
    } catch (e) {
      console.error(`Copy gen failed for product ${product.id}:`, e);
    }
  }

  return count;
}
