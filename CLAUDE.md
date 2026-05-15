# Mobin Store — AI Agent 작업 지침

## ⚠️ 배포 필수 규칙 (반드시 읽을 것)

### Cloudflare Pages 배포: Preview → Production 차이

Cloudflare Pages는 **브랜치 이름으로 환경이 결정**됩니다.

| 브랜치 | 환경 | 결과 |
|--------|------|------|
| `main` | **Production** ✅ | `https://mobin-store.pages.dev` (실제 서비스) |
| 기타 (`genspark_ai_developer` 등) | **Preview** ⚠️ | `https://xxxxx.mobin-store.pages.dev` (임시 URL) |

### ✅ 올바른 Pages 배포 순서 (항상 이 순서로)

```bash
# 1) 작업 브랜치(genspark_ai_developer)에서 개발 완료 후
git checkout main
git merge genspark_ai_developer --no-ff -m "feat: 변경 내용 요약"
git push origin main

# 2) Production으로 배포 (--branch main 필수!)
source /home/user/webapp/.env
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
wrangler pages deploy pages/src \
  --project-name mobin-store \
  --branch main \
  --commit-dirty=true
```

> ❌ `--branch main` 없이 배포하면 **무조건 Preview**로만 올라갑니다.

---

## 인증 정보

- **CLOUDFLARE_EMAIL**: `kyuhan.lee@mobin-inc.com`
- **CLOUDFLARE_API_TOKEN**: `/home/user/webapp/.env` 파일에 저장됨 (gitignore 처리)

### ✅ 인증 로드 방법 (항상 이렇게)

```bash
# .env 파일에서 토큰 로드 후 배포
source /home/user/webapp/.env
```

`.env` 파일 위치: `/home/user/webapp/.env`
```
CLOUDFLARE_API_TOKEN=cfut_xxx...
CLOUDFLARE_EMAIL=kyuhan.lee@mobin-inc.com
```

### Worker 배포

```bash
source /home/user/webapp/.env
cd /home/user/webapp/workers && \
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
wrangler deploy
```

### Pages 배포 (Production)

```bash
# 반드시 --branch main 포함!
source /home/user/webapp/.env
cd /home/user/webapp && \
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
wrangler pages deploy pages/src \
  --project-name mobin-store \
  --branch main \
  --commit-dirty=true
```

---

## 프로젝트 URLs

| 서비스 | URL |
|--------|-----|
| Pages (Production) | https://mobin-store.pages.dev |
| Worker API | https://mobin-store-worker.kyuhan-lee.workers.dev |
| GitHub | https://github.com/smee96/mobin-store |
| Cloudflare Dashboard | https://dash.cloudflare.com/bbff6e9bc7c37ea1aa3b7a1de23895a9 |

---

## 아키텍처

```
Cloudflare Pages  (pages/src/index.html)   — 대시보드 UI
       ↕
Cloudflare Workers (workers/src/index.ts)  — API 백엔드
       ↕
D1 (mobin-store-db)  +  KV (CACHE)  +  Cron Triggers
       ↕
네이버 데이터랩 / Meta Ads / Claude AI / Remove.bg
```

## 주요 API 엔드포인트

| 엔드포인트 | 설명 |
|-----------|------|
| `GET /api/costco?page=0&size=20` | 코스트코 특가 크롤링 (KV 10분 캐시) |
| `GET /api/price-compare?name=상품명` | 쿠팡+네이버 가격 비교 (KV 30분 캐시) |
| `GET /api/trends` | 트렌드 키워드 (D1) |
| `GET /api/dashboard` | 대시보드 통계 |
| `POST /api/run/:job` | Cron job 수동 실행 |

## Worker Secrets (등록 완료)

- `NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET` — 네이버 데이터랩
- `COUPANG_ACCESS_KEY` / `COUPANG_SECRET_KEY` — 쿠팡 파트너스
- `META_ACCESS_TOKEN` / `META_AD_ACCOUNT_ID` / `META_PAGE_ID`
- `CLAUDE_API_KEY` — Anthropic
- `REMOVEBG_API_KEY` — Remove.bg
- `RAPIDAPI_KEY` — RapidAPI (AliExpress)

## D1 / KV 바인딩

```toml
# wrangler.toml
[[d1_databases]]
binding = "DB"
database_name = "mobin-store-db"
database_id = "e708f31d-22fe-4cab-b4a4-10b4206684d1"

[[kv_namespaces]]
binding = "CACHE"
id = "2129eb33c0d342d481c8aedc09024a41"
```
