-- A scan can resume beyond an unreadable signature without advancing its safe cursor.
ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS signature_scan_progress TEXT,
  ADD COLUMN IF NOT EXISTS signature_scan_cycle_had_retry BOOLEAN NOT NULL DEFAULT FALSE;
