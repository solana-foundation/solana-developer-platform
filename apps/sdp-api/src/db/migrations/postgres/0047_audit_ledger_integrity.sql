-- SDP-022 / HOO-996: make the security audit ledger append-only and tamper-evident.
--
-- The hash chain provides deterministic integrity evidence. FORCE RLS and the
-- mutation trigger independently deny UPDATE/DELETE for ordinary runtime
-- connections. Production runtime identities must remain NOSUPERUSER and
-- NOBYPASSRLS; the verification command reports that posture.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- An immutable audit row must keep its historical tenant identifier even when
-- the tenant is removed. ON DELETE SET NULL would rewrite history.
ALTER TABLE audit_logs
  DROP CONSTRAINT IF EXISTS audit_logs_organization_id_fkey;

ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS ledger_sequence BIGINT,
  ADD COLUMN IF NOT EXISTS previous_entry_hash BYTEA,
  ADD COLUMN IF NOT EXISTS entry_hash BYTEA;

CREATE SEQUENCE IF NOT EXISTS audit_logs_ledger_sequence_seq;
ALTER SEQUENCE audit_logs_ledger_sequence_seq OWNED BY audit_logs.ledger_sequence;

CREATE OR REPLACE FUNCTION sdp_audit_log_hash(
  p_ledger_sequence BIGINT,
  p_id TEXT,
  p_organization_id TEXT,
  p_user_id TEXT,
  p_api_key_id TEXT,
  p_action TEXT,
  p_resource_type TEXT,
  p_resource_id TEXT,
  p_metadata TEXT,
  p_ip_address TEXT,
  p_user_agent TEXT,
  p_request_id TEXT,
  p_status TEXT,
  p_created_at TEXT,
  p_previous_entry_hash BYTEA
) RETURNS BYTEA
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT digest(
    convert_to(
      jsonb_build_array(
        p_ledger_sequence,
        p_id,
        p_organization_id,
        p_user_id,
        p_api_key_id,
        p_action,
        p_resource_type,
        p_resource_id,
        p_metadata,
        p_ip_address,
        p_user_agent,
        p_request_id,
        p_status,
        p_created_at,
        encode(p_previous_entry_hash, 'hex')
      )::TEXT,
      'UTF8'
    ),
    'sha256'
  );
$$;

-- Backfill existing history deterministically before write enforcement begins.
DO $$
DECLARE
  audit_row RECORD;
  next_sequence BIGINT := 0;
  previous_hash BYTEA := NULL;
  calculated_hash BYTEA;
BEGIN
  FOR audit_row IN
    SELECT * FROM audit_logs ORDER BY created_at ASC, id ASC
  LOOP
    next_sequence := next_sequence + 1;
    calculated_hash := sdp_audit_log_hash(
      next_sequence,
      audit_row.id,
      audit_row.organization_id,
      audit_row.user_id,
      audit_row.api_key_id,
      audit_row.action,
      audit_row.resource_type,
      audit_row.resource_id,
      audit_row.metadata,
      audit_row.ip_address,
      audit_row.user_agent,
      audit_row.request_id,
      audit_row.status,
      audit_row.created_at,
      previous_hash
    );

    UPDATE audit_logs
    SET ledger_sequence = next_sequence,
        previous_entry_hash = previous_hash,
        entry_hash = calculated_hash
    WHERE id = audit_row.id;

    previous_hash := calculated_hash;
  END LOOP;

  PERFORM setval(
    'audit_logs_ledger_sequence_seq',
    GREATEST(next_sequence, 1),
    next_sequence > 0
  );
END;
$$;

ALTER TABLE audit_logs
  ALTER COLUMN ledger_sequence SET NOT NULL,
  ALTER COLUMN entry_hash SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_ledger_sequence
  ON audit_logs(ledger_sequence);

CREATE OR REPLACE FUNCTION sdp_seal_audit_log_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Serialize before allocating the sequence so chain order is deterministic
  -- even when request and worker writers race.
  PERFORM pg_advisory_xact_lock(hashtext('sdp:audit-ledger'));

  NEW.ledger_sequence := nextval('audit_logs_ledger_sequence_seq');
  SELECT entry_hash
  INTO NEW.previous_entry_hash
  FROM audit_logs
  ORDER BY ledger_sequence DESC
  LIMIT 1;

  NEW.entry_hash := sdp_audit_log_hash(
    NEW.ledger_sequence,
    NEW.id,
    NEW.organization_id,
    NEW.user_id,
    NEW.api_key_id,
    NEW.action,
    NEW.resource_type,
    NEW.resource_id,
    NEW.metadata,
    NEW.ip_address,
    NEW.user_agent,
    NEW.request_id,
    NEW.status,
    NEW.created_at,
    NEW.previous_entry_hash
  );

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION sdp_reject_audit_log_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Automated tests own disposable databases named `test` or `*_test` and
  -- require TRUNCATE for isolation. This exception cannot match SDP's runtime
  -- databases and applies only to TRUNCATE, never row mutation.
  IF TG_OP = 'TRUNCATE'
     AND (current_database() = 'test' OR current_database() LIKE '%\_test' ESCAPE '\') THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION 'audit_logs is append-only; % is forbidden', TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_seal_insert ON audit_logs;
CREATE TRIGGER audit_logs_seal_insert
BEFORE INSERT ON audit_logs
FOR EACH ROW
EXECUTE FUNCTION sdp_seal_audit_log_insert();

DROP TRIGGER IF EXISTS audit_logs_reject_row_mutation ON audit_logs;
CREATE TRIGGER audit_logs_reject_row_mutation
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH STATEMENT
EXECUTE FUNCTION sdp_reject_audit_log_mutation();

DROP TRIGGER IF EXISTS audit_logs_reject_truncate ON audit_logs;
CREATE TRIGGER audit_logs_reject_truncate
BEFORE TRUNCATE ON audit_logs
FOR EACH STATEMENT
EXECUTE FUNCTION sdp_reject_audit_log_mutation();

-- Defense in depth: no UPDATE/DELETE policy exists. FORCE makes table owners
-- subject to RLS unless their role is SUPERUSER or BYPASSRLS.
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_logs_select ON audit_logs;
CREATE POLICY audit_logs_select ON audit_logs FOR SELECT USING (true);

DROP POLICY IF EXISTS audit_logs_insert ON audit_logs;
CREATE POLICY audit_logs_insert ON audit_logs FOR INSERT WITH CHECK (true);

CREATE OR REPLACE FUNCTION sdp_verify_audit_ledger()
RETURNS TABLE(
  valid BOOLEAN,
  checked_entries BIGINT,
  first_invalid_sequence BIGINT,
  head_hash BYTEA
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  audit_row RECORD;
  expected_previous BYTEA := NULL;
  expected_hash BYTEA;
  checked_count BIGINT := 0;
BEGIN
  FOR audit_row IN
    SELECT * FROM audit_logs ORDER BY ledger_sequence ASC
  LOOP
    expected_hash := sdp_audit_log_hash(
      audit_row.ledger_sequence,
      audit_row.id,
      audit_row.organization_id,
      audit_row.user_id,
      audit_row.api_key_id,
      audit_row.action,
      audit_row.resource_type,
      audit_row.resource_id,
      audit_row.metadata,
      audit_row.ip_address,
      audit_row.user_agent,
      audit_row.request_id,
      audit_row.status,
      audit_row.created_at,
      expected_previous
    );

    IF audit_row.previous_entry_hash IS DISTINCT FROM expected_previous
       OR audit_row.entry_hash IS DISTINCT FROM expected_hash THEN
      RETURN QUERY SELECT false, checked_count, audit_row.ledger_sequence, expected_previous;
      RETURN;
    END IF;

    checked_count := checked_count + 1;
    expected_previous := audit_row.entry_hash;
  END LOOP;

  RETURN QUERY SELECT true, checked_count, NULL::BIGINT, expected_previous;
END;
$$;
