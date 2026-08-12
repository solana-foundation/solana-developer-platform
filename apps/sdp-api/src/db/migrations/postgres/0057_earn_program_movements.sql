-- Solana Earn: one canonical money-movement ledger (PRO-1669,
-- ADR 0002 addendum "Every money movement is ledgered; the observer is pluggable").
--
-- Decision: SDP ledgers EVERY money movement -- what it initiates, at intent;
-- what it observes, at observation. 0055 covered only the initiated half, because
-- its addendum concluded that having no intent moment for a customer-initiated
-- transfer meant SDP could hold no record of one. Those are separate questions,
-- and the answer to the second is the provider's own deposits feed -- an
-- observation SDP already makes on every dashboard poll and then discards.
--
-- 0055 stays as applied history; this migration is forward-only, the same rule
-- 0055 and 0056 both followed. It is transactional (no non-transactional
-- directive), so the whole rename/relax/re-constrain sequence takes or rolls back
-- whole, and every existing row is preserved with its id.
--
-- WHY ONE TABLE AND NOT A SECOND ONE:
-- * 0055's own header cites the payment_transfers precedent -- and that table is
--   a SINGLE table with `direction` carrying both legs (0001), with one `type`
--   column spanning self-initiated transfers and provider-mediated ramp legs.
--   Splitting by direction would make earn the only money domain in SDP that does.
-- * 0048's earn_movements already chose this discriminator ("deposits AND
--   withdrawals live in one movements ledger, discriminated by direction").
--   0055 dropped it for its GRAIN -- position-scoped, base-unit amounts, no
--   writer -- never for unifying the directions. This is program-scoped, USD
--   decimal strings, and has writers on day one. It is not that table's
--   resurrection, and the pruned top-level /v1/earn/movements route stays 404.
-- * The deposit status vocabulary (processing/completed/failed) is a strict
--   SUBSET of the seven values 0055 already allows, so one status column serves
--   both directions with NO new CHECK value and no revalidation scan. The most
--   commonly cited cost of unifying does not exist here, and @sdp/types pins the
--   subset relationship at compile time.
--
-- OBSERVATION SOURCE IS PLUGGABLE BY DESIGN, AND THAT IS THE POINT.
-- A row records that money moved; `observed_via` records which MECHANISM told us.
--   1. now         provider-API polling (cron/earn-deposit-sweep.ts) plus a
--                  best-effort write from the live deposits read
--   2. next        provider webhooks (PRO-1631, Ground HMAC)
--   3. eventually  an SDP indexer reading Solana directly -- the DESIRED end
--                  state, because it takes a third party out of the path of SDP's
--                  own audit trail and sees arrivals at chain finality rather
--                  than at the provider's detection latency
-- All three write THIS row through the same applier, and no transition matrix
-- branches on the source. `observed_via` is open TEXT with NO CHECK CONSTRAINT --
-- deliberately unlike `status` -- because a check would make adding the third
-- observer a migration, which is precisely the coupling this design removes.
-- Allowed values live in the code registry (EARN_MOVEMENT_OBSERVATION_SOURCES),
-- the same drift rule `provider` follows (ADR 0001/0002, 0055's header).
-- The interim poller is expected to become a backstop and then be deleted;
-- nothing downstream may assume the poller is the writer.

ALTER TABLE earn_program_withdrawals RENAME TO earn_program_movements;

-- PostgreSQL renames NEITHER constraints NOR indexes with the table, so each is
-- renamed explicitly; otherwise the schema keeps ..._withdrawals_... objects
-- hanging off a movements table forever and a failed CHECK reports the wrong
-- table to whoever is reading the error. Names below are 0055's two explicit
-- CHECKs plus PostgreSQL's conventional auto-names, verified against an applied
-- database before this migration was written. Renaming the PK constraint renames
-- its index with it; the three remaining indexes are all being replaced outright
-- below, so no ALTER INDEX ... RENAME is needed anywhere.
ALTER TABLE earn_program_movements
    RENAME CONSTRAINT earn_program_withdrawals_pkey TO earn_program_movements_pkey;
ALTER TABLE earn_program_movements
    RENAME CONSTRAINT earn_program_withdrawals_organization_id_fkey
                   TO earn_program_movements_organization_id_fkey;
ALTER TABLE earn_program_movements
    RENAME CONSTRAINT earn_program_withdrawals_project_id_fkey
                   TO earn_program_movements_project_id_fkey;
ALTER TABLE earn_program_movements
    RENAME CONSTRAINT earn_program_withdrawals_wallet_id_fkey
                   TO earn_program_movements_wallet_id_fkey;
ALTER TABLE earn_program_movements
    RENAME CONSTRAINT earn_program_withdrawals_created_by_fkey
                   TO earn_program_movements_created_by_fkey;
ALTER TABLE earn_program_movements
    RENAME CONSTRAINT earn_program_withdrawals_provider_data_is_object
                   TO earn_program_movements_provider_data_is_object;
-- The status CHECK's VALUE LIST is unchanged -- only its name moves.
ALTER TABLE earn_program_movements
    RENAME CONSTRAINT earn_program_withdrawals_status_check
                   TO earn_program_movements_status_check;

-- direction: the DEFAULT backfills every existing row -- all of which ARE
-- withdrawals, because this table has never had another writer -- and is then
-- dropped, so no future insert can acquire a direction implicitly.
ALTER TABLE earn_program_movements
    ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'withdrawal';
ALTER TABLE earn_program_movements ALTER COLUMN direction DROP DEFAULT;

ALTER TABLE earn_program_movements
    -- When the MONEY MOVED, as distinct from when SDP wrote the row (created_at).
    -- For an initiated movement these are the same instant, which is why the
    -- backfill below is exact. For an observed one they are structurally
    -- different, and conflating them would:
    --   * make the ledger's ordering key depend on cron health,
    --   * put an indexer backfill of January deposits at the top of a list,
    --   * misattribute a reporting period by exactly the observation lag,
    --     breaking the "delta balance minus net movements = earnings" identity at
    --     every period boundary (PRO-1672).
    -- The gap between occurred_at and created_at is also the only honest measure
    -- of observation lag.
    --
    -- WRITE-ONCE: no applier may update it. Every list and window sorts on it, and
    -- a mutable sort key re-shuffles pages under a reader (0056's header owns that
    -- lesson). Deliberately NO DEFAULT even though it ends up NOT NULL: a default
    -- would let a forgetful deposit writer silently record "now" instead of the
    -- movement's own time, which is the exact bug this column exists to prevent.
    -- The intent path names sdp_iso_now() inline in its INSERT instead, so
    -- DB-stamping is preserved without making the mistake cheap.
    --
    -- Provider timestamps MUST be normalized to the fixed-width shape
    -- sdp_iso_now() emits (0001: YYYY-MM-DDTHH24:MI:SS.MSZ) before they are
    -- written here. TEXT timestamps sort lexicographically, so a provider sending
    -- "2026-08-12T00:00:00Z" (no milliseconds) or an offset would silently corrupt
    -- both range filters and page ordering.
    ADD COLUMN IF NOT EXISTS occurred_at TEXT,
    -- Which MECHANISM reported this row's current state. Open TEXT, no CHECK --
    -- see the header. Written once at insert and overwritten by each observation;
    -- the DISCOVERING mechanism is preserved in provider_data.discoveredVia, which
    -- the shallow JSONB merge never clobbers.
    ADD COLUMN IF NOT EXISTS observed_via TEXT NOT NULL DEFAULT 'sdp_intent',
    -- A movement has two ends. destination_address was the only one a withdrawal
    -- needed; a deposit needs the other. Kept as two columns rather than collapsed
    -- into one "external address" because an indexer observing a deposit knows the
    -- sender AND the program's funding address, and an execution-era SDP-initiated
    -- deposit would carry both too.
    ADD COLUMN IF NOT EXISTS source_address TEXT,
    -- On-chain identifiers. Deliberately NO `chain` column: ADR 0002 invariant 5
    -- means SDP surfaces the Solana rail only, and the provider client already
    -- withholds a foreign rail's identifiers while still surfacing the deposit's
    -- VALUE. An off-rail deposit therefore lands with these NULL and its raw
    -- payload in provider_data; a `chain` column would invite another rail onto
    -- the wire.
    ADD COLUMN IF NOT EXISTS transaction_signature TEXT,
    -- Which transfer inside that transaction. NULL from any provider API (none
    -- reports a positional index); populated by the indexer. It exists because a
    -- single transaction may legally contain two SPL transfers to the same funding
    -- address, so a signature ALONE is not a unique movement identity.
    ADD COLUMN IF NOT EXISTS transaction_instruction_index INTEGER;

UPDATE earn_program_movements SET occurred_at = created_at WHERE occurred_at IS NULL;
ALTER TABLE earn_program_movements ALTER COLUMN occurred_at SET NOT NULL;
ALTER TABLE earn_program_movements ALTER COLUMN observed_via DROP DEFAULT;

-- A deposit is a customer-initiated SPL transfer: there is no SDP intent moment
-- and no SDP actor, so request_id / idempotency_fingerprint / destination_address
-- / project_id have no analogue. All are relaxed here and IMMEDIATELY re-imposed
-- conditionally below -- see the constraint block for why that is not a loss of
-- the guarantee 0055 wanted.
--
-- amount_requested_usd joins them, and that split is deliberate. The two amount
-- columns mean INTENT and SETTLED, so a deposit -- which nobody requested -- has
-- no intent figure, and writing its observed amount into a column named
-- "requested" would be a fiction a human later reads as fact (the same objection
-- the ADR's forensics rule makes about project_id and created_by). A deposit
-- therefore carries its amount in amount_paid_usd -- the money that actually
-- moved -- which is also the column any per-period netting sums, so
-- COALESCE(amount_paid_usd, amount_requested_usd) reads correctly for BOTH
-- directions with no direction branch in the query.
ALTER TABLE earn_program_movements
    ALTER COLUMN request_id DROP NOT NULL,
    ALTER COLUMN idempotency_fingerprint DROP NOT NULL,
    ALTER COLUMN destination_address DROP NOT NULL,
    ALTER COLUMN project_id DROP NOT NULL,
    ALTER COLUMN amount_requested_usd DROP NOT NULL;

-- ADD CONSTRAINT has no IF NOT EXISTS, so each is dropped first -- the re-runnable
-- form 0013 uses, avoiding the pg_constraint DO-block dance of 0006 and 0021.
ALTER TABLE earn_program_movements
    DROP CONSTRAINT IF EXISTS earn_program_movements_direction_check,
    DROP CONSTRAINT IF EXISTS earn_program_movements_withdrawal_intent_complete,
    DROP CONSTRAINT IF EXISTS earn_program_movements_deposit_has_no_intent,
    DROP CONSTRAINT IF EXISTS earn_program_movements_requested_is_withdrawal_only,
    DROP CONSTRAINT IF EXISTS earn_program_movements_deposit_is_observed,
    DROP CONSTRAINT IF EXISTS earn_program_movements_deposit_amount_present;

ALTER TABLE earn_program_movements
    ADD CONSTRAINT earn_program_movements_direction_check
        CHECK (direction IN ('deposit', 'withdrawal')),

    -- THIS is what replaces the four relaxed NOT NULLs, and it is strictly
    -- stronger than what 0055 had. 0055's NOT NULL made "a withdrawal with a null
    -- fingerprint" unrepresentable so that resolveIdempotencyReplay's "null
    -- fingerprint = unclaimed" branch could never be reached for earn -- a null
    -- row would turn the unique-violation replay backstop into an unrecoverable
    -- 500. This preserves that property EXACTLY for the direction that has an
    -- intent, and the direction that has none cannot reach that code path at all:
    -- the replay lookup queries by request_id, so it can only ever return a
    -- withdrawal. (The TypeScript half of the guarantee is the discriminated row
    -- union in earn.repository.ts, which keeps those fields non-nullable on the
    -- withdrawal arm -- the row TYPE is what resolveIdempotencyReplay reads.)
    ADD CONSTRAINT earn_program_movements_withdrawal_intent_complete
        CHECK (direction <> 'withdrawal'
               OR (request_id IS NOT NULL
                   AND idempotency_fingerprint IS NOT NULL
                   AND destination_address IS NOT NULL
                   AND project_id IS NOT NULL
                   AND amount_requested_usd IS NOT NULL)),

    -- The other half of the amount split: a deposit always knows what moved from
    -- its first observation, so the settled column is required for it. Together
    -- with the constraint above, "every movement carries an amount" stays true
    -- while neither direction carries a figure it never had.
    ADD CONSTRAINT earn_program_movements_deposit_amount_present
        CHECK (direction <> 'deposit' OR amount_paid_usd IS NOT NULL),

    -- The mirror, so the shape is pinned from both sides: a deposit may not carry
    -- intent columns at all. Without it, a bug could write a deposit with a
    -- request_id and collide with a withdrawal on the intent unique.
    ADD CONSTRAINT earn_program_movements_deposit_has_no_intent
        CHECK (direction <> 'deposit'
               OR (request_id IS NULL AND idempotency_fingerprint IS NULL)),

    -- 'requested' is SDP-only pre-provider intent state. Only a movement SDP
    -- initiates has one; a deposit is born from an observation, and may even be
    -- born TERMINAL (the first poll after it already settled). Two invariants 0055
    -- could express only by omission are now written down.
    ADD CONSTRAINT earn_program_movements_requested_is_withdrawal_only
        CHECK (status <> 'requested' OR direction = 'withdrawal'),

    -- A deposit exists in this ledger only because something observed it, so it
    -- always carries the identifier it was observed BY -- the provider's own
    -- deposit id (always present from a provider API) or an on-chain signature
    -- (from the indexer). This is the deposit-side analogue of "a withdrawal
    -- without a provider_reference is an unresolved intent".
    ADD CONSTRAINT earn_program_movements_deposit_is_observed
        CHECK (direction <> 'deposit'
               OR provider_reference IS NOT NULL
               OR transaction_signature IS NOT NULL);

-- The SDP-intent anchor becomes PARTIAL. Recreated rather than renamed: a WHERE
-- clause cannot be added to an existing index.
--
-- Keyed on `request_id IS NOT NULL` rather than `direction = 'withdrawal'` on
-- purpose -- it is the "one intent row per derived request id per wallet" rule,
-- and it stays true for any future direction that gains an intent. Safe because
-- deriveProviderRequestId mixes the OPERATION NAME into its scope, so a future
-- deposit-intent derivation can never collide with a withdrawal's.
DROP INDEX IF EXISTS idx_earn_program_withdrawals_wallet_request;
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_program_movements_wallet_request
    ON earn_program_movements(wallet_id, request_id)
    WHERE request_id IS NOT NULL;

-- INTERIM IDENTITY, and the observation path's upsert anchor. Still GLOBAL, for
-- 0055's and 0056's reason: provider-side identifiers are not tenant-scoped, and a
-- platform sweep has no organization to key by.
--
-- RECREATED rather than renamed because `direction` must join it. Ground HAPPENS
-- to prefix its ids (dep_/wd_), but the ledger is provider-neutral and must not
-- depend on that: a provider with one id space across both directions would
-- otherwise collide a deposit against a withdrawal and have the second one
-- silently swallowed as a replay. Still partial -- a withdrawal acquires its ref
-- only when the provider accepts the create, while a deposit always has one, and
-- that asymmetry is the constraint's whole point.
DROP INDEX IF EXISTS idx_earn_program_withdrawals_provider_reference;
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_program_movements_provider_reference
    ON earn_program_movements(provider, direction, provider_reference)
    WHERE provider_reference IS NOT NULL;

-- CHAIN IDENTITY, for the indexer end state. Constrains NOTHING today -- no V1
-- observer can fill transaction_instruction_index -- and arms itself the day an
-- indexer writes, with no further migration.
--
-- Deliberately NOT a unique on transaction_signature alone, and NOT on
-- (wallet_id, transaction_signature): one transaction may contain two SPL
-- transfers to the same funding address (a batched payer, a program CPI'ing two
-- transfers), and the provider reports those as TWO deposits sharing one hash. A
-- signature-only unique would reject the second, the sweep's per-row catch would
-- log it, and a real deposit would be silently absent from the ledger. The repo
-- already learned this: private_channel_settlement_observations (0040) keys on
-- (signature, instruction_index) so an operator can batch several releases in one
-- tx without collision. payment_transfers.signature being UNIQUE is not a
-- counter-precedent -- SDP BUILDS those transactions, so one tx is one transfer by
-- construction; earn deposits are customer-built.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_program_movements_chain_identity
    ON earn_program_movements(wallet_id, transaction_signature, transaction_instruction_index)
    WHERE transaction_signature IS NOT NULL AND transaction_instruction_index IS NOT NULL;

-- Cross-source resolution: how an indexer writer finds the row a poller already
-- wrote (and vice versa), plus forensics ("what landed in this transaction?").
-- NOT unique, because it cannot safely be -- dedupe across observers is a service
-- obligation, and pretending otherwise in a constraint would reject real money.
CREATE INDEX IF NOT EXISTS idx_earn_program_movements_wallet_signature
    ON earn_program_movements(wallet_id, transaction_signature)
    WHERE transaction_signature IS NOT NULL;

-- Two list indexes, because one table serves two access patterns, and both order
-- on occurred_at instead of 0055's created_at:
--   * direction-filtered list, and PRO-1672's per-period netting GROUP BY
--     (equality on wallet_id and direction, range on occurred_at -- a bounded
--     index scan, no sort);
--   * the direction-agnostic newest-first list, which cannot use the above
--     because `direction` sits between the equality and the sort key.
-- id joins occurred_at as the deterministic tiebreaker in both -- the lesson 0055,
-- 0056 and payment_transfers 0028-0031 all record, and it bites harder here
-- because one provider page can report several movements with identical
-- timestamps. Honest cost of unifying: split tables would need one index each.
DROP INDEX IF EXISTS idx_earn_program_withdrawals_wallet_created;
CREATE INDEX IF NOT EXISTS idx_earn_program_movements_wallet_direction_occurred
    ON earn_program_movements(wallet_id, direction, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_earn_program_movements_wallet_occurred
    ON earn_program_movements(wallet_id, occurred_at DESC, id DESC);

-- Scan note for the observation sweep: it reads earn_provider_wallets
-- platform-wide filtered on `environment`, which cannot use 0056's
-- (organization_id, environment, created_at, id) index -- that index leads with
-- organization_id and a cross-tenant scan has no organization. At V1 volumes a
-- sequential scan is correct and cheaper than maintaining another index on a table
-- that only grows by explicit program creation. If program count ever reaches
-- thousands, add (environment, created_at, id) THEN -- not now.
