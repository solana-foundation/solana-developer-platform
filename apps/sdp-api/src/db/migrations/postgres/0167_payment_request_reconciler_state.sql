ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS last_checked_at TEXT,
  ADD COLUMN IF NOT EXISTS last_verified_at TEXT,
  ADD COLUMN IF NOT EXISTS settlement_blocked_reason TEXT,
  ADD COLUMN IF NOT EXISTS paid_late BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT payment_requests_paid_late_only_when_paid
    CHECK (NOT paid_late OR status = 'paid');
