-- Validates the canceled_by CHECK 0186 re-added NOT VALID. The old CHECK held canceled_by to
-- `canceled` rows, a subset of what the widened one allows, so the scan finds nothing; VALIDATE
-- does not block writes.
ALTER TABLE payment_requests VALIDATE CONSTRAINT payment_requests_canceled_by_only_when_canceled;
