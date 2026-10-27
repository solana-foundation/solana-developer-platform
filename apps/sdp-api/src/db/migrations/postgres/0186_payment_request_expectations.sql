-- Payment request expectations and the transactions SDP issues to pay them
-- (ADR 0012).
--
-- A request stores what its destination must receive: the credit in base
-- units, with the asset and the decimals its terms had at creation. It is an
-- expectation, not a movement: /pay quotes the payer's debit and the transfer
-- fee under the terms it reads, so the payer pays the current fee and the
-- destination gets exactly the credit. `amount` stays the credit in token
-- units. A request written before this migration, or by the previous revision
-- while it still serves, has no expectation: /pay parses its amount at the
-- decimals it reads, as before.
--
-- payment_request_transactions holds each sponsored transaction /pay issues,
-- one row per claim window, with the quote it moves. The row is written with
-- the claim; the sponsor is the fee payer and signs first, so its signature,
-- the transaction id, is saved when SDP signs. When the reference scan finds
-- one of these signatures, settlement takes the window's quote, and /pay
-- issues no new window while a signed one can still land.
--
-- A window is `open` until its signature lands (`landed`), lands with an error
-- (`failed`), or has no record once the chain is past the last valid block
-- height of its blockhash (`lapsed`): then it can never land. A claim whose
-- signature was never saved never left SDP signed, so it cannot land either.
--
-- The CHECKs on payment_requests are added NOT VALID: rows written before them
-- are not scanned, and every new or updated row is checked.

ALTER TABLE payment_requests
    ADD COLUMN IF NOT EXISTS asset_kind TEXT,
    ADD COLUMN IF NOT EXISTS mint TEXT,
    ADD COLUMN IF NOT EXISTS token_program TEXT,
    ADD COLUMN IF NOT EXISTS decimals SMALLINT,
    ADD COLUMN IF NOT EXISTS expected_credit sdp_u64;

-- All of the expectation or none of it. Native SOL has 9 decimals and no mint;
-- a token names its mint and program. `amount` is the credit in token units.
ALTER TABLE payment_requests
    ADD CONSTRAINT payment_requests_expectation_shape CHECK (
        num_nulls(asset_kind, decimals, expected_credit) IN (0, 3)
        AND (asset_kind IS NULL OR asset_kind IN ('native', 'token'))
        AND (token_program IS NULL OR token_program IN ('spl-token', 'token-2022'))
        AND (mint IS NULL) = (token_program IS NULL)
        AND (COALESCE(asset_kind, '') = 'token') = (mint IS NOT NULL)
        AND (asset_kind IS DISTINCT FROM 'native' OR decimals = 9)
        AND (decimals IS NULL OR decimals BETWEEN 0 AND 255)
        AND (expected_credit IS NULL OR expected_credit > 0)
        AND CASE
            WHEN expected_credit IS NULL THEN TRUE
            ELSE amount::numeric * power(10::numeric, decimals) = expected_credit
        END
    ) NOT VALID;

CREATE TABLE payment_request_transactions (
    id TEXT PRIMARY KEY,
    payment_request_id TEXT NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- The account that pays and signs client-side.
    payer TEXT NOT NULL,
    -- The claimed bytes the sponsor signs; the request row holds the same claim.
    unsigned_transaction TEXT NOT NULL,
    last_valid_block_height sdp_u64 NOT NULL,
    -- The sponsor's signature, the transaction id; null until SDP signs.
    signature TEXT UNIQUE,
    -- The quote the transaction moves, as token_movement_legs stores one.
    asset_kind TEXT NOT NULL CHECK (asset_kind IN ('native', 'token')),
    mint TEXT,
    token_program TEXT CHECK (token_program IN ('spl-token', 'token-2022')),
    decimals SMALLINT NOT NULL CHECK (decimals BETWEEN 0 AND 255),
    basis TEXT NOT NULL CHECK (basis = 'credit'),
    quoted_debit sdp_u64 NOT NULL,
    quoted_fee sdp_u64 NOT NULL,
    quoted_credit sdp_u64 NOT NULL,
    fee_epoch sdp_u64,
    as_of_slot sdp_u64,
    as_of_unix_timestamp BIGINT,
    outcome TEXT NOT NULL DEFAULT 'open'
        CHECK (outcome IN ('open', 'landed', 'failed', 'lapsed')),
    -- The slot the signature's status reported; set with a `landed` or `failed` outcome.
    landed_slot sdp_u64,
    -- Soft delete only: a window is archived, never deleted. Every read takes
    -- active windows; its outcome is separate.
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    CONSTRAINT payment_request_transactions_signed_outcome
        CHECK (outcome = 'open' OR signature IS NOT NULL),
    CONSTRAINT payment_request_transactions_landed_slot
        CHECK ((landed_slot IS NOT NULL) = (outcome IN ('landed', 'failed'))),
    CONSTRAINT payment_request_transactions_asset CHECK (
        (asset_kind = 'native') = (mint IS NULL)
        AND (mint IS NULL) = (token_program IS NULL)
    ),
    CONSTRAINT payment_request_transactions_native_terms CHECK (
        asset_kind <> 'native'
        OR (decimals = 9 AND quoted_fee = 0 AND fee_epoch IS NULL)
    ),
    CONSTRAINT payment_request_transactions_terms_read CHECK (
        (as_of_slot IS NULL) = (as_of_unix_timestamp IS NULL)
        AND (asset_kind = 'native') = (as_of_slot IS NULL)
    ),
    CONSTRAINT payment_request_transactions_quote_splits
        CHECK (quoted_debit = quoted_credit + quoted_fee),
    CONSTRAINT payment_request_transactions_quote_credits CHECK (quoted_credit > 0)
);

-- One claim per unsigned transaction: the store step finds its window by it.
CREATE UNIQUE INDEX payment_request_transactions_claim
    ON payment_request_transactions (payment_request_id, unsigned_transaction);

-- Settlement reads a request's active signed windows that are still open.
CREATE INDEX payment_request_transactions_open
    ON payment_request_transactions (payment_request_id)
    WHERE outcome = 'open' AND signature IS NOT NULL AND status = 'active';

ALTER TABLE payment_request_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_request_transactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_tenant_isolation ON payment_request_transactions;
CREATE POLICY sdp_tenant_isolation ON payment_request_transactions
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));
