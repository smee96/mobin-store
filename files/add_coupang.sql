-- 쿠팡 관련 컬럼 추가
ALTER TABLE products ADD COLUMN coupang_product_id INTEGER;
ALTER TABLE products ADD COLUMN coupang_vendor_item_id INTEGER;
ALTER TABLE products ADD COLUMN coupang_url TEXT;
ALTER TABLE products ADD COLUMN source_url TEXT;
ALTER TABLE products ADD COLUMN source_image TEXT;
