-- 상품 테이블
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  keyword TEXT NOT NULL,
  smart_store_url TEXT,
  price INTEGER,
  margin_rate REAL,
  monthly_search_volume INTEGER,
  competition_count INTEGER,
  score REAL,               -- 자동 산출 점수
  status TEXT DEFAULT 'discovered', -- discovered | active | paused | stopped
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 광고 소재 테이블
CREATE TABLE IF NOT EXISTS ad_creatives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER REFERENCES products(id),
  headline TEXT NOT NULL,
  body_text TEXT NOT NULL,
  cta TEXT DEFAULT '지금 구매하기',
  hashtags TEXT,            -- JSON 배열
  image_url TEXT,
  image_prompt TEXT,
  status TEXT DEFAULT 'draft', -- draft | approved | rejected
  created_at TEXT DEFAULT (datetime('now'))
);

-- 광고 캠페인 테이블
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER REFERENCES products(id),
  creative_id INTEGER REFERENCES ad_creatives(id),
  meta_campaign_id TEXT,
  meta_adset_id TEXT,
  meta_ad_id TEXT,
  status TEXT DEFAULT 'pending', -- pending | active | paused | stopped
  daily_budget INTEGER DEFAULT 5000,
  targeting TEXT,           -- JSON (연령, 성별, 관심사)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 광고 성과 테이블
CREATE TABLE IF NOT EXISTS ad_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER REFERENCES campaigns(id),
  date TEXT NOT NULL,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  spend INTEGER DEFAULT 0,  -- 원 단위
  purchases INTEGER DEFAULT 0,
  revenue INTEGER DEFAULT 0,
  ctr REAL,
  cpc REAL,
  roas REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 트렌드 키워드 테이블
CREATE TABLE IF NOT EXISTS trend_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  category TEXT,
  search_volume INTEGER,
  competition_count INTEGER,
  trend_score REAL,
  collected_at TEXT DEFAULT (datetime('now')),
  processed INTEGER DEFAULT 0  -- 0: 미처리, 1: 상품 등록됨
);

-- 자동화 로그 테이블
CREATE TABLE IF NOT EXISTS automation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL,   -- trend_collect | creative_gen | ad_launch | metrics_collect | optimize
  status TEXT NOT NULL,     -- running | success | failed
  message TEXT,
  details TEXT,             -- JSON
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_metrics_date ON ad_metrics(date);
CREATE INDEX IF NOT EXISTS idx_trends_processed ON trend_keywords(processed);
