ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS signature_scan_stuck_signature TEXT,
  ADD COLUMN IF NOT EXISTS signature_scan_stuck_since TEXT;
