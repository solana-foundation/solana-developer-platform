-- Server-owned accounting is fenced to one payer/message window. NULL keeps
-- preceding claim writers compatible; retained reservations are never rewritten.
ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS sponsored_tx_continuity JSONB;
