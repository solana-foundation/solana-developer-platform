-- Validates the canceler CHECK 0186 added NOT VALID. No row before 0186 has canceled_at or a
-- canceler, so the scan finds nothing; VALIDATE does not block writes.
ALTER TABLE payment_requests VALIDATE CONSTRAINT payment_requests_canceled_by_principal_check;
