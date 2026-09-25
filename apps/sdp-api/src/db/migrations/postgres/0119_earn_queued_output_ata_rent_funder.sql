-- Solana Earn: queued external exits learn persistent output-ATA rent
-- attribution (SOLA9-228).
--
-- ── What the two columns record ────────────────────────────────────────────
-- A Hastra par-redemption request transaction prepares the owner's persistent
-- intermediate (wYLDS) and asset (USDC) token accounts with idempotent ATA
-- creates so an operator settlement can pay out later. When an output account
-- was absent at build time the create charges the request's rentPayer — a
-- partner fee payer on the external-wallet flow; an account someone else
-- creates in the race before the request lands turns the create into a no-op
-- that charges nothing. The accounts outlive the transaction: after settlement
-- the owner can close them and reclaim the rent. Until now the queued
-- build/request rows kept only `fee_payer`, so the ledger had no durable field
-- from which to refund the partner.
--
-- `creates_output_accounts` states whether the request's plan reported
-- creating any persistent output token account at all.
-- `output_accounts_rent_funder` names the address those creates charged: the
-- partner fee payer when one was named, NULL when the owner funded its own
-- accounts. The pair is the builder's build-time observation — the creates
-- are idempotent, so the reconciliation settles it from the LANDED request
-- transaction and retires a claim whose creates charged the recorded funder
-- nothing. It is the durable refund source for the output accounts' OWN rent,
-- kept deliberately separate from the fulfillment movement's
-- `(creates_share_account, share_ata_rent_funder)` claim: a queued redemption
-- spends an existing holding and never creates the position's share account,
-- so projecting the output funder into the share refund would make a later
-- exit hand the share account's rent to a party that funded another account.
--
-- Both are nullable/defaulted with no backfill: every existing row predates
-- the attribution and correctly reads as "nothing recorded", the same posture
-- migrations 0079 and 0116 took for their own additions.

ALTER TABLE earn_external_wallet_withdrawal_request_transactions
  ADD COLUMN creates_output_accounts boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN output_accounts_rent_funder text NULL;

ALTER TABLE earn_vault_withdrawal_requests
  ADD COLUMN creates_output_accounts boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN output_accounts_rent_funder text NULL;

-- Same shape discipline as 0067's movement-side CHECK: a funder for rent that
-- was never charged is not a weaker claim, it is a false one.
ALTER TABLE earn_external_wallet_withdrawal_request_transactions
  ADD CONSTRAINT earn_external_wallet_queued_output_rent_funder_shape_check
    CHECK (output_accounts_rent_funder IS NULL OR creates_output_accounts);

ALTER TABLE earn_vault_withdrawal_requests
  ADD CONSTRAINT earn_vault_withdrawal_requests_output_rent_funder_shape_check
    CHECK (output_accounts_rent_funder IS NULL OR creates_output_accounts);

-- Same length rule 0079 applies to fee_payer.
ALTER TABLE earn_external_wallet_withdrawal_request_transactions
  ADD CONSTRAINT earn_external_wallet_queued_output_rent_funder_format_check
    CHECK (output_accounts_rent_funder IS NULL OR LENGTH(output_accounts_rent_funder) BETWEEN 32 AND 44);

ALTER TABLE earn_vault_withdrawal_requests
  ADD CONSTRAINT earn_vault_withdrawal_requests_output_rent_funder_format_check
    CHECK (output_accounts_rent_funder IS NULL OR LENGTH(output_accounts_rent_funder) BETWEEN 32 AND 44);
