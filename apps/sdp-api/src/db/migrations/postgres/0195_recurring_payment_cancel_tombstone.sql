-- A canceled recurring payment is a tombstone (HOO-2339): it never collects, resumes or changes
-- status again. Collection claims only `active` rows and resume only `paused` ones, so the
-- application never moves a row out of `canceled`; this trigger makes that hold for every writer,
-- including a generic status write or a revision that still resumed canceled schedules. A
-- refused write raises, so it rolls back with its transaction instead of reviving the schedule.
-- The trigger fires only when `status` is in the UPDATE's column list and the old row is
-- `canceled`, so it costs nothing on the collection path. Creating it takes a brief
-- SHARE ROW EXCLUSIVE lock and scans nothing.
CREATE OR REPLACE FUNCTION payment_recurring_payment_cancel_is_terminal() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Recovery tests rewind a landed cancel to model a crash mid-cancel. As with the audit
  -- ledger's TRUNCATE exception (0047), only the disposable databases automated tests own,
  -- named `test` or `*_test`, allow it, and only in a transaction that asks for it; this cannot
  -- match SDP's runtime databases.
  IF current_setting('sdp.test_rewind_canceled', true) = 'on'
     AND (current_database() = 'test' OR current_database() LIKE '%\_test' ESCAPE '\') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'recurring payment % is canceled and cannot change status', OLD.id
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE OR REPLACE TRIGGER payment_recurring_payment_cancel_is_terminal
BEFORE UPDATE OF status ON payment_recurring_payments
FOR EACH ROW
WHEN (OLD.status = 'canceled' AND NEW.status IS DISTINCT FROM 'canceled')
EXECUTE FUNCTION payment_recurring_payment_cancel_is_terminal();
