-- custody_proposals is the canonical proposal table for transfers and sign-only
-- operations. Legacy Fireblocks writes remain bridged only through the rolling
-- deployment; retire that table after every serving revision uses this schema.
ALTER TABLE custody_proposals
  ALTER COLUMN payment_transfer_id DROP NOT NULL,
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'transfer',
  ADD COLUMN operation TEXT NOT NULL DEFAULT 'TRANSFER',
  ADD COLUMN request_id TEXT,
  ADD COLUMN finished_at TEXT,
  ADD CONSTRAINT custody_proposals_kind_check CHECK (
    (kind = 'transfer' AND payment_transfer_id IS NOT NULL AND operation = 'TRANSFER')
    OR (kind = 'signing' AND payment_transfer_id IS NULL AND custody_wallet_id IS NOT NULL
      AND length(operation) > 0)
  ) NOT VALID;

-- One projection maps historical provider statuses. The bridge and backfill use
-- the same mapping; application writes use the provider-neutral state reducer.
CREATE VIEW sdp_legacy_signing_proposals WITH (security_invoker = true) AS
WITH observed AS (
  SELECT sp.*,
    CASE
      WHEN status IN ('SIGNED', 'BROADCASTING', 'CONFIRMING', 'COMPLETED') THEN 'completed'
      WHEN status IN ('CANCELLED', 'CANCELED') THEN 'cancelled'
      WHEN status IN ('FAILED', 'REJECTED', 'BLOCKED') THEN 'failed'
      WHEN provider_transaction_id IS NULL THEN 'submitting'
      WHEN status IN ('SUBMITTED', 'PENDING_AML_SCREENING', 'PENDING_ENRICHMENT',
        'PENDING_AUTHORIZATION', 'QUEUED', 'PENDING_SIGNATURE',
        'PENDING_3RD_PARTY_MANUAL_APPROVAL', 'PENDING_3RD_PARTY') THEN 'pending'
      ELSE 'executing'
    END AS phase
  FROM fireblocks_signing_proposals sp
)
SELECT id, organization_id, project_id, custody_wallet_id, NULL::text AS payment_transfer_id,
  'fireblocks'::text AS provider,
  jsonb_build_object('connectionId', connection_id, 'accountFingerprint', account_fingerprint,
    'vaultAccountId', vault_account_id, 'sourceAddress', source_address, 'assetId', asset_id) AS binding,
  'signing'::text AS kind, operation, request_id,
  phase AS provider_phase,
  CASE WHEN cancel_requested_at IS NULL THEN 'authorized'
    WHEN phase = 'completed' THEN 'committed_after_refusal' ELSE 'refused'
  END AS authorization_state,
  provider_transaction_id,
  CASE WHEN status = 'SUBMITTING' THEN NULL ELSE status END AS provider_status,
  created_at AS submission_started_at,
  cancel_requested_at AS refused_at,
  CASE WHEN cancel_requested_at IS NOT NULL THEN 'cancellation_requested' END AS refusal_reason,
  CASE WHEN cancel_requested_at IS NOT NULL THEN 'Cancellation was requested for this proposal' END AS refusal_message,
  CASE WHEN phase IN ('completed', 'failed', 'cancelled') THEN COALESCE(finished_at, updated_at) END AS finished_at,
  last_polled_at, updated_at AS next_check_at, created_at, updated_at
FROM observed;

-- The prior image returns cancel_requested_at from its observation UPDATE.
-- Lock the canonical row before that UPDATE can return a signature, so a
-- canonical cancellation that committed first also stops the prior image.
CREATE FUNCTION sdp_legacy_signing_cancellation() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  cancellation_at TEXT;
  phase TEXT;
BEGIN
  SELECT COALESCE(cp.refused_at, cp.cancel_requested_at), cp.provider_phase
    INTO cancellation_at, phase
    FROM custody_proposals cp
   WHERE cp.id = NEW.id AND cp.organization_id = NEW.organization_id
     AND cp.project_id = NEW.project_id AND cp.kind = 'signing'
   FOR UPDATE;
  -- An old viewer may still show pending after canonical observation completed.
  -- Its late cancel cannot manufacture a refusal after signature acceptance.
  IF phase IN ('completed', 'failed', 'cancelled', 'not_sent', 'never_accepted')
     AND OLD.cancel_requested_at IS NULL AND NEW.cancel_requested_at IS NOT NULL
     AND cancellation_at IS NULL THEN
    RETURN NULL;
  END IF;
  NEW.cancel_requested_at := COALESCE(OLD.cancel_requested_at, NEW.cancel_requested_at, cancellation_at);
  RETURN NEW;
END;
$$;
CREATE TRIGGER sdp_legacy_signing_cancellation
  BEFORE UPDATE ON fireblocks_signing_proposals
  FOR EACH ROW EXECUTE FUNCTION sdp_legacy_signing_cancellation();

CREATE FUNCTION sdp_bridge_legacy_signing_proposal() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  incoming sdp_legacy_signing_proposals%ROWTYPE;
  existing custody_proposals%ROWTYPE;
  next_phase TEXT;
  keep_progress BOOLEAN;
  next_refusal_at TEXT;
BEGIN
  SELECT * INTO STRICT incoming FROM sdp_legacy_signing_proposals WHERE id = NEW.id;
  SELECT * INTO existing FROM custody_proposals WHERE id = NEW.id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO custody_proposals
      (id, organization_id, project_id, custody_wallet_id, payment_transfer_id, provider,
       binding, kind, operation, request_id, provider_phase, authorization_state,
       provider_transaction_id, provider_status, submission_started_at,
       refused_at, refusal_reason, refusal_message, finished_at, last_polled_at,
       next_check_at, created_at, updated_at)
    SELECT id, organization_id, project_id, custody_wallet_id, payment_transfer_id, provider,
       binding, kind, operation, request_id, provider_phase, authorization_state,
       provider_transaction_id, provider_status, submission_started_at,
       refused_at, refusal_reason, refusal_message, finished_at, last_polled_at,
       next_check_at, created_at, updated_at
      FROM sdp_legacy_signing_proposals WHERE id = NEW.id
    ON CONFLICT (id) DO NOTHING;
    IF FOUND THEN RETURN NEW; END IF;
    SELECT * INTO STRICT existing FROM custody_proposals WHERE id = NEW.id FOR UPDATE;
  END IF;
  IF existing.kind <> 'signing' OR existing.provider <> 'fireblocks'
     OR existing.organization_id <> incoming.organization_id
     OR existing.project_id <> incoming.project_id
     OR existing.custody_wallet_id IS DISTINCT FROM incoming.custody_wallet_id
     OR existing.binding <> incoming.binding OR existing.operation <> incoming.operation
     OR (existing.provider_transaction_id IS NOT NULL
       AND incoming.provider_transaction_id IS NOT NULL
       AND existing.provider_transaction_id <> incoming.provider_transaction_id) THEN
    RAISE EXCEPTION 'Legacy proposal identity does not match canonical proposal' USING ERRCODE = '23514';
  END IF;
  keep_progress := existing.provider_phase IN ('completed', 'failed', 'cancelled', 'not_sent', 'never_accepted')
    OR (existing.provider_transaction_id IS NOT NULL AND incoming.provider_transaction_id IS NULL);
  next_phase := CASE WHEN keep_progress THEN existing.provider_phase ELSE incoming.provider_phase END;
  next_refusal_at := COALESCE(existing.refused_at, incoming.refused_at);
  UPDATE custody_proposals SET
    provider_phase = next_phase,
    provider_transaction_id = COALESCE(existing.provider_transaction_id, incoming.provider_transaction_id),
    provider_status = CASE WHEN keep_progress THEN existing.provider_status ELSE incoming.provider_status END,
    authorization_state = CASE
      WHEN next_refusal_at IS NULL THEN 'authorized'
      WHEN next_phase = 'completed' THEN CASE WHEN existing.alerted_at IS NULL
        THEN 'committed_after_refusal' ELSE 'refusal_alerted' END
      WHEN existing.refused_at IS NOT NULL THEN existing.authorization_state
      ELSE 'refused'
    END,
    refused_at = next_refusal_at,
    refusal_reason = COALESCE(existing.refusal_reason, incoming.refusal_reason),
    refusal_message = COALESCE(existing.refusal_message, incoming.refusal_message),
    finished_at = CASE WHEN keep_progress THEN existing.finished_at ELSE incoming.finished_at END,
    last_polled_at = GREATEST(existing.last_polled_at, incoming.last_polled_at),
    next_check_at = LEAST(existing.next_check_at, incoming.next_check_at),
    version = existing.version + 1,
    updated_at = GREATEST(existing.updated_at, incoming.updated_at)
  WHERE id = existing.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sdp_bridge_legacy_signing_proposal
  AFTER INSERT OR UPDATE ON fireblocks_signing_proposals
  FOR EACH ROW EXECUTE FUNCTION sdp_bridge_legacy_signing_proposal();
