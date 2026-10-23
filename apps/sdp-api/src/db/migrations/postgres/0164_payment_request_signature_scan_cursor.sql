ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS signature_scan_cursor TEXT,
  ADD COLUMN IF NOT EXISTS signature_scan_before TEXT;
