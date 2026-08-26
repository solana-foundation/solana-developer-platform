# Repositories — rules that bind every writer here

This directory holds the SQL. The invariants that constrain it are documented
next to the routes that consume it, which means they are easy to miss from
here — this file exists to point at the ones that will break money movement if
you don't know them.

## Earn: one movement ledger, one writer

`earn_movements` is the single authoritative record of every Earn money
movement — both directions, both execution models — and `earn_positions` is the
single holdings table behind it (PRO-1705). `earn-movements.repository.ts` is
the ONLY writer of either. The mechanism-split predecessors
(`earn_program_withdrawals`, `earn_vault_movements`, `earn_vault_positions`) no
longer have writers, and their code is retired.

Things that will bite:

- **Legal source states come from `EARN_MOVEMENT_TRANSITIONS` (`@sdp/types`),
  never from the caller.** Terminal regression is unrepresentable rather than
  merely refused. The guard is applied as a compare-and-swap in the same
  statement as the write, so a concurrent writer that already advanced a row
  makes the loser match zero rows instead of overwriting it. A transition from an
  illegal state returns NULL — the same answer a lost race gives.
- **The matrix agrees with migration 0062's CHECK constraints, not merely with
  itself.** There is no `confirmed → failed`: the schema ties `confirmed_at` and
  `shares_out` to the commitment states, so recording it could only succeed by
  erasing an observation SDP made. Do not add a transition without checking the
  constraint it would have to violate.
- **`earn_positions.share_ata_rent_funder` is a PROJECTION, never assigned
  directly** (migrations 0066 + 0067). Each vault movement records on its OWN row
  whether it was observed to create the share account and who it charged
  (`creates_share_account`, `share_ata_rent_funder`), and the position column is
  recomputed by `projectShareAccountRentFunder`: the newest claim that has not
  failed. Both directions claim (an exit consolidating auxiliary accounts can
  create the ATA itself), a movement that lost its idempotency insert has no row
  to contribute, and `advanceVaultMovement` re-projects on failure so a claim
  cannot outlive a transaction that never landed. Do not write the position
  column by hand: a direct write is exactly the unrepairable stale attribution
  the projection exists to prevent. It is authoritative only while the share
  account exists, which is the only window anything reads it.
- **Every movement needs a holding, and a missing one must never fail a money
  write.** Resolve or open the holding before writing the movement. The custodial
  holding for a program is minted when its provider wallet is linked.
- **Amounts carry a `denomination`** (`usd`, the token mint, or the SHARE mint
  on a vault withdrawal, whose exact intent-time quantity is shares). No read
  may sum across rows without grouping by denomination.
- **A vault withdrawal is one signed movement.** The movement owns the requested
  shares, actor, idempotency key, signature, signed bytes and blockhash window.
  It is recorded before broadcast and reconciled through the same outbox path
  as a vault deposit.
- **Ids are heterogeneous by design.** History keeps the ids the projection
  preserved, so nothing may parse an id for its kind — read `execution_model`.

The full rule set is in [`../../routes/earn/CLAUDE.md`](../../routes/earn/CLAUDE.md).
Architecture and the migration inventory are in
[`packages/sdp-earn/README.md`](../../../../../packages/sdp-earn/README.md);
invariants are in ADR 0002 (`docs/decisions/0002-earn-provider-pluggability.md`).
