-- The audit intent a transfer request opened before its send. A job that later
-- settles the row closes that intent in the same transaction as the settle.
-- Additive: the previous API revision can continue serving during migration.
ALTER TABLE payment_transfers ADD COLUMN IF NOT EXISTS audit_intent_id TEXT;
