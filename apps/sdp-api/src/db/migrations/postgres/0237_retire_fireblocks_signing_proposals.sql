-- sdp:migration-compat: breaking
-- Ship as a migration-only change after the canonical proposal implementation
-- serves every revision. The deployment gate refuses a premature contraction.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM sdp_legacy_signing_proposals legacy
    LEFT JOIN custody_proposals canonical ON canonical.id = legacy.id
    WHERE canonical.id IS NULL OR canonical.kind <> 'signing'
      OR canonical.provider <> 'fireblocks'
      OR canonical.organization_id <> legacy.organization_id
      OR canonical.project_id <> legacy.project_id
      OR canonical.custody_wallet_id IS DISTINCT FROM legacy.custody_wallet_id
      OR canonical.operation <> legacy.operation OR canonical.binding <> legacy.binding
      OR (legacy.provider_transaction_id IS NOT NULL
        AND canonical.provider_transaction_id IS DISTINCT FROM legacy.provider_transaction_id)
      OR (legacy.refused_at IS NOT NULL AND canonical.refused_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'Legacy signing proposals have not been preserved in canonical storage';
  END IF;
END;
$$;
DROP TRIGGER sdp_legacy_signing_cancellation ON fireblocks_signing_proposals;
DROP TRIGGER sdp_bridge_legacy_signing_proposal ON fireblocks_signing_proposals;
DROP FUNCTION sdp_legacy_signing_cancellation();
DROP FUNCTION sdp_bridge_legacy_signing_proposal();
DROP VIEW sdp_legacy_signing_proposals;
DROP TABLE fireblocks_signing_proposals;
