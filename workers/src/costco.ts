export interface CostcoProduct {
  id: string;
  name: string;
  price: string;
  priceNum: number;
  originalPrice: string;
  discount: string;
  discountAmount: string;
  period: string;
  url: string;
  imageUrl: string;
  unit: string;
  maxPurchase: string;
  isSoldOut: boolean;
  isMemberOnly: boolean;
}

export async function crawlCostcoDeals(page: number = 0, pageSize: number = 20): Promise<{
  products: CostcoProduct[];
  total: number;
  hasMore: boolean;
}> {
  const res = await fetch('https://www.costco.co.kr/Special-Price-Offers/c/SpecialPriceOffers', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
  });

  if (!res.ok) throw new Error(`페이지 로드 실패: ${res.status}`);
  const html = await res.text();

  const products = parseAllProducts(html);
  const start = page * pageSize;
  const sliced = products.slice(start, start + pageSize);

  return {
    products: sliced,
    total: products.length,
    hasMore: start + pageSize < products.length,
  };
}

function parseAllProducts(html: string): CostcoProduct[] {
  /**
   * 실제 HTML 구조 (위치 순서):
   *   1) href="/...../p/{code}" (URL, 3번 반복)
   *   2) alt="{상품명}"          (이름, URL 직후)
   *   3) checkbox-compare-{code} (체크박스, 이름 뒤)
   *   4) 가격, 단위, 기간 등      (체크박스 뒤)
   *
   * → URL + alt가 쌍으로 나타나는 패턴을 직접 추출
   */

  const products: CostcoProduct[] = [];
  const seen = new Set<string>();

  // URL 첫 등장 위치 목록 (각 상품마다 3번 반복되므로 첫 번째만 사용)
  const urlReg = /href="(\/[^"]+\/p\/(\d+))"/g;
  const urlMatches: Array<{ pos: number; url: string; code: string }> = [];

  let m: RegExpExecArray | null;
  while ((m = urlReg.exec(html)) !== null) {
    const code = m[2];
    if (!seen.has(code)) {
      seen.add(code);
      urlMatches.push({ pos: m.index, url: m[1], code });
    }
  }

  for (let i = 0; i < urlMatches.length; i++) {
    const { pos, url, code } = urlMatches[i];
    const nextPos = i + 1 < urlMatches.length ? urlMatches[i + 1].pos : pos + 15000;

    // 이 상품의 블록: 첫 URL 등장 ~ 다음 상품 첫 URL 등장
    const block = html.slice(pos, nextPos);

    try {
      const product = parseProductBlock(code, url, block, html, pos);
      if (product?.name) products.push(product);
    } catch (_) {
      // skip
    }
  }

  return products;
}

function parseProductBlock(
  code: string,
  relUrl: string,
  block: string,
  fullHtml: string,
  blockStart: number
): CostcoProduct | null {

  // ── 상품명: URL 직후 alt 속성 ──
  const altMatch = block.match(/alt="([^"&]{5,120})"/);
  const name = altMatch ? decodeHtml(altMatch[1]) : '';
  if (!name || name === '&quot;&quot;') return null;

  // ── 이미지: contentstack CDN 우선, 없으면 일반 이미지 ──
  const imgMatch = block.match(/src="(https:\/\/(?:azure-na-images|images)\.contentstack[^"]+)"/i)
    ?? block.match(/src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
  const imageUrl = imgMatch?.[1] ?? '';

  // ── 가격 파싱 ──
  // 코스트코 HTML 구조 (목록 페이지 SSR 기준):
  //   class="original-price"  → 판매금액 (notranslate span)
  //   class="price-original"  → 판매금액 (상세 페이지용, price-tag + notranslate)
  //   class="discount"        → 할인 블록 (discount-tag, discount-value - JS 동적 렌더)
  //   class="price-after-discount" → 총 결제금액 (you-pay-value - JS 동적 렌더)
  //
  // 주의: 할인금액/총결제금액은 로그인 후 클라이언트JS가 동적으로 렌더링.
  // SSR HTML에서는 original-price(판매금액)만 추출 가능.

  // 1) original-price 클래스에서 판매금액 추출
  const origPriceMatch = block.match(
    /class="original-price[^"]*"[^>]*>.*?class="(?:product-price-amount|price-value)[^"]*"[^>]*>.*?class="notranslate[^"]*">\s*([\d,]+원)\s*</s
  ) ?? block.match(
    /class="original-price[^"]*"[^>]*>[\s\S]*?notranslate[^>]*>\s*([\d,]+원)\s*</
  );
  
  // 2) 폴백: price-original 클래스 (상세 페이지 호환)
  const priceOriginalMatch = !origPriceMatch ? block.match(
    /class="price-original[^"]*"[^>]*>[\s\S]*?notranslate[^>]*>\s*([\d,]+원)\s*</
  ) : null;

  // 3) 최종 폴백: notranslate 첫 번째 값
  const sellingPriceStr: string = origPriceMatch
    ? origPriceMatch[1].trim()
    : priceOriginalMatch
      ? priceOriginalMatch[1].trim()
      : (block.match(/notranslate[^>]+>\s*([\d,]+원)\s*</)?.[1]?.trim() ?? '');

  const sellingPriceNum = parseInt(sellingPriceStr.replace(/[^0-9]/g, '') || '0');

  // ── 할인 정보 (SSR에서는 대부분 비어있음, 향후 확장용) ──
  // price-tag "할인금액" 패턴
  const discTagMatch = block.match(/class="price-tag[^"]*">할인금액<\/span>[\s\S]*?notranslate[^>]*>\s*([\d,]+원)\s*</);
  // discount-value 패턴
  const discValueMatch = !discTagMatch
    ? block.match(/class="discount-value[^"]*"[^>]*>[\s\S]*?notranslate[^>]*>\s*([\d,]+원)\s*</)
    : null;
  // 음수(-) 가격 패턴 (할인금액 표시)
  const negPriceMatch = !discTagMatch && !discValueMatch
    ? block.match(/notranslate[^>]*>\s*-\s*([\d,]+원)\s*</)
    : null;

  const discountAmount = (discTagMatch?.[1] ?? discValueMatch?.[1] ?? negPriceMatch?.[1] ?? '').trim();
  const discountNum = parseInt(discountAmount.replace(/[^0-9]/g, '') || '0');

  // ── 총 결제금액 (you-pay-value 클래스, SSR 미지원으로 대부분 비어있음) ──
  const youPayMatch = block.match(/class="you-pay-value[^"]*"[^>]*>[\s\S]*?notranslate[^>]*>\s*([\d,]+원)\s*</);
  const finalPriceStr = youPayMatch?.[1]?.trim() ?? '';
  const finalPriceNum = parseInt(finalPriceStr.replace(/[^0-9]/g, '') || '0');

  // price / originalPrice / discount / discountAmount 최종 결정
  // 총결제금액(finalPriceNum)이 있으면 → price=총결제금액, originalPrice=판매금액
  // 할인금액(discountNum)만 있으면   → price=판매금액,    originalPrice=판매금액+할인금액
  // 아무것도 없으면                  → price=판매금액,    나머지 빈 문자열
  let price: string;
  let priceNum: number;
  let originalPrice: string;
  let discount: string;

  if (finalPriceNum > 0 && sellingPriceNum > 0 && finalPriceNum < sellingPriceNum) {
    price = finalPriceStr;
    priceNum = finalPriceNum;
    originalPrice = sellingPriceStr;
    const savedNum = sellingPriceNum - finalPriceNum;
    discount = Math.round((savedNum / sellingPriceNum) * 100) + '%';
  } else if (sellingPriceNum > 0 && discountNum > 0) {
    price = sellingPriceStr;
    priceNum = sellingPriceNum;
    originalPrice = (sellingPriceNum + discountNum).toLocaleString('ko-KR') + '원';
    discount = Math.round((discountNum / (sellingPriceNum + discountNum)) * 100) + '%';
  } else {
    price = sellingPriceStr;
    priceNum = sellingPriceNum;
    originalPrice = '';
    discount = '';
  }

  // ── 행사기간: YYYY/MM/DD 두 개 ──
  const dates = [...block.matchAll(/(\d{4}\/\d{2}\/\d{2})/g)].map(m => m[1]);
  const period = dates.length >= 2 ? `${dates[0]} - ${dates[1]}` : '';

  // ── 단위 정보 ──
  const unitMatch = block.match(/([\d,]+(?:㎖|g|미터|개|㎡|kg)당\s*[\d,]+원)/);
  const unit = unitMatch?.[1] ?? '';

  // ── 최대구매 ──
  const maxMatch = block.match(/최대구매\s*(\d+)/);
  const maxPurchase = maxMatch ? `최대 ${maxMatch[1]}개` : '';

  const isSoldOut = /품절/.test(block);
  const isMemberOnly = /회원\s*전용/.test(block);

  return {
    id: code,
    name,
    price,
    priceNum,
    originalPrice,
    discount,
    discountAmount,
    period,
    url: `https://www.costco.co.kr${relUrl}`,
    imageUrl,
    unit,
    maxPurchase,
    isSoldOut,
    isMemberOnly,
  };
}

function decodeHtml(str: string): string {
  return str
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
}
