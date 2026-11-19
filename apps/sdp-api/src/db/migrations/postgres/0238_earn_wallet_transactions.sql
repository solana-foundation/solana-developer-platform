-- Canonical unsigned build storage starts empty for the prelaunch core.
-- It has no dependency on, data copy from or dual write to retired build tables.
-- Movement and provider-request ledgers remain the settlement authority.
CREATE TABLE earn_wallet_transactions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    environment TEXT NOT NULL,
    provider TEXT NOT NULL,
    strategy_id TEXT,
    custody_wallet_id TEXT,
    fee_mode TEXT NOT NULL DEFAULT 'wallet',
    operation_only BOOLEAN NOT NULL DEFAULT FALSE,
    direction TEXT NOT NULL,
    owner_address TEXT NOT NULL,
    vault_address TEXT NOT NULL,
    strategy_reference TEXT,
    token_mint TEXT NOT NULL,
    share_mint TEXT NOT NULL,
    label TEXT NOT NULL,
    position_id TEXT,
    denomination TEXT NOT NULL,
    amount_requested TEXT NOT NULL,
    min_shares_out TEXT,
    creates_share_account BOOLEAN NOT NULL DEFAULT FALSE,
    fee_payer TEXT,
    share_ata_rent_funder TEXT,
    unsigned_transaction TEXT NOT NULL,
    last_valid_block_height NUMERIC NOT NULL,
    movement_id TEXT,
    consumed_at TEXT,
    created_by TEXT,
    initiated_by_key_id TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
    FOREIGN KEY (direction) REFERENCES earn_movement_directions(id),
    FOREIGN KEY (position_id) REFERENCES earn_positions(id),
    FOREIGN KEY (movement_id) REFERENCES earn_movements(id),
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (strategy_id) REFERENCES earn_strategies(id) ON DELETE SET NULL,
    FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id),
    CONSTRAINT earn_wallet_transactions_movement_id_key UNIQUE (movement_id),
    CONSTRAINT earn_wallet_transactions_environment_check
        CHECK (environment IN ('sandbox', 'production')),
    CONSTRAINT earn_wallet_transactions_owner_address_format_check
        CHECK (LENGTH(owner_address) BETWEEN 32 AND 44),
    CONSTRAINT earn_wallet_transactions_amount_format_check
        CHECK (LENGTH(amount_requested) BETWEEN 1 AND 128
            AND amount_requested ~ '^\d+(\.\d+)?$' AND amount_requested ~ '[1-9]'),
    CONSTRAINT earn_wallet_transactions_min_shares_out_format_check
        CHECK (min_shares_out IS NULL OR (
            LENGTH(min_shares_out) BETWEEN 1 AND 128
            AND min_shares_out ~ '^\d+(\.\d+)?$' AND min_shares_out ~ '[1-9]')),
    CONSTRAINT earn_wallet_transactions_denomination_check
        CHECK (LENGTH(BTRIM(denomination)) BETWEEN 1 AND 128),
    CONSTRAINT earn_wallet_transactions_last_valid_block_height_check
        CHECK (last_valid_block_height = TRUNC(last_valid_block_height)
            AND last_valid_block_height BETWEEN 0 AND 18446744073709551615),
    CONSTRAINT earn_wallet_transactions_consumed_shape_check
        CHECK ((movement_id IS NULL) = (consumed_at IS NULL)),
    CONSTRAINT earn_wallet_transactions_rent_funder_shape_check
        CHECK (share_ata_rent_funder IS NULL
            OR (creates_share_account AND share_ata_rent_funder = fee_payer)),
    CONSTRAINT earn_wallet_transactions_fee_payer_format_check
        CHECK (fee_payer IS NULL OR LENGTH(fee_payer) BETWEEN 32 AND 44),
    CONSTRAINT earn_wallet_transactions_fee_mode_check
        CHECK (fee_mode IN ('wallet', 'partner', 'sponsored'))
);

-- Once restricted to operation execution, a build cannot be downgraded.
CREATE FUNCTION sdp_earn_operation_only_build() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.operation_only AND NOT NEW.operation_only THEN
        RAISE EXCEPTION 'Earn operation-only build restriction is irreversible';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER earn_transactions_strategy_reference
BEFORE INSERT OR UPDATE ON earn_wallet_transactions
FOR EACH ROW EXECUTE FUNCTION sync_earn_strategy_reference();
CREATE TRIGGER earn_transactions_operation_only
BEFORE UPDATE ON earn_wallet_transactions
FOR EACH ROW EXECUTE FUNCTION sdp_earn_operation_only_build();

CREATE TABLE earn_wallet_withdrawal_request_transactions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    environment TEXT NOT NULL,
    provider TEXT NOT NULL,
    position_id TEXT,
    withdrawal_request_id TEXT,
    custody_wallet_id TEXT,
    strategy_id TEXT,
    fee_mode TEXT NOT NULL DEFAULT 'wallet',
    operation_only BOOLEAN NOT NULL DEFAULT FALSE,
    action TEXT NOT NULL,
    owner_address TEXT NOT NULL,
    vault_address TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    share_mint TEXT NOT NULL,
    request_address TEXT NOT NULL,
    mechanism TEXT NOT NULL DEFAULT 'solver_queue',
    shares TEXT,
    quoted_assets TEXT,
    share_decimals SMALLINT,
    asset_decimals SMALLINT,
    intermediate_mint TEXT,
    intermediate_amount TEXT,
    discount_bps INTEGER,
    maturity_timestamp NUMERIC,
    deadline_timestamp NUMERIC,
    fee_payer TEXT,
    unsigned_transaction TEXT NOT NULL,
    last_valid_block_height NUMERIC NOT NULL,
    consumed_action_id TEXT,
    consumed_at TEXT,
    created_by TEXT,
    initiated_by_key_id TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    -- An owner-address position stores its owner; a custody position stores
    -- the wallet id and leaves that owner column NULL.
    position_owner_address TEXT GENERATED ALWAYS AS (
        CASE WHEN custody_wallet_id IS NULL THEN owner_address END
    ) STORED,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
    CONSTRAINT earn_queued_build_owner_position_fk
    FOREIGN KEY (position_id, organization_id, project_id, environment, provider,
        vault_address, position_owner_address)
        REFERENCES earn_positions(id, organization_id, project_id, environment,
            provider, vault_address, owner_address),
    CONSTRAINT earn_queued_build_custody_position_fk
    FOREIGN KEY (position_id, organization_id, environment, provider,
        vault_address, custody_wallet_id)
        REFERENCES earn_positions(id, organization_id, environment, provider,
            vault_address, custody_wallet_id),
    FOREIGN KEY (withdrawal_request_id, organization_id, environment)
        REFERENCES earn_vault_withdrawal_requests(id, organization_id, environment),
    FOREIGN KEY (consumed_action_id) REFERENCES earn_vault_withdrawal_request_actions(id),
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id),
    FOREIGN KEY (strategy_id) REFERENCES earn_strategies(id),
    CONSTRAINT earn_wallet_withdrawal_request_transactions_consumed_action_key
        UNIQUE (consumed_action_id),
    CONSTRAINT earn_wallet_withdrawal_request_transactions_environment_check
        CHECK (environment IN ('sandbox', 'production')),
    CONSTRAINT earn_wallet_withdrawal_request_transactions_action_check
        CHECK (action IN ('request', 'cancel')),
    CONSTRAINT earn_wallet_withdrawal_request_transactions_owner_format_check
        CHECK (LENGTH(owner_address) BETWEEN 32 AND 44),
    CONSTRAINT earn_wallet_withdrawal_request_transactions_fee_payer_format_check
        CHECK (fee_payer IS NULL OR LENGTH(fee_payer) BETWEEN 32 AND 44),
    CONSTRAINT earn_wallet_withdrawal_request_transactions_height_check
        CHECK (last_valid_block_height = TRUNC(last_valid_block_height)
            AND last_valid_block_height BETWEEN 0 AND 18446744073709551615),
    CONSTRAINT earn_wallet_withdrawal_request_transactions_consumed_check
        CHECK ((consumed_action_id IS NULL) = (consumed_at IS NULL)),
    CONSTRAINT earn_wallet_withdrawal_request_transactions_mechanism_check
        CHECK (mechanism IN ('solver_queue', 'operator_redemption')),
    CONSTRAINT earn_wallet_withdrawal_request_transactions_fee_mode_check
        CHECK (fee_mode IN ('wallet', 'partner', 'sponsored')),
    CONSTRAINT earn_wallet_withdrawal_request_transactions_request_shape_check
        CHECK (
            (action = 'request' AND withdrawal_request_id IS NULL
                AND (position_id IS NOT NULL OR strategy_id IS NOT NULL)
                AND shares IS NOT NULL AND quoted_assets IS NOT NULL
                AND share_decimals IS NOT NULL AND asset_decimals IS NOT NULL
                AND (
                    (mechanism = 'solver_queue'
                        AND intermediate_mint IS NULL AND intermediate_amount IS NULL
                        AND discount_bps IS NOT NULL
                        AND maturity_timestamp IS NOT NULL AND deadline_timestamp IS NOT NULL)
                    OR
                    (mechanism = 'operator_redemption'
                        AND intermediate_mint IS NOT NULL AND intermediate_amount IS NOT NULL
                        AND discount_bps IS NULL
                        AND maturity_timestamp IS NULL AND deadline_timestamp IS NULL)
                ))
            OR
            (action = 'cancel' AND withdrawal_request_id IS NOT NULL
                AND shares IS NULL AND quoted_assets IS NULL
                AND share_decimals IS NULL AND asset_decimals IS NULL
                AND intermediate_mint IS NULL AND intermediate_amount IS NULL
                AND discount_bps IS NULL
                AND maturity_timestamp IS NULL AND deadline_timestamp IS NULL)
        )
);

-- The custody FK retains the position claim. Also bind the build's signing
-- address and project/mints, which are not part of that existing unique key.
CREATE FUNCTION sdp_earn_queued_build_custody_source() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM custody_wallets wallet
        LEFT JOIN custody_configs config ON config.id = wallet.custody_config_id
        LEFT JOIN custody_connections connection ON connection.id = wallet.custody_connection_id
        LEFT JOIN earn_positions position ON position.id = NEW.position_id
            AND position.organization_id = NEW.organization_id
            AND position.environment = NEW.environment
            AND position.provider = NEW.provider
            AND position.vault_address = NEW.vault_address
            AND position.custody_wallet_id = NEW.custody_wallet_id
            AND position.token_mint = NEW.token_mint
            AND position.share_mint = NEW.share_mint
            AND (NEW.project_id IS NULL OR position.project_id = NEW.project_id)
        WHERE wallet.id = NEW.custody_wallet_id
            AND wallet.public_key = NEW.owner_address
            AND (
                (config.organization_id = NEW.organization_id
                    AND (NEW.project_id IS NULL OR config.project_id = NEW.project_id))
                OR
                (connection.organization_id = NEW.organization_id
                    AND (NEW.project_id IS NULL OR connection.project_id = NEW.project_id))
            )
            AND (NEW.position_id IS NULL OR position.id IS NOT NULL)
    ) THEN
        RAISE foreign_key_violation USING
            CONSTRAINT = 'earn_queued_build_custody_source_fk',
            MESSAGE = 'Queued build does not match its custody source';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER earn_queued_build_custody_source
BEFORE INSERT OR UPDATE ON earn_wallet_withdrawal_request_transactions
FOR EACH ROW WHEN (NEW.custody_wallet_id IS NOT NULL)
EXECUTE FUNCTION sdp_earn_queued_build_custody_source();

CREATE TRIGGER earn_queued_transactions_operation_only
BEFORE UPDATE ON earn_wallet_withdrawal_request_transactions
FOR EACH ROW EXECUTE FUNCTION sdp_earn_operation_only_build();

ALTER TABLE earn_wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE earn_wallet_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON earn_wallet_transactions
    USING (sdp_tenant_isolation_allows(organization_id))
    WITH CHECK (sdp_tenant_isolation_allows(organization_id));

ALTER TABLE earn_wallet_withdrawal_request_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE earn_wallet_withdrawal_request_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON earn_wallet_withdrawal_request_transactions
    USING (sdp_tenant_isolation_allows(organization_id))
    WITH CHECK (sdp_tenant_isolation_allows(organization_id));
