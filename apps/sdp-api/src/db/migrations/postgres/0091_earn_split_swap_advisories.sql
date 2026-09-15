-- Orphaned split-swap advisories (PRO-1864, threat model EARN-026).
--
-- When an external-wallet swap-funded deposit cannot fit one Solana packet, SDP
-- hands the partner a standalone swap to broadcast itself and a follow-up
-- deposit to build afterwards. Until now nothing was persisted at that moment,
-- so a partner that broadcast the swap and crashed left the customer's funds
-- swapped-but-undeposited with zero SDP visibility, and with no anchor there
-- was nothing a detector could even look for.
--
-- This table is that anchor. It is ADVISORY STATE, not a movement and not a
-- build: no money moves on its account, nothing consumes it, and the detector
-- that reads it writes nothing but back to this table. `earn_movements` stays
-- the only money record; a row here is a claim that a swap was handed out.
--
-- Money columns carry ONE declared unit each, because the judgement compares
-- them: the floor and both balance samples are BASE-UNIT integers of the
-- deposit mint (the swap's on-chain `minOut` guarantee is enforced in atoms,
-- and the balance RPC answers in atoms), with the mint's decimals recorded
-- beside them so a mismatched read can be refused rather than misjudged. The
-- decimal `swap_min_out_amount` is display-only (it is what `followUp.amount`
-- told the partner) and is never compared.
--
-- A `confirmed` follow-up is treated as observed by the detector, and a
-- `failed` one is not; those rules live in code. What the schema pins is that
-- one movement can discharge at most one advisory (UNIQUE resolving_movement_id),
-- so one deposit by a reused owner wallet cannot silently close several.

CREATE TABLE IF NOT EXISTS earn_split_swap_advisories (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    -- SET NULL on project deletion, like the build table: an advisory must
    -- outlive the project that produced it, or the detector forgets the funds.
    project_id TEXT,
    environment TEXT NOT NULL,
    provider TEXT NOT NULL,
    -- Deliberately NO foreign key: the delist pass can delete a catalogue row,
    -- and the advisory must still name the strategy afterwards.
    strategy_id TEXT NOT NULL,
    vault_address TEXT NOT NULL,
    owner_address TEXT NOT NULL,
    source_token_mint TEXT NOT NULL,
    deposit_token_mint TEXT NOT NULL,
    deposit_token_decimals SMALLINT NOT NULL,
    -- Display only: the source-token decimal amount the swap consumes.
    swap_source_amount TEXT NOT NULL,
    -- Display only: the deposit-token decimal floor the partner was told to
    -- deposit (`followUp.amount`). Never compared.
    swap_min_out_amount TEXT NOT NULL,
    -- The floor in atoms. A landed swap raises the owner's deposit-token
    -- balance by AT LEAST this much; the detector's judgement is this number.
    swap_min_out_atoms TEXT NOT NULL,
    -- Past this height the standalone swap can no longer land, so the owner's
    -- balance can be judged: before it, the swap is simply in flight.
    swap_last_valid_block_height NUMERIC NOT NULL,
    fee_payer TEXT,
    -- The owner's deposit-token balance in atoms, read on the same cluster
    -- with the same call the detector uses, at build time. NOT NULL: without
    -- a baseline the detector could only page any wallet that ever held the
    -- deposit token, so the build fails closed rather than record a blind one.
    baseline_deposit_token_atoms TEXT NOT NULL,
    created_by TEXT,
    initiated_by_key_id TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    -- Fairness cursor for the detector's scan, so an orphan that stays open
    -- cannot pin the head of the queue and starve newer advisories.
    last_checked_at TEXT,
    last_observed_atoms TEXT,
    -- The newest follow-up BUILD seen for this owner, evidence the partner is
    -- alive and past the swap (a movement only exists once they submit).
    last_follow_up_build_at TEXT,
    first_flagged_at TEXT,
    resolved_at TEXT,
    resolution TEXT,
    -- 'system' for the two detector resolutions; an operator identity when a
    -- human acknowledges an orphan the partner has confirmed they handled.
    resolved_by TEXT,
    resolving_movement_id TEXT,

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (resolving_movement_id) REFERENCES earn_movements(id),

    CONSTRAINT earn_split_swap_advisories_environment_check
        CHECK (environment IN ('sandbox', 'production')),
    CONSTRAINT earn_split_swap_advisories_owner_address_format_check
        CHECK (LENGTH(owner_address) BETWEEN 32 AND 44),
    CONSTRAINT earn_split_swap_advisories_decimals_check
        CHECK (deposit_token_decimals BETWEEN 0 AND 18),
    CONSTRAINT earn_split_swap_advisories_source_amount_format_check
        CHECK (
            LENGTH(swap_source_amount) BETWEEN 1 AND 128
            AND swap_source_amount ~ '^\d+(\.\d+)?$'
            AND swap_source_amount ~ '[1-9]'
        ),
    CONSTRAINT earn_split_swap_advisories_min_out_amount_format_check
        CHECK (
            LENGTH(swap_min_out_amount) BETWEEN 1 AND 128
            AND swap_min_out_amount ~ '^\d+(\.\d+)?$'
            AND swap_min_out_amount ~ '[1-9]'
        ),
    -- Atom columns are digit strings. Zero IS storable for the balance
    -- samples (an empty wallet is a real baseline); the floor must be positive.
    CONSTRAINT earn_split_swap_advisories_min_out_atoms_check
        CHECK (LENGTH(swap_min_out_atoms) BETWEEN 1 AND 78
            AND swap_min_out_atoms ~ '^\d+$' AND swap_min_out_atoms ~ '[1-9]'),
    CONSTRAINT earn_split_swap_advisories_baseline_atoms_check
        CHECK (LENGTH(baseline_deposit_token_atoms) BETWEEN 1 AND 78
            AND baseline_deposit_token_atoms ~ '^\d+$'),
    CONSTRAINT earn_split_swap_advisories_observed_atoms_check
        CHECK (last_observed_atoms IS NULL
            OR (LENGTH(last_observed_atoms) BETWEEN 1 AND 78 AND last_observed_atoms ~ '^\d+$')),
    CONSTRAINT earn_split_swap_advisories_last_valid_block_height_check
        CHECK (
            swap_last_valid_block_height = TRUNC(swap_last_valid_block_height)
            AND swap_last_valid_block_height BETWEEN 0 AND 18446744073709551615
        ),
    CONSTRAINT earn_split_swap_advisories_resolution_check
        CHECK (resolution IS NULL OR resolution IN ('deposit_observed', 'unfunded', 'acknowledged')),
    -- Resolution is one fact with three columns; half-resolved is a lie.
    CONSTRAINT earn_split_swap_advisories_resolved_shape_check
        CHECK ((resolved_at IS NULL) = (resolution IS NULL)
            AND (resolved_at IS NULL) = (resolved_by IS NULL)),
    -- Only a deposit_observed resolution names a movement, and each movement
    -- discharges at most one advisory.
    CONSTRAINT earn_split_swap_advisories_resolving_movement_shape_check
        CHECK (resolving_movement_id IS NULL OR resolution = 'deposit_observed'),
    CONSTRAINT earn_split_swap_advisories_resolving_movement_id_key
        UNIQUE (resolving_movement_id)
);

-- The detector's open-set scan: oldest-unvisited first. Partial, because
-- resolved rows are forensics and never scanned again.
CREATE INDEX IF NOT EXISTS idx_earn_split_swap_advisories_open
    ON earn_split_swap_advisories (COALESCE(last_checked_at, created_at), created_at, id)
    WHERE resolved_at IS NULL;

-- The follow-up BUILD lookup the detector uses as in-flight evidence. The
-- build table has only its primary key today.
CREATE INDEX IF NOT EXISTS idx_earn_external_wallet_transactions_owner_deposit
    ON earn_external_wallet_transactions (organization_id, project_id, environment, owner_address, created_at DESC)
    WHERE direction = 'deposit';

ALTER TABLE earn_split_swap_advisories ENABLE ROW LEVEL SECURITY;
ALTER TABLE earn_split_swap_advisories FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_tenant_isolation ON earn_split_swap_advisories;
CREATE POLICY sdp_tenant_isolation ON earn_split_swap_advisories
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));
