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

  // ── 가격: notranslate span 내부 ──
  const priceMatches = [...block.matchAll(/notranslate[^>]+>\s*([\d,]+원)\s*</g)];
  const price = priceMatches.length > 0 ? priceMatches[0][1].trim() : '';
  const priceNum = parseInt(price.replace(/[^0-9]/g, '') || '0');

  // ── 할인금액: 가격 두 번째 등장 시 원가로 추정 (코스트코는 할인 후 가격이 먼저) ──
  // 코스트코 특가 구조: [현재가] [단위가] → 할인금액은 별도 텍스트 없이 원가에서 역산
  // price-per-unit 이후 나오는 별도 가격이 원가인 경우도 있음
  const allPrices = [...block.matchAll(/notranslate[^>]+>\s*([\d,]+원)\s*</g)].map(m => m[1].trim());
  
  // 할인금액 텍스트 직접 탐색
  const discAmtMatch = block.match(/(?:할인금액|discount-amount)[^>]*>\s*([\d,]+원)/i)
    ?? block.match(/was-price[^>]*>\s*([\d,]+원)/i);
  const discountAmount = discAmtMatch?.[1] ?? '';
  const discountNum = parseInt(discountAmount.replace(/[^0-9]/g, '') || '0');

  let originalPrice = '';
  let discount = '';
  if (priceNum > 0 && discountNum > 0) {
    originalPrice = (priceNum + discountNum).toLocaleString('ko-KR') + '원';
    discount = Math.round((discountNum / (priceNum + discountNum)) * 100) + '%';
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
