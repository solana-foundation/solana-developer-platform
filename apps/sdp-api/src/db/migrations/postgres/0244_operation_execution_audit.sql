-- Link each explicit operation action to its durable audit admission. The
-- acceptance intent and execution request commit together before worker effects.
ALTER TABLE operation_attempts ADD COLUMN audit_intent_id TEXT;

CREATE FUNCTION sdp_operation_attempt_audit_intent() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.audit_intent_id IS NOT NULL AND
       NEW.audit_intent_id IS DISTINCT FROM OLD.audit_intent_id THEN
        RAISE EXCEPTION 'Operation audit admission is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER operation_attempts_audit_intent BEFORE UPDATE ON operation_attempts
    FOR EACH ROW EXECUTE FUNCTION sdp_operation_attempt_audit_intent();
