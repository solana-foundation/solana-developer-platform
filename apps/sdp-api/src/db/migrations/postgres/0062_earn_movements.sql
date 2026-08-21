-- Solana Earn: one provider-neutral movement ledger, and one holdings table
-- behind it (PRO-1705, ADR 0002 addendum 2026-08-19 "One ledger for every
-- movement").
--
-- ── The problem this closes ────────────────────────────────────────────────
-- Earn ended up with TWO authoritative movement tables split by EXECUTION
-- MECHANISM rather than by business meaning:
--
--   * earn_program_withdrawals (0055) — provider-API portfolio withdrawals.
--   * earn_vault_movements     (0059) — signed on-chain vault deposits.
--
-- Both record the same fact — money moved through Earn — so idempotency,
-- lifecycle, reconciliation, history and reporting are all duplicated, and no
-- single query can answer "what moved on this organization". Every new provider
-- or direction deepened the split: 0061's index comment still anticipates a
-- third variation (vault withdraw) landing as more columns on 0059.
--
-- This table is the answer: ONE row per real-world money movement, both
-- directions, both execution models, discriminated by `execution_model` rather
-- than by which table it lives in.
--
-- ── On reclaiming the name ─────────────────────────────────────────────────
-- 0048 had an `earn_movements` and 0055 dropped it unwritten. The NAME is free;
-- the SHAPE is not. That table was position-scoped with base-unit amounts, a
-- nullable provider, no environment, no fingerprint, and an FK into the
-- delist-pruned catalogue. This is a movement-identity-first schema that
-- happens to reuse the name — see the decisions below, all of which 0048 got
-- wrong or never had.
--
-- ── Why new tables rather than ALTER/RENAME ────────────────────────────────
-- Expand/contract, exactly as 0055 did: the legacy tables keep their writers
-- and their data for now. The application dual-writes both shapes in one
-- transaction (0064 backfills history), reads switch in a later release, and
-- the legacy tables are dropped last of all. The point is that every
-- intermediate deploy is rollback-safe — the previously deployed revision
-- keeps working throughout, because nothing it writes was renamed or removed.
-- The one legacy-schema relaxation below makes a provider wallet's provisioning
-- project nullable; every old and new writer still supplies one on insert. A
-- rename would have made the rollback of the FIRST deploy break vault deposits
-- outright; the repo also has no RENAME precedent to follow.
--
-- Conventions inherited from 0055 / 0059:
-- * provider is open TEXT (ADR 0001/0002 drift rule) — a row can outlive its
--   provider's registry entry; allowed values live in code registries.
-- * Money is decimal strings, never numeric: exact fund amounts must round-trip
--   without DB coercion. The only NUMERIC column is a block height (a count).
-- * project_id / created_by / initiated_by_key_id are forensic attribution.
-- * created_at/updated_at are TEXT ISO via sdp_iso_now().

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Vocabulary tables.
--
-- Closed, earn-owned vocabularies are LOOKUP TABLES with FK integrity rather
-- than CHECK (status IN (...)) lists. A CHECK cannot be referenced, cannot
-- carry attributes, and every new value is a DDL change to a money table; a
-- lookup row is data, joins for display, and carries `is_terminal` next to the
-- value it describes.
--
-- Natural TEXT primary keys, deliberately: the FK columns stay human-readable
-- in every row and every query, so no join is needed to know what a movement's
-- status IS. Native Postgres ENUM types were rejected — values cannot be
-- renamed or removed, and ALTER TYPE ADD VALUE has transactional restrictions a
-- lookup row does not.
--
-- Rows are seeded here, appended by INSERT in later migrations, and NEVER
-- deleted once history references them. `@sdp/types` stays the source of truth
-- for BEHAVIOUR (which transitions are legal, how a status renders); a
-- conformance test pins these rows to those constants so the two cannot drift.
--
-- NOT converted to lookup tables, on purpose:
-- * provider     — open registry string (ADR 0001/0002); a new provider must
--                  never require a migration.
-- * environment  — platform-wide vocabulary spelled as a CHECK on dozens of
--                  tables; earn diverging alone would be inconsistency, not
--                  cleanliness.
-- * denomination — an OPEN set ('usd' or any token mint), not a vocabulary.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS earn_execution_models (
    id TEXT PRIMARY KEY
);
INSERT INTO earn_execution_models (id) VALUES
    -- Provider-API execution: SDP asks a provider to move money it custodies
    -- (0055's Ground portfolio withdrawals).
    ('custodial'),
    -- On-chain execution: SDP builds, signs and submits the instruction itself
    -- from a custody wallet (0059's Kamino vault deposits).
    ('vault_direct')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS earn_movement_directions (
    id TEXT PRIMARY KEY
);
-- Spelled 'withdrawal' (0048's spelling, and the word every wire contract,
-- route and dashboard already uses). 0059 wrote 'withdraw' on a column no row
-- has ever carried — the vault withdraw path does not exist yet — so nothing
-- is being migrated away from here.
INSERT INTO earn_movement_directions (id) VALUES
    ('deposit'),
    ('withdrawal')
ON CONFLICT (id) DO NOTHING;

-- Status is scoped BY execution model, because the two lifecycles are genuinely
-- different and flattening them would lose meaning:
--
--   custodial    a provider reports settlement, and can report a PARTIAL one or
--                park a payout awaiting a customer approval stamp.
--   vault_direct a chain reports commitment, which is not the same event as
--                settlement: `confirmed` is an optimistic commitment that a
--                fork can still drop, `finalized` is irreversible.
--
-- So `completed` and `finalized` are NOT synonyms wearing two names — they are
-- different facts, and the composite primary key is what makes each legal only
-- for the model that can actually produce it. `earn_movements` FKs the PAIR,
-- which also makes `execution_model` transitively valid without a second FK.
CREATE TABLE IF NOT EXISTS earn_movement_statuses (
    execution_model TEXT NOT NULL,
    status TEXT NOT NULL,
    -- Terminal means "this movement never moves on". Stored beside the value so
    -- SQL (list filters, outbox scans) reads the same terminal set the
    -- application transition guards enforce, instead of re-spelling it — 0059's
    -- listDeposits hardcoded ('confirmed','failed') in SQL while the shared
    -- constant lived in TypeScript, which is exactly the drift this prevents.
    is_terminal BOOLEAN NOT NULL,

    PRIMARY KEY (execution_model, status),
    FOREIGN KEY (execution_model) REFERENCES earn_execution_models(id)
);
INSERT INTO earn_movement_statuses (execution_model, status, is_terminal) VALUES
    -- 'requested' is SDP-only intent state: the row exists, the provider has
    -- not accepted the call yet (0055's vocabulary, unchanged).
    ('custodial', 'requested', FALSE),
    ('custodial', 'processing', FALSE),
    -- Synthesized by the provider client when a payout leg awaits a customer
    -- approval stamp; a withdrawal waiting on a human must be legible.
    ('custodial', 'pending_approval', FALSE),
    ('custodial', 'completed', TRUE),
    -- Terminal by convention: if a provider ever advances it, the live read
    -- keeps serving provider truth while the ledger row stays put.
    ('custodial', 'partially_completed', TRUE),
    ('custodial', 'failed', TRUE),
    ('custodial', 'cancelled', TRUE),

    -- 'requested' is 0059's 'pending' under one name for one meaning: a signed
    -- transaction is durably recorded but is not known to be on the wire. The
    -- rename is the whole reason both models can share a column honestly.
    ('vault_direct', 'requested', FALSE),
    ('vault_direct', 'submitted', FALSE),
    -- Optimistic chain commitment. NOT terminal, unlike 0059 — a confirmed
    -- transaction can still be dropped in a fork rollback, and treating it as
    -- settled is what made "settled" mean two things across SDP.
    ('vault_direct', 'confirmed', FALSE),
    ('vault_direct', 'finalized', TRUE),
    ('vault_direct', 'failed', TRUE)
ON CONFLICT (execution_model, status) DO NOTHING;

-- A provider wallet is scoped to its organization and environment; project_id
-- only records which project provisioned it (0049/0056). The original CASCADE
-- disagreed with that scope: deleting the provisioning project tried to delete
-- a shared, potentially funded provider account. It also conflicts with the
-- unified holding below, whose project attribution is deliberately cleared so
-- its movement history survives. Retain the account and clear only its forensic
-- project attribution. This is a rollback-safe relaxation: prior revisions
-- still write a real project, and NULL appears only after a hard deletion.
ALTER TABLE earn_provider_wallets
    DROP CONSTRAINT IF EXISTS earn_provider_wallets_project_id_fkey;

ALTER TABLE earn_provider_wallets
    ALTER COLUMN project_id DROP NOT NULL;

ALTER TABLE earn_provider_wallets
    ADD CONSTRAINT earn_provider_wallets_project_id_fkey
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

-- The same relaxation for 0055's withdrawal history, and for the same reason
-- twice over.
--
-- 1. It is the forensics rule applied consistently: project_id is write-only
--    provisioning attribution (ADR 0002), and attribution is not a lifetime.
--    CASCADE made deleting a project DESTROY the withdrawal history of money
--    that actually left the organization — the one record a purge must not take
--    with it.
-- 2. It keeps the two shapes ISOMORPHIC through the expand window, which is
--    this migration's entire safety argument. `earn_movements.project_id` is
--    SET NULL; leaving the legacy table on CASCADE would make a hard project
--    deletion drop the legacy row while the unified row survived. A reused
--    idempotency key would then insert a fresh legacy row, collide with the
--    surviving unified row on `idx_earn_movements_custodial_request`, and the
--    route's unique-violation path — which re-resolves the replay from the
--    LEGACY table — would find nothing and fail that key permanently.
--
-- Rollback-safe, like the wallet relaxation above: every old and new writer
-- still supplies a real project on insert, and NULL appears only after a hard
-- deletion.
ALTER TABLE earn_program_withdrawals
    DROP CONSTRAINT IF EXISTS earn_program_withdrawals_project_id_fkey;

ALTER TABLE earn_program_withdrawals
    ALTER COLUMN project_id DROP NOT NULL;

ALTER TABLE earn_program_withdrawals
    ADD CONSTRAINT earn_program_withdrawals_project_id_fkey
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Holdings: one row per position, whatever its custody model.
--
-- Supersedes earn_vault_positions (0059), generalized so a custodial program is
-- expressible in the same table. Still emphatically NOT a balance: balances and
-- share counts are read LIVE on every request (ADR 0002 — for a non-custodial
-- vault the chain IS the provider, and for a custodial program the provider
-- is). This records only that a holding exists, so reads know what to hydrate.
--
-- Why positions unify but ACCOUNTS do not: earn_provider_wallets models an
-- ACCOUNT at a provider — the custodial twin of custody_wallets — while this
-- table models the HOLDING that links an account to an instrument. Folding the
-- account in here would be the same category error as folding in
-- custody_wallets. So a custodial position is a link row pointing at its
-- program wallet, and earn_provider_wallets keeps owning the account.
--
-- The instrument for a custodial position is the PORTFOLIO (the program), not
-- whichever strategy it currently targets — which is what keeps the claim key
-- immutable across a re-target.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS earn_positions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    -- Forensic attribution, not ownership. Organization fallback wallets may
    -- hold one claim for movements initiated by multiple projects.
    project_id TEXT,
    environment TEXT NOT NULL,
    provider TEXT NOT NULL,
    -- Which execution model this holding is reached by; decides which of the
    -- two column groups below is populated.
    kind TEXT NOT NULL,

    -- ─ vault_direct: the custody wallet signs and holds the shares ─
    custody_wallet_id TEXT,
    -- The vault's own on-chain address (the catalogue's provider_reference).
    -- Named for what it IS, because 0059 overloaded `provider_reference` to
    -- mean the INSTRUMENT here and the MOVEMENT's provider id on the other
    -- table — two incompatible meanings that could not share a column once the
    -- tables merged.
    vault_address TEXT,
    -- Denormalised from the vault at open time so a position still renders when
    -- the catalogue row is delisted. Never used to build an instruction — the
    -- builder always re-reads vault state from chain.
    share_mint TEXT,
    token_mint TEXT,

    -- ─ custodial: the provider holds the funds in a program wallet ─
    provider_wallet_id TEXT,

    label TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    -- A vault claim is activated only in the transaction that durably records a
    -- signed transaction that can create the holding; a custodial position is
    -- active from the moment its program exists.
    activated_at TEXT,
    -- Set when the position is fully exited. Kept rather than deleted: the
    -- movement history references it, and a re-entry reuses the row.
    closed_at TEXT,

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
    -- Deliberately NO cascade on either account FK: an account with holdings
    -- must not be deletable out from under them (0055/0059's fail-loud rule).
    FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id),
    FOREIGN KEY (provider_wallet_id) REFERENCES earn_provider_wallets(id),
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (kind) REFERENCES earn_execution_models(id),

    CONSTRAINT earn_positions_environment_check
        CHECK (environment IN ('sandbox', 'production')),
    -- Exactly one shape per row, both directions asserted: a vault position
    -- cannot borrow a program wallet and a custodial position cannot claim an
    -- on-chain vault. This is what lets one table hold both without either
    -- shape's invariants weakening to "nullable and hope".
    CONSTRAINT earn_positions_kind_shape_check
        CHECK (
            (
                kind = 'vault_direct'
                AND custody_wallet_id IS NOT NULL
                AND vault_address IS NOT NULL
                AND share_mint IS NOT NULL
                AND token_mint IS NOT NULL
                AND provider_wallet_id IS NULL
            )
            OR (
                kind = 'custodial'
                AND provider_wallet_id IS NOT NULL
                AND custody_wallet_id IS NULL
                AND vault_address IS NULL
                AND share_mint IS NULL
                AND token_mint IS NULL
            )
        ),

    -- FK targets for earn_movements below. Two constraints, because a movement
    -- asserts two different things: every movement belongs to a holding in its
    -- own tenancy, and a VAULT movement additionally names its exact claim.
    CONSTRAINT earn_positions_tenancy_key
        UNIQUE (id, organization_id, environment, provider),
    CONSTRAINT earn_positions_movement_identity_key
        UNIQUE (
            id,
            organization_id,
            environment,
            provider,
            vault_address,
            custody_wallet_id
        )
);

-- One vault position per (org, environment, provider, vault, wallet).
--
-- Scoped to the ORG and the WALLET — emphatically NOT global on
-- (provider, vault_address) the way 0056 scopes a custodial wallet. The vault
-- registry is permissionless and public: two orgs holding "Steakhouse USDC" is
-- normal, and so is one org holding it from two different wallets. A global
-- unique here would refuse the second org's deposit outright.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_positions_vault_claim
    ON earn_positions(organization_id, environment, provider, vault_address, custody_wallet_id)
    WHERE kind = 'vault_direct';

-- One custodial position per program wallet. Global, matching 0056's global
-- unique on the wallet itself: a provider-side wallet holds real funds, so
-- exactly one holding may claim it platform-wide. The org/environment/provider
-- columns are copied FROM that wallet, so they cannot disagree with it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_positions_program_claim
    ON earn_positions(provider_wallet_id)
    WHERE kind = 'custodial';

-- Wallet-scoped list path: every read supplies the current project's custody
-- wallet row ids (plus organization fallbacks), pages by (created_at, id), and
-- excludes provisional claims that never reached the signed boundary.
CREATE INDEX IF NOT EXISTS idx_earn_positions_wallet_created
    ON earn_positions(
        organization_id,
        environment,
        custody_wallet_id,
        created_at DESC,
        id DESC
    )
    WHERE activated_at IS NOT NULL AND closed_at IS NULL;

-- Complement the narrow-wallet index above for pages spanning many custody
-- rows: ORDER BY can stream globally before applying the wallet-array filter.
-- This also serves the kind-neutral workspace-wide question ("what does this
-- organization hold"): `custody_wallet_id` is the LAST column, so the leading
-- (organization_id, environment, created_at DESC, id DESC) prefix answers it
-- without a second index over exactly that prefix.
CREATE INDEX IF NOT EXISTS idx_earn_positions_created_wallet
    ON earn_positions(
        organization_id,
        environment,
        created_at DESC,
        id DESC,
        custody_wallet_id
    )
    WHERE activated_at IS NOT NULL AND closed_at IS NULL;


-- ───────────────────────────────────────────────────────────────────────────
-- 3. The ledger: every money movement Earn records.
--
-- ADR 0002's rule stands — SDP ledgers what SDP INITIATES; SDP reads live what
-- the provider observes — and this is where everything SDP initiates lands,
-- whichever way it was executed. Customer-initiated custodial deposits remain
-- unledgered because SDP has no intent moment for them; nothing here changes
-- that, and when an observed-deposit feed is built it writes rows HERE.
--
-- Exactly one authoritative row per real-world movement. The row id is the
-- LEGACY row's id for anything migrated or dual-written from 0055/0059, so the
-- switch of every read is invisible on the wire and the backfill in 0063 is
-- idempotent against rows the application already mirrored.
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS earn_movements (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    -- Initiating project attribution; history survives project deletion.
    --
    -- Nullable with ON DELETE SET NULL, following 0059 and deliberately NOT
    -- 0055, whose cascade meant deleting a project DESTROYED its withdrawal
    -- history. An audit ledger outlives the project that provisioned the call.
    project_id TEXT,
    environment TEXT NOT NULL,
    provider TEXT NOT NULL,
    execution_model TEXT NOT NULL,
    direction TEXT NOT NULL,
    -- Every movement belongs to exactly one holding, both models alike. This is
    -- what makes per-position history, the treasury overview and the movement
    -- feed one table scan instead of a union over mechanism-shaped tables.
    position_id TEXT NOT NULL,

    status TEXT NOT NULL,
    failure_reason TEXT,
    -- Optimistic chain commitment time (vault only). Kept distinct from
    -- settlement because they are distinct events; see the status vocabulary.
    confirmed_at TEXT,
    -- Success-terminal time, one meaning across SDP: finalization for a vault
    -- movement, provider completion for a custodial one.
    settled_at TEXT,

    -- ─ Money. Explicit units, never mixed ─
    --
    -- The concrete accounting hazard this unification could have introduced is
    -- USD, mint units and vault shares sharing a column. They do not:
    --   * every `amount_*`/`fee_*` figure is denominated in `denomination`,
    --   * share quantities live ONLY in the two share-named columns.
    -- 'usd' is the legacy custodial denomination (0055's portfolio vocabulary);
    -- a vault movement is denominated in its token MINT. An open set, so a new
    -- asset is never a migration.
    denomination TEXT NOT NULL,
    amount_requested TEXT NOT NULL,
    -- What actually moved, once known. The provider (custodial) or the chain
    -- (vault) is authoritative; NULL until then.
    amount_settled TEXT,
    fee_amount TEXT,
    -- Slippage floor and the shares the chain actually minted or burned, in
    -- SHARE units — structurally separate from the amount columns above so no
    -- query can add a share count to a token amount.
    min_shares_out TEXT,
    shares_out TEXT,
    -- 0055's `token`: the payout stablecoin as a provider-neutral lowercase
    -- symbol ('usdc'|'usdt'). A legacy custodial concept kept for wire
    -- compatibility, and NOT the asset identity — `denomination` is.
    payout_token TEXT,

    -- ─ Parties and chain facts ─
    custody_wallet_id TEXT,
    vault_address TEXT,
    -- Chain facts, and the columns a counterparty view filters on: who sent the
    -- money in, where it went out. NULL wherever SDP never observed one.
    source_address TEXT,
    destination_address TEXT,

    -- ─ External correlation ─
    --
    -- The provider's id for THIS MOVEMENT (0055's withdrawalRef) — and nothing
    -- else. A row without one is an unresolved intent: healed by a same-key
    -- retry or an observation sweep, never by fuzzy matching.
    provider_reference TEXT,
    -- Signed outbox payload (vault only), recorded atomically with the movement
    -- and the position's activation before the bytes can reach the network.
    -- Enough for a reconciler to query the exact signature and, while its
    -- blockhash remains valid, rebroadcast the same transaction without
    -- re-signing.
    signature TEXT,
    signed_transaction TEXT,
    last_valid_block_height NUMERIC,

    -- ─ Idempotency ─
    --
    -- request_id keeps its per-model meaning, byte for byte:
    --   custodial    a DERIVED provider request id (deriveProviderRequestId),
    --                which the provider ALSO dedupes on.
    --   vault_direct the caller's raw Idempotency-Key, which is additionally
    --                published on chain in the deposit's memo.
    -- Both anchors survive as partial unique indexes below. Neither the
    -- derivation nor either fingerprint builder changes here: the values are
    -- persisted in wallet_operations.raw_payload.executionRequest, so altering
    -- one would 409 every in-flight approved retry across a deploy.
    request_id TEXT NOT NULL,
    -- Canonical fingerprint of the request that wrote this row, so a replay
    -- compares INTENT rather than just the key and a reused key with a
    -- different payload answers 409 instead of returning the original
    -- movement's signature. NOT NULL for both models (0055/0059's shared rule):
    -- a NULL would read as "unclaimed" to resolveIdempotencyReplay and turn the
    -- replay backstop into an unrecoverable unique violation.
    idempotency_fingerprint TEXT NOT NULL,

    -- Provider observations, for drift forensics. Explicitly NOT authoritative
    -- for anything: no read may take a balance, an amount or a status from it.
    provider_data JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Who moved the money: a dashboard human, an API key, or both absent for a
    -- system-initiated observation.
    created_by TEXT,
    initiated_by_key_id TEXT,

    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
    FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id),
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (direction) REFERENCES earn_movement_directions(id),
    -- The (model, status) PAIR, not two independent FKs: this is what makes a
    -- custodial-only status unrepresentable on a vault movement, and it makes
    -- `execution_model` transitively valid without a second constraint.
    FOREIGN KEY (execution_model, status)
        REFERENCES earn_movement_statuses(execution_model, status),

    -- Tenancy consistency with the parent holding, for EVERY row: a movement
    -- cannot name a position in another org, environment or provider. 0055 had
    -- no equivalent — nothing at the DB level stopped a withdrawal row from
    -- naming a wallet in another organization.
    FOREIGN KEY (position_id, organization_id, environment, provider)
        REFERENCES earn_positions(id, organization_id, environment, provider),
    -- 0059's exact-claim guarantee, carried across undegraded rather than
    -- weakened to a bare position_id. MATCH SIMPLE (the default) skips the
    -- constraint while any column is NULL, which is precisely the custodial
    -- shape — so vault rows are pinned to their exact claim and custodial rows
    -- are governed by the tenancy FK above.
    FOREIGN KEY (position_id, organization_id, environment, provider, vault_address, custody_wallet_id)
        REFERENCES earn_positions(
            id,
            organization_id,
            environment,
            provider,
            vault_address,
            custody_wallet_id
        ),

    CONSTRAINT earn_movements_environment_check
        CHECK (environment IN ('sandbox', 'production')),
    CONSTRAINT earn_movements_provider_data_is_object
        CHECK (jsonb_typeof(provider_data) = 'object'),

    -- Exactly one shape per row. The vault half is 0059's NOT NULL set, which
    -- is what makes record-before-broadcast enforceable rather than merely
    -- intended; the custodial half asserts the absence of every column that
    -- only signed execution can produce.
    CONSTRAINT earn_movements_model_shape_check
        CHECK (
            (
                execution_model = 'vault_direct'
                AND custody_wallet_id IS NOT NULL
                AND vault_address IS NOT NULL
                AND signature IS NOT NULL
                AND signed_transaction IS NOT NULL
                AND last_valid_block_height IS NOT NULL
                AND payout_token IS NULL
                AND fee_amount IS NULL
            )
            OR (
                execution_model = 'custodial'
                AND custody_wallet_id IS NULL
                AND vault_address IS NULL
                AND signature IS NULL
                AND signed_transaction IS NULL
                AND last_valid_block_height IS NULL
                AND min_shares_out IS NULL
                AND shares_out IS NULL
            )
        ),

    -- Chain commitment time exists exactly for the states that have one. Both
    -- confirmed and finalized carry it: finalization does not erase the earlier
    -- commitment, it supersedes it.
    --
    -- This is a BICONDITIONAL, and `EARN_MOVEMENT_TRANSITIONS` is written to
    -- respect it rather than fight it. Two consequences, both deliberate:
    --
    -- * There is no `confirmed -> failed` transition. Recording one would mean
    --   NULLing `confirmed_at` (and `shares_out` below) — erasing two chain
    --   facts SDP genuinely observed, and making "failed before landing"
    --   indistinguishable from "landed, then dropped in a fork". The realistic
    --   chain path never asks for it: an execution error is reported with the
    --   FIRST status for a signature, not after a clean one. The remaining
    --   tail — a confirmed transaction dropped by a fork rollback — stays in
    --   the reconciliation queue as an open question rather than being declared
    --   failed on a guess, which is the only answer that keeps the observation.
    -- * `submitted -> finalized` is legal, and its writer stamps `confirmed_at`
    --   on the way through. That is not an invented observation: finalized
    --   strictly implies committed, so the column states a fact the chain
    --   asserts, and the alternative is a settled row with no record of its own
    --   commitment.
    CONSTRAINT earn_movements_confirmation_metadata_check
        CHECK (
            execution_model <> 'vault_direct'
            OR (
                (status IN ('confirmed', 'finalized'))
                = (NULLIF(BTRIM(confirmed_at), '') IS NOT NULL)
            )
        ),
    -- Settlement time exists exactly when a vault movement is finalized. The
    -- custodial side is left unconstrained on purpose: its completed_at is
    -- written from whatever the provider reports, with no constraint in 0055,
    -- and adding one here would turn an observation that succeeds today into a
    -- rolled-back write.
    CONSTRAINT earn_movements_settlement_metadata_check
        CHECK (
            execution_model <> 'vault_direct'
            OR ((status = 'finalized') = (NULLIF(BTRIM(settled_at), '') IS NOT NULL))
        ),
    CONSTRAINT earn_movements_failure_metadata_check
        CHECK (
            execution_model <> 'vault_direct'
            OR ((status = 'failed') = (NULLIF(BTRIM(failure_reason), '') IS NOT NULL))
        ),

    -- Amount formats. Requested is always SDP-validated before it reaches the
    -- DB, on both models, so it is checked for both.
    CONSTRAINT earn_movements_amount_requested_format_check
        CHECK (
            LENGTH(amount_requested) BETWEEN 1 AND 128
            AND amount_requested ~ '^\d+(\.\d+)?$'
            AND amount_requested ~ '[1-9]'
        ),
    -- Settled amounts and fees are PROVIDER-REPORTED on the custodial side, and
    -- 0055 never constrained them: a provider legitimately answers "0", and a
    -- JSON number small enough serializes as '1e-7'. Enforcing the vault
    -- format here would make a currently-successful observation fail, so the
    -- strict rule applies only where 0059 already proved it safe. Tightening
    -- the custodial side is a later change, after the real values are surveyed.
    CONSTRAINT earn_movements_settled_amount_format_check
        CHECK (
            amount_settled IS NULL
            OR LENGTH(amount_settled) BETWEEN 1 AND 128
        ),
    CONSTRAINT earn_movements_fee_amount_format_check
        CHECK (
            fee_amount IS NULL
            OR LENGTH(fee_amount) BETWEEN 1 AND 128
        ),
    CONSTRAINT earn_movements_vault_amount_format_check
        CHECK (
            execution_model <> 'vault_direct'
            OR (
                (
                    amount_settled IS NULL
                    OR (
                        amount_settled ~ '^\d+(\.\d+)?$'
                        AND amount_settled ~ '[1-9]'
                    )
                )
                AND (
                    min_shares_out IS NULL
                    OR (
                        LENGTH(min_shares_out) BETWEEN 1 AND 128
                        AND min_shares_out ~ '^\d+(\.\d+)?$'
                        AND min_shares_out ~ '[1-9]'
                    )
                )
            )
        ),
    -- Shares are what the chain minted or burned, so they exist only once the
    -- chain has spoken. Kept to the commitment states for the same reason as
    -- `confirmed_at` above: no legal transition leaves a movement that observed
    -- a share count in a status that may not hold one.
    CONSTRAINT earn_movements_shares_out_format_check
        CHECK (
            shares_out IS NULL
            OR (
                status IN ('confirmed', 'finalized')
                AND LENGTH(shares_out) BETWEEN 1 AND 128
                AND shares_out ~ '^\d+(\.\d+)?$'
                AND shares_out ~ '[1-9]'
            )
        ),
    CONSTRAINT earn_movements_denomination_check
        CHECK (LENGTH(BTRIM(denomination)) BETWEEN 1 AND 128),
    CONSTRAINT earn_movements_last_valid_block_height_check
        CHECK (
            last_valid_block_height IS NULL
            OR (
                last_valid_block_height = TRUNC(last_valid_block_height)
                AND last_valid_block_height BETWEEN 0 AND 18446744073709551615
            )
        )
);

-- ── Idempotency anchors: BOTH legacy scopes, unchanged ────────────────────
--
-- Flattening these to one anchor would break whichever side lost, so each
-- survives as a partial unique index over its own model's rows.
--
-- Custodial: keyed on the POSITION, which is 0055's wallet scope expressed in
-- the new shape — a custodial position is 1:1 with its program wallet. Sibling
-- projects in one environment share the wallet and derive the SAME request id
-- for the same caller key, so a narrower (org, project) anchor would let the
-- second project miss the replay row, insert a duplicate intent, and strand it
-- on the provider_reference unique below.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_movements_custodial_request
    ON earn_movements(position_id, request_id)
    WHERE execution_model = 'custodial';

-- Vault: ORG-scoped, not position-scoped, on purpose (0059) — a retry that
-- resolves to a DIFFERENT position (the caller corrected the vault) is a
-- different request and must not silently reuse the key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_movements_vault_request
    ON earn_movements(organization_id, request_id)
    WHERE execution_model = 'vault_direct';

-- Settlement correlation for poll/sweep/webhook observation writes. Global
-- (not tenant-scoped) like 0055's, so a system-scope lookup needs no
-- org/project; callers assert organization_id after the fetch.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_movements_provider_reference
    ON earn_movements(provider, provider_reference)
    WHERE provider_reference IS NOT NULL;

-- Chain correlation for the confirmation sweep.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_movements_signature
    ON earn_movements(signature)
    WHERE signature IS NOT NULL;

-- ── Read paths ────────────────────────────────────────────────────────────
--
-- Movements are a low-write, high-question table: the treasury overview, the
-- B2B2X counterparty views, per-position drill-downs and the reconciler all
-- ask different questions of the same rows, so each gets its index. id joins
-- created_at as the deterministic pagination tiebreaker throughout (the lesson
-- of payment_transfers 0028-0031 and 0048).

-- "Everything that moved in this workspace", newest first.
CREATE INDEX IF NOT EXISTS idx_earn_movements_workspace_created
    ON earn_movements(organization_id, environment, created_at DESC, id DESC);

-- "All deposits" / "all withdrawals" for the same workspace.
CREATE INDEX IF NOT EXISTS idx_earn_movements_direction_created
    ON earn_movements(organization_id, environment, direction, created_at DESC, id DESC);

-- One holding's history — the drill-down behind every position row.
CREATE INDEX IF NOT EXISTS idx_earn_movements_position_created
    ON earn_movements(position_id, created_at DESC, id DESC);

-- Counterparty lookups: "every deposit that came from this address", "every
-- payout that went to this one". Partial because most rows carry neither.
CREATE INDEX IF NOT EXISTS idx_earn_movements_source_address
    ON earn_movements(organization_id, environment, source_address, created_at DESC, id DESC)
    WHERE source_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_earn_movements_destination_address
    ON earn_movements(organization_id, environment, destination_address, created_at DESC, id DESC)
    WHERE destination_address IS NOT NULL;

-- Hot existence probe for active-list defence and failed-attempt cleanup: does
-- this position still have live evidence? Includes `finalized`, which the
-- 0059 predicate could not name.
CREATE INDEX IF NOT EXISTS idx_earn_movements_position_live_evidence
    ON earn_movements(position_id)
    WHERE status IN ('requested', 'submitted', 'confirmed', 'finalized');

-- The reconciliation sweep's work queue: every signed row without an
-- IRREVERSIBLE outcome. `confirmed` belongs in it now — the sweep's job did not
-- end at commitment once finalization became the terminal state — and so does
-- `requested`, because a broadcast timeout or crash leaves a row unsubmitted
-- WITH a signature, which is precisely the ambiguous case reconciliation is
-- for.
CREATE INDEX IF NOT EXISTS idx_earn_movements_unsettled
    ON earn_movements(created_at ASC, id ASC)
    WHERE execution_model = 'vault_direct'
      AND status IN ('requested', 'submitted', 'confirmed');
