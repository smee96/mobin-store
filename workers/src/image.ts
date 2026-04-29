import { Env } from './types';

// Remove.bg로 상품 이미지 배경 제거
export async function removeBackground(
  env: Env,
  imageUrl: string
): Promise<string | null> {
  try {
    const response = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: {
        'X-Api-Key': env.REMOVEBG_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image_url: imageUrl,
        size: 'auto',
        format: 'png',
      }),
    });

    if (!response.ok) {
      console.error('Remove.bg failed:', response.status);
      return null;
    }

    // 이미지를 base64로 변환
    const buffer = await response.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    return `data:image/png;base64,${base64}`;
  } catch (e) {
    console.error('removeBackground error:', e);
    return null;
  }
}

// 스마트스토어 상품 이미지 URL 추출 (HTML 파싱)
export async function extractProductImage(
  productUrl: string
): Promise<string | null> {
  try {
    const response = await fetch(productUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MovinBot/1.0)',
      },
    });

    if (!response.ok) return null;

    const html = await response.text();

    // og:image 메타 태그에서 이미지 URL 추출
    const ogImageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/);
    if (ogImageMatch) return ogImageMatch[1];

    // JSON-LD에서 이미지 추출
    const jsonLdMatch = html.match(/"image"\s*:\s*"([^"]+)"/);
    if (jsonLdMatch) return jsonLdMatch[1];

    return null;
  } catch (e) {
    console.error('extractProductImage error:', e);
    return null;
  }
}

// Cloudflare Images에 이미지 업로드 (또는 외부 URL 반환)
export async function prepareAdImage(
  env: Env,
  productUrl: string
): Promise<string | null> {
  // 1. 상품 이미지 추출
  const imageUrl = await extractProductImage(productUrl);
  if (!imageUrl) return null;

  // 2. 배경 제거 (Remove.bg API 크레딧 절약을 위해 캐시 확인)
  const cacheKey = `img:${btoa(imageUrl).slice(0, 50)}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return cached;

  const processedImage = await removeBackground(env, imageUrl);
  if (!processedImage) return imageUrl; // 실패 시 원본 반환

  // 캐시 저장 (7일)
  await env.CACHE.put(cacheKey, processedImage, { expirationTtl: 60 * 60 * 24 * 7 });

  return processedImage;
}
