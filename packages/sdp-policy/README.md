# @sdp/policy

Pure, synchronous evaluation of wallet-operation policies, plus the
enforcement flow that records an operation, evaluates it and persists the
outcome through a `PolicyEnforcementStore` port. Nothing here touches a
database; `apps/sdp-api/src/services/policy/` implements the port.

## Rule kinds

Every rule is evaluated against the candidate operation and either abstains
(`null`) or contributes a decision. The strictest matched decision wins
(`deny` > `approval_required` > `provider_approval_required` > `review` >
`allow`); when nothing matches, the revision's `defaultAction` applies.

For every kind except `velocity`, `action` is the decision a MATCH produces
(default `allow` for selector kinds). A rule with no criteria is vacuous and
evaluates to `review`, so a misconfigured rule fails closed.

| Kind | Matches when | Default on match | Criteria |
| -- | -- | -- | -- |
| `always` | Always. | `allow` | none |
| `operation_family` | The operation's family is named. | `allow` | `family`, `families` |
| `operation_type` | The operation's type is named. | `allow` | `operationType`, `operationTypes` |
| `asset` | The operation's asset is named. | `allow` | `asset`, `assets` |
| `destination` | Destination is on the allowlist / not on the blocklist. | `deny` off-list | `allowlist`, `blocklist`, `destination`, `destinations` |
| `amount` | The operation's asset is named and its amount is inside `[min, max]`. | `allow` inside, `deny` outside | `min`, `max`, `asset`, `assets` |
| `approval` | Selectors match (all optional). | `approval_required` | `families`, `operationTypes`, `assets`, `approvalGroupId` |
| `velocity` | See below. | `deny` on breach only | `scope`, `window`, `max`, `asset`, `assets`, `operationTypes` |

### `velocity`

A rolling-window volume cap (ADR 0004, layer 2):

```json
{
  "id": "daily-usdc-deposits",
  "kind": "velocity",
  "scope": "organization",
  "window": "P1D",
  "max": "100000",
  "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "operationTypes": ["earn_vault_deposit"],
  "action": "approval_required"
}
```

- `scope`: whose history the window sums. `wallet` (default), `organization`
  or `api_key`.
- `window`: ISO 8601 duration in the `PnD` / `PTnH` / `PTnM` subset,
  combinations allowed (`P1DT12H`). Weeks, months, years, seconds and
  fractions are rejected.
- `max`: decimal string in the asset's units.
- `asset` / `assets`: required; a bound is meaningless across tokens.
- `operationTypes`: optional filter; absent means every operation type counts.

Semantics, and the one deliberate difference from `amount`:

- The projected total is the sum of prior wallet operations in the window for
  the scope and asset (excluding `failed` and `canceled` rows and the
  operation under evaluation) plus this operation's amount.
- If the projected total exceeds `max`, the rule's decision is `action`
  (default `deny`). **`action` is the decision ON BREACH**, so a tier default
  can set `approval_required` and route the outlier into the approval flow
  rather than refusing it.
- Within the limit the rule **abstains**; it never emits `allow`. Other rules
  and the default action decide.
- No asset, an unparseable window or max, or an invalid operation amount:
  `review`.
- The rolling total is not computed in this package. The store answers
  `loadVelocityObservations(candidate, rules)` before evaluation and the
  result is passed in as the `velocity` lookup. A rule whose observation is
  missing evaluates to `review` ("Velocity window unavailable."), so an
  absent port implementation fails closed instead of allowing.

The API implementation sums `wallet_operations.amount`, the generic ledger
every policy-gated route writes, so payments can adopt the rule unchanged.

## Enforcement flow

`enforceWalletOperationPolicy(store, input)`:

1. `createWalletOperation` records the row (status `created`).
2. `loadEffectivePolicies` resolves the wallet and API-key scopes.
3. `loadVelocityObservations` runs only when either active revision holds a
   `velocity` rule.
4. `evaluateWalletOperationPolicies` decides, strictest scope wins.
5. An approval request is created for approval decisions; the evaluation is
   recorded; the operation status transitions
   (`evaluated` / `pending_approval` / `failed`).

`Dry-Run: true` requests go through `evaluateCandidatePolicies` with the same
inputs (including the velocity lookup) and write nothing.

## Scripts

```
pnpm --filter @sdp/policy typecheck
pnpm --filter @sdp/policy test
pnpm --filter @sdp/policy lint
```
