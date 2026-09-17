CREATE UNIQUE INDEX payment_transfers_bvnk_onramp_in_flight_unique
    ON payment_transfers ((provider_data->'bvnk'->>'fundingWalletAccountId'))
    WHERE provider = 'bvnk' AND type = 'onramp' AND status IN ('awaiting_payment','settling');
