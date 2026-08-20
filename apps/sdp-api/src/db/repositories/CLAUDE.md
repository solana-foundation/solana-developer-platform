# Repositories — rules that bind every writer here

This directory holds the SQL. The invariants that constrain it are documented
next to the routes that consume it, which means they are easy to miss from
here — this file exists to point at the ones that will break money movement if
you don't know them.

## Earn: two movement shapes exist right now, and every writer must feed both

Earn is mid-migration (PRO-1705, migrations `0062`-`0064`) from two movement
tables split by execution mechanism to one unified ledger.

**If you add or change a writer of `earn_program_withdrawals`,
`earn_vault_movements` or `earn_vault_positions`, it MUST mirror into
`earn_movements` / `earn_positions` in the SAME transaction.** Call the
projection functions in `earn-movements.repository.ts`; never hand-write an
insert into the unified tables. The mapping lives in SQL views created by `0063`
and is shared with the bulk backfill, so history and new rows cannot disagree.

Two traps worth stating outright:

- `INSERT ... SELECT` from a projection view that yields nothing inserts zero
  rows and **succeeds**. A money movement can be dropped with no error, so the
  projections assert the row is projectable before writing. Do not "simplify"
  that check away, and do not substitute the mirror's own row count for it —
  zero rows is also the legitimate answer when the finalization guard declines.
- Every movement needs a holding, so project the HOLDING before the movement on
  every path, including replays and non-terminal transitions.

The full rule set, including what `finalized` protects and why the vault
transition guard still speaks the legacy vocabulary, is in
[`../../routes/earn/CLAUDE.md`](../../routes/earn/CLAUDE.md). Architecture and
the migration inventory are in
[`packages/sdp-earn/README.md`](../../../../../packages/sdp-earn/README.md);
invariants are in ADR 0002 (`docs/decisions/0002-earn-provider-pluggability.md`).
