-- Validates the paused-reason CHECKs 0184 added NOT VALID. No row is `paused` (nothing wrote that
-- status before 0184) and every `paused_reason` is NULL, so the scan finds nothing; VALIDATE does
-- not block writes.
ALTER TABLE payment_recurring_payments
    VALIDATE CONSTRAINT payment_recurring_payments_paused_reason_check;
ALTER TABLE payment_recurring_payments
    VALIDATE CONSTRAINT payment_recurring_payments_paused_reason_status_check;
