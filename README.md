# 🛍️ Movin Store Automation

스마트스토어 + 인스타그램 광고 자동화 시스템

## 아키텍처

```
Cloudflare Pages (대시보드 UI)
       ↕
Cloudflare Workers (API / 자동화 엔진)
       ↕
Cloudflare D1 (DB) + KV (캐시) + Cron Triggers (스케줄)
       ↕
외부 API: 네이버 데이터랩, Meta Ads, Claude AI, Remove.bg
```

## 폴더 구조

```
mobin-store/
├── workers/          # Cloudflare Workers (백엔드)
│   ├── src/
│   │   ├── index.ts          # 메인 라우터
│   │   ├── scheduler.ts      # Cron 자동화 엔진
│   │   ├── naver.ts          # 네이버 데이터랩 API
│   │   ├── meta.ts           # Meta Ads API
│   │   ├── ai.ts             # Claude AI 카피 생성
│   │   ├── image.ts          # 이미지 처리 (Remove.bg)
│   │   └── db.ts             # D1 데이터베이스
│   ├── wrangler.toml
│   └── package.json
├── pages/            # Cloudflare Pages (프론트엔드 대시보드)
│   ├── src/
│   │   └── index.html        # 대시보드 UI
│   └── package.json
└── README.md
```

## 빠른 시작

### 1. 사전 준비

```bash
# Cloudflare 계정 필요 (무료)
# https://dash.cloudflare.com

npm install -g wrangler
wrangler login
```

### 2. API 키 발급

| 서비스 | 발급 URL | 용도 |
|--------|----------|------|
| 네이버 개발자 | https://developers.naver.com | 트렌드 키워드 |
| Meta for Developers | https://developers.facebook.com | 인스타 광고 |
| Anthropic Claude | https://console.anthropic.com | AI 카피 생성 |
| Remove.bg | https://remove.bg/api | 배경 제거 |

### 3. Workers 배포

```bash
cd workers

# D1 데이터베이스 생성
wrangler d1 create mobin-store-db

# KV 네임스페이스 생성
wrangler kv:namespace create CACHE

# 위에서 나온 id를 wrangler.toml에 붙여넣기

# 환경변수 설정
wrangler secret put NAVER_CLIENT_ID
wrangler secret put NAVER_CLIENT_SECRET
wrangler secret put META_ACCESS_TOKEN
wrangler secret put META_AD_ACCOUNT_ID
wrangler secret put META_PAGE_ID
wrangler secret put CLAUDE_API_KEY
wrangler secret put REMOVEBG_API_KEY

# DB 스키마 적용
wrangler d1 execute mobin-store-db --file=./schema.sql

# 배포
npm run deploy
```

### 4. Pages 배포

```bash
cd pages
# GitHub에 push 후 Cloudflare Pages에서 연결
# Build command: (없음)
# Output directory: src
```

## 자동화 스케줄

| 작업 | 주기 | 설명 |
|------|------|------|
| 트렌드 수집 | 매일 오전 9시 | 네이버 데이터랩 키워드 수집 |
| 광고 소재 생성 | 매일 오전 10시 | AI로 카피 + 이미지 생성 |
| 광고 집행 | 매일 오전 11시 | Meta API로 광고 자동 생성 |
| 성과 수집 | 매일 오후 9시 | ROAS 체크 + 저예산 광고 중단 |
| 최적화 | 매주 월요일 | 성과 좋은 광고 예산 증액 |
