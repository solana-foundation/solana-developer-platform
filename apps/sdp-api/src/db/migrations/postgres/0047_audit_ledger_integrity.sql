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

-- Keep a separately protected terminal record for every sealed ledger entry.
-- The audit hash chain alone can prove that retained rows were not edited, but
-- it cannot distinguish a valid prefix from a ledger whose newest rows were
-- deleted. These append-only anchors make a missing suffix (or an empty ledger)
-- observable without trusting the mutable audit_logs table as its own head.
CREATE TABLE IF NOT EXISTS audit_ledger_anchors (
  ledger_sequence BIGINT PRIMARY KEY,
  entry_hash BYTEA NOT NULL,
  anchored_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO audit_ledger_anchors (ledger_sequence, entry_hash)
SELECT ledger_sequence, entry_hash
FROM audit_logs
ON CONFLICT (ledger_sequence) DO NOTHING;

CREATE OR REPLACE FUNCTION sdp_seal_audit_log_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  anchored_sequence BIGINT;
  anchored_hash BYTEA;
  ledger_sequence BIGINT;
  ledger_hash BYTEA;
BEGIN
  -- Serialize before allocating the sequence so chain order is deterministic
  -- even when request and worker writers race.
  PERFORM pg_advisory_xact_lock(hashtext('sdp:audit-ledger'));

  -- Derive the next sequence from the independently anchored head instead of
  -- nextval(). PostgreSQL sequences are not transactional, so nextval() would
  -- leave a permanent gap after a rolled-back audit insert.
  SELECT max(a.ledger_sequence),
         (array_agg(a.entry_hash ORDER BY a.ledger_sequence DESC))[1]
  INTO anchored_sequence, anchored_hash
  FROM audit_ledger_anchors a;

  SELECT a.ledger_sequence, a.entry_hash
  INTO ledger_sequence, ledger_hash
  FROM audit_logs a
  ORDER BY a.ledger_sequence DESC
  LIMIT 1;

  IF ledger_sequence IS DISTINCT FROM anchored_sequence
     OR ledger_hash IS DISTINCT FROM anchored_hash THEN
    RAISE EXCEPTION 'audit ledger head diverges from its append-only anchor'
      USING ERRCODE = '55000';
  END IF;

  NEW.ledger_sequence := COALESCE(anchored_sequence, 0) + 1;
  NEW.previous_entry_hash := anchored_hash;

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

CREATE OR REPLACE FUNCTION sdp_anchor_audit_log_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO audit_ledger_anchors (ledger_sequence, entry_hash)
  VALUES (NEW.ledger_sequence, NEW.entry_hash);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION sdp_reject_direct_audit_anchor_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- A legitimate anchor is written only by audit_logs_anchor_insert. Inside
  -- this BEFORE trigger that produces a nesting depth of two; a runtime caller
  -- inserting directly reaches only depth one. The matching sealed row check
  -- also prevents an unrelated trigger from manufacturing a ledger head.
  IF pg_trigger_depth() < 2 OR NOT EXISTS (
    SELECT 1
    FROM audit_logs
    WHERE audit_logs.ledger_sequence = NEW.ledger_sequence
      AND audit_logs.entry_hash = NEW.entry_hash
  ) THEN
    RAISE EXCEPTION 'audit ledger anchors may only be created from sealed audit rows'
      USING ERRCODE = '42501';
  END IF;

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

  RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_seal_insert ON audit_logs;
CREATE TRIGGER audit_logs_seal_insert
BEFORE INSERT ON audit_logs
FOR EACH ROW
EXECUTE FUNCTION sdp_seal_audit_log_insert();

DROP TRIGGER IF EXISTS audit_logs_anchor_insert ON audit_logs;
CREATE TRIGGER audit_logs_anchor_insert
AFTER INSERT ON audit_logs
FOR EACH ROW
EXECUTE FUNCTION sdp_anchor_audit_log_insert();

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

DROP TRIGGER IF EXISTS audit_ledger_anchors_reject_row_mutation ON audit_ledger_anchors;
CREATE TRIGGER audit_ledger_anchors_reject_row_mutation
BEFORE UPDATE OR DELETE ON audit_ledger_anchors
FOR EACH STATEMENT
EXECUTE FUNCTION sdp_reject_audit_log_mutation();

DROP TRIGGER IF EXISTS audit_ledger_anchors_reject_direct_insert ON audit_ledger_anchors;
CREATE TRIGGER audit_ledger_anchors_reject_direct_insert
BEFORE INSERT ON audit_ledger_anchors
FOR EACH ROW
EXECUTE FUNCTION sdp_reject_direct_audit_anchor_insert();

DROP TRIGGER IF EXISTS audit_ledger_anchors_reject_truncate ON audit_ledger_anchors;
CREATE TRIGGER audit_ledger_anchors_reject_truncate
BEFORE TRUNCATE ON audit_ledger_anchors
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

ALTER TABLE audit_ledger_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_ledger_anchors FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_ledger_anchors_select ON audit_ledger_anchors;
CREATE POLICY audit_ledger_anchors_select ON audit_ledger_anchors FOR SELECT USING (true);

DROP POLICY IF EXISTS audit_ledger_anchors_insert ON audit_ledger_anchors;
CREATE POLICY audit_ledger_anchors_insert
  ON audit_ledger_anchors FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1
      FROM audit_logs
      WHERE audit_logs.ledger_sequence = audit_ledger_anchors.ledger_sequence
        AND audit_logs.entry_hash = audit_ledger_anchors.entry_hash
    )
  );

-- Verification deliberately requires the independently stored Redis head.
-- PostgreSQL must never be able to certify a shortened prefix using only data
-- from its own privilege boundary.
CREATE OR REPLACE FUNCTION sdp_verify_audit_ledger(
  p_external_sequence BIGINT,
  p_external_head_hash TEXT
)
RETURNS TABLE(
  valid BOOLEAN,
  checked_entries BIGINT,
  first_invalid_sequence BIGINT,
  head_hash BYTEA,
  unresolved_critical_intents BIGINT
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  audit_row RECORD;
  anchor_row RECORD;
  expected_previous BYTEA := NULL;
  expected_hash BYTEA;
  checked_count BIGINT := 0;
  anchored_count BIGINT := 0;
  anchored_last_sequence BIGINT := NULL;
  anchored_head BYTEA := NULL;
  unresolved_count BIGINT := 0;
  first_unresolved_sequence BIGINT := NULL;
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
      RETURN QUERY SELECT false, checked_count, audit_row.ledger_sequence, expected_previous, 0::BIGINT;
      RETURN;
    END IF;

    SELECT ledger_sequence, entry_hash
    INTO anchor_row
    FROM audit_ledger_anchors
    WHERE ledger_sequence = audit_row.ledger_sequence;

    IF NOT FOUND OR anchor_row.entry_hash IS DISTINCT FROM audit_row.entry_hash THEN
      RETURN QUERY SELECT false, checked_count, audit_row.ledger_sequence, expected_previous, 0::BIGINT;
      RETURN;
    END IF;

    checked_count := checked_count + 1;
    expected_previous := audit_row.entry_hash;
  END LOOP;

  -- Detect a valid remaining prefix, complete audit_logs truncation, or extra
  -- forged anchors. The anchor set is append-only under a separately enforced
  -- trigger/RLS boundary, so its count and terminal hash are the expected head.
  SELECT count(*)::BIGINT, max(ledger_sequence),
         (array_agg(entry_hash ORDER BY ledger_sequence DESC))[1]
  INTO anchored_count, anchored_last_sequence, anchored_head
  FROM audit_ledger_anchors;

  IF anchored_count IS DISTINCT FROM checked_count
     OR anchored_last_sequence IS DISTINCT FROM
        (CASE WHEN checked_count = 0 THEN NULL ELSE checked_count END)
     OR anchored_head IS DISTINCT FROM expected_previous THEN
    RETURN QUERY SELECT false, checked_count, checked_count + 1, expected_previous, 0::BIGINT;
    RETURN;
  END IF;

  IF p_external_sequence IS DISTINCT FROM checked_count
     OR p_external_head_hash IS DISTINCT FROM encode(expected_previous, 'hex') THEN
    RETURN QUERY SELECT false, checked_count, checked_count + 1, expected_previous, 0::BIGINT;
    RETURN;
  END IF;

  -- A critical intent is written before its irreversible side effect. Its
  -- matching outcome is normally appended in the same request. An intent that
  -- remains unresolved beyond the grace window is durable evidence of an
  -- ambiguous result and must fail the operational integrity gate.
  WITH valid_metadata AS (
    SELECT ledger_sequence, resource_id, created_at,
           CASE
             WHEN metadata IS NOT NULL AND pg_input_is_valid(metadata, 'jsonb')
             THEN metadata::jsonb
             ELSE NULL
           END AS metadata
    FROM audit_logs
  ), unresolved AS (
    SELECT intent.ledger_sequence
    FROM valid_metadata intent
    WHERE intent.metadata ->> 'auditPhase' = 'intent'
      AND intent.created_at::timestamptz < statement_timestamp() - interval '15 minutes'
      AND NOT EXISTS (
        SELECT 1
        FROM valid_metadata outcome
        WHERE outcome.metadata ->> 'auditPhase' = 'outcome'
          AND outcome.metadata ->> 'auditIntentId' = intent.resource_id
      )
  )
  SELECT count(*)::BIGINT, min(ledger_sequence)
  INTO unresolved_count, first_unresolved_sequence
  FROM unresolved;

  RETURN QUERY SELECT unresolved_count = 0, checked_count,
    first_unresolved_sequence, expected_previous, unresolved_count;
END;
$$;
