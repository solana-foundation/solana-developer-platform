-- Lifetime cap support for sponsored signatures built from the public
-- Solana Pay endpoint. Authoritative in Postgres deliberately: a Redis-side
-- counter would reset with the shared Memorystore and silently lift the cap.
ALTER TABLE payment_requests
  ADD COLUMN IF NOT EXISTS sponsored_signature_count integer NOT NULL DEFAULT 0;
