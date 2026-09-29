# Ondo flow audit and remediation

Reviewed 2026-09-29 against latest fetched `origin/main` at `f31813d81`.
Changes are isolated in `codex/ondo-audit`. Classification: **Critical** because
this change affects transaction composition, balances and settlement recovery.

This is a source review and local regression assessment, not a production
certification or a guarantee against loss. No real funds were moved.

## Flow and trust boundaries

USDY is a token holding. Deposits swap USDC into USDY; withdrawals swap USDY
back into USDC. The primary Ondo issuance/redemption facility is not used.

1. Route admission resolves the strategy, environment, tenant permissions and
   custody wallet or external owner. Anonymous instant builds carry no tenant
   persistence. Presented invalid credentials cannot fall back to anonymous.
2. Ondo requires an explicit output floor. The API's Jupiter boundary admits
   only the pinned aggregator and exact owner ATA creation, checks input/output
   mints, owner accounts, signers, encoded amounts, slippage and zero fees.
3. The complete plan simulates before signing. Custody resolves the scoped
   signer; external submit checks exact message bytes and verifies signatures.
4. Signed bytes and idempotency intent are durable before broadcast. Recovery
   resends those same bytes. Finalized chain evidence drives atomic settlement;
   withdrawal payout accounting uses the receiver's observed token delta.
5. Positions read exact on-chain integers. Holdings and executable withdrawals
   differ when an issuer freezes an account or tokens sit outside the owner ATA.

## Findings addressed

| Severity | Defect | Remediation and evidence |
| --- | --- | --- |
| High | A lost broadcast response can leave a landed swap `requested`. Expiry treated that state as definitely unsent and could mark it permanently failed after one missing status. | Recovery uses finalized height, consults finalized transaction history, and retains uncertain intents for another observation. Recovered receipts use existing guarded settlement. Historical-read errors fail the tick without failing the movement. New regressions initially failed in five cases. |
| Medium | Ondo plans carry a compute limit; swap-funded composition prepended another, making otherwise valid deposits fail. | Replace existing limit instructions with one limit for the entire plan. Preserve other instructions and the approved economic intent. |
| Medium | All USDY accounts were reported as immediately withdrawable, although Jupiter spends only the owner ATA; frozen accounts were included. ATA-rent detection also mistook an auxiliary account for the ATA. | Keep all validated holdings, report only the unfrozen ATA as withdrawable, and detect rent using the exact derived address. |
| Medium | Position reads trusted account identity, state, decimals and uniqueness, permitting malformed or duplicated RPC data to misstate holdings. | Validate the token program, owner, mint, account type/state, six-decimal scale, unique addresses and u64 integer balances. Refuse the whole read when one account is invalid. Twelve new account regressions failed before remediation. |
| Medium | `/order` could quote a router outside the Metis-only `/build` path; numeric JSON amounts could bypass the string check and lose precision. | Request Metis-only quotes, verify the returned router, require integer strings within u64 bounds, and reject zero-output valuations. Tests exercise both real Ondo directions through the production port and reject redirected recipients. |
| Low | APY conversion rounded before truncation and mishandled scientific notation. Mint verification did not check initialization. | Preserve the number's decimal digits using integer arithmetic and require the initialized mint flag. Boundary-rate and uninitialized-mint regressions failed before remediation. |

An uncertain expired `requested` intent advances conservatively to `submitted`
through the existing guarded writer before recording the first absent-signature
observation. This means “awaiting a chain outcome,” not successful settlement.
It preserves migration 0092's constraint without changing the schema. A genuinely
expired intent can take one more sweep to reach `failed`.

## Change-level threat assessment

- **Value touched:** unsigned swap construction, precise balances/quotes, and
  recovery of durable signed intents. No key handling, signer permissions,
  deployment, new dependency, or public API promotion was introduced.
- **Caller authorities:** authenticated custody requests retain wallet policies
  and binding checks. External owners sign exact built messages. The new shared
  changes also affect other Earn callers of the Jupiter and recovery services.
- **External failures:** malformed RPC accounts and incompatible router quotes
  fail closed. Valuation failure retains holdings with unknown value. Missing
  finalized history cannot prove a failed transaction when the read errors.
  Jupiter/DEX execution and RPC history remain external trust assumptions.
- **Compromise impact:** fabricated RPC history could still mislead accounting;
  a compromised Jupiter aggregator/underlying program or issuer authority could
  affect balances or exit availability. Local validation does not eliminate
  these trust assumptions. The output floor bounds execution slippage, not
  issuer default, depegging, freezes, malicious program upgrades or all MEV.

## Validation

The tests use mocked provider/RPC responses and isolated local Postgres/Redis.
The Ondo API-port tests use the actual adapter and instruction validator, with
synthetic route responses. They do not execute a real DEX program.

Validation completed: 446 API/service/route/reconciliation tests across 12 suites,
29 Ondo adapter tests, 18 Ondo catalogue/rate tests, and 18 withdrawal UI tests:
511 passing tests in the selected scope. Two opt-in live smoke tests were skipped.
API, Ondo, Earn and Solana package typechecks, changed-file Biome checks, module
boundaries and whitespace checks passed. The production dependency audit reported
no known vulnerabilities. The final recovery helper refactor also passed its separate
53-test reconciliation rerun and API typecheck.

Reproduction commands:

```sh
pnpm --filter @sdp/ondo test
pnpm --filter @sdp/earn exec node --import tsx --test 'src/providers/ondo/*.test.ts'
pnpm --filter @sdp/ondo --filter @sdp/solana --filter @sdp/earn --filter @sdp/api typecheck
pnpm --filter @sdp/api exec vitest run \
  src/services/earn/jupiter-swap.service.test.ts \
  src/services/earn/vault-external-wallet.service.test.ts \
  src/services/earn/vault-deposit.service.test.ts \
  src/services/earn/vault-withdraw.service.test.ts \
  src/services/earn/vault-execution.service.test.ts \
  src/services/earn/execution-registry.test.ts \
  src/services/jobs/reconcile-earn-vault-movements.test.ts \
  src/routes/earn.vault.test.ts \
  src/routes/earn.vault-withdrawals.test.ts \
  src/routes/earn.external-wallet.test.ts \
  src/routes/earn.external-wallet-positions.test.ts \
  src/routes/earn/handlers/vault-position-hydration.test.ts
pnpm --filter sdp-web exec vitest run src/app/dashboard/markets/earn/earn-vault-withdraw-modal.unit.test.tsx
pnpm check:module-boundaries
pnpm audit --prod --audit-level=high
```

Changed TypeScript files also receive Biome validation and `git diff --check`.

Pre-push workspace checks:

- `pnpm check` stops at 36 existing `noSvgWithoutTitle` errors in unchanged SVG
  assets. It applies no fixes and does not reach the workspace typecheck.
- The separate `pnpm typecheck` completes successfully across all 26 tasks.
- `DOPPLER_RUN_ACTIVE=1 SOLANA_RPC_URL=http://127.0.0.1:8899 pnpm test:integration`
  stops before test execution because the local Solana RPC is unavailable.
  Database and Redis URLs were explicitly restricted to loopback. The wrapper's
  existing environment mode avoids loading shared Doppler credentials.

## Limits and release gates

- The two opt-in Ondo round-trip smoke tests were not run. Their existing port
  uses the legacy Jupiter lite API and does not test production V2 admission.
  A funded local mainnet fork using the production V2 port remains a release
  requirement; a real mainnet transaction is not an appropriate substitute.
- Neither deployment configuration nor actual production wallet/ledger state
  was inspected. Operational RPC failover, issuer/APY freshness monitoring,
  deployed alerts and live liquidity remain unverified.
- Missing status plus missing history still relies on the RPC's completeness.
  The extra finalized-history read and later observation reduce false expiry;
  they do not prove absence against a consistently incomplete or dishonest RPC.
- Non-associated USDY remains visible but requires consolidation before this
  swap path can spend it. Frozen tokens require issuer action. A quote is a
  market estimate, not a guaranteed exit or guaranteed yield.
- Applicable full CI, independent review, internal security review and staging
  validation remain outstanding. No merge or deployment is included.

Protocol references: [Solana compute-budget constraints](https://solana.com/docs/core/fees/compute-budget),
[Jupiter V2 API contract](https://github.com/jup-ag/docs/blob/main/openapi-spec/swap/v2/swap.yaml),
[Foundation SDLC](https://github.com/solana-foundation/SDLC).
