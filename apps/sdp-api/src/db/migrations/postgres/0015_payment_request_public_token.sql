-- Wise-style public share token for payment request links: /pay/r/<public_token>.
-- An unguessable bearer credential (nanoid). Possession = authorization — the
-- random token is itself the secret, so the link needs no signing. Decoupled
-- from the internal `id` so a leaked link can be revoked by rotating the token
-- without changing the request's identity.

ALTER TABLE payment_requests ADD COLUMN public_token TEXT;

UPDATE payment_requests
SET public_token = substr(md5(random()::text || id), 1, 16)
WHERE public_token IS NULL;

ALTER TABLE payment_requests ALTER COLUMN public_token SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_requests_public_token
    ON payment_requests(public_token);
