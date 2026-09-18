CREATE UNIQUE INDEX payment_transfers_bvnk_onramp_payin_id_unique
    ON payment_transfers ((provider_data->'bvnk'->'payin'->>'id'))
    WHERE provider='bvnk' AND type='onramp';

UPDATE counterparty_provider_accounts cpa
SET provider_status='provisioned_funding_wallet',
    metadata='{}'::jsonb,
    updated_at=sdp_iso_now()
FROM projects prj
WHERE prj.id=cpa.project_id
  AND prj.environment='sandbox'
  AND cpa.kind='funding_wallet'
  AND cpa.provider='bvnk'
  AND cpa.provider_status='funding_wallet_locked';

UPDATE payment_transfers pt
SET status='failed',
    error='BVNK on-ramp payment rules retired',
    updated_at=sdp_iso_now()
FROM projects prj
WHERE prj.id=pt.project_id
  AND prj.environment='sandbox'
  AND pt.provider='bvnk'
  AND pt.type='onramp'
  AND pt.status IN ('pending','awaiting_payment','settling');

UPDATE counterparty_provider_accounts cpa
SET status='archived',
    metadata='{}'::jsonb,
    updated_at=sdp_iso_now()
FROM projects prj
WHERE prj.id=cpa.project_id
  AND prj.environment='sandbox'
  AND cpa.kind='funding_wallet'
  AND cpa.status='active'
  AND cpa.provider='bvnk'
  AND cpa.provider_status IS NULL;
