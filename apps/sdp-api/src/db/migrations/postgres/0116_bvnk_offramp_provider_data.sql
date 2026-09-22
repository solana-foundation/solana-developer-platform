UPDATE counterparties SET provider_data = provider_data #- '{bvnk,offramp}' WHERE provider_data #> '{bvnk,offramp}' IS NOT NULL;
UPDATE payment_transfers SET status = 'expired', updated_at = sdp_iso_now() WHERE provider = 'bvnk' AND type = 'offramp' AND status IN ('pending', 'awaiting_payment', 'settling') AND provider_data #> '{bvnk,channel}' IS NULL;
