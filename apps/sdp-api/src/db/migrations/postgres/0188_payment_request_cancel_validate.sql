-- Validates the CHECKs 0186 added NOT VALID. No image before 0186 writes `canceled`,
-- canceled_by, or canceled_at, so the scan finds nothing; VALIDATE does not block writes.
ALTER TABLE payment_requests VALIDATE CONSTRAINT payment_requests_canceled_by_only_when_canceled;
ALTER TABLE payment_requests VALIDATE CONSTRAINT payment_requests_cancel_shape;
