# 0004. Earn volume caps

Date: 2026-09-11
Status: Proposed (PRO-1870; threat model P4.2 / P4.6 / E4.2, §9 item 4)

## Context

Nothing in the Earn money path bounds how much can move. The three custody
routes (`POST /vault-deposits`, `/vault-withdrawals`,
`/programs/:programId/withdrawals`) run through `policyGate`, so an org's
wallet policy or API-key control profile can impose amount limits, but only if
the org wrote one: no active policy resolves to `IMPLICIT_DEFAULT_ALLOW_POLICY`.
The public external-wallet build path has no amount gate at all, by design (the
customer's signature is the authorization). Nothing anywhere bounds SDP-wide
exposure to a single vault or provider.

Consequences today:

- A stolen `earn:write` + `wallets:read` key on an org with no policy moves the
  whole custody wallet in one call and passes every gate.
- Every org can pile into one vault with no ceiling. A vault exploit, depeg or
  liquidity crunch hits everyone at once, and the only lever is the operator
  `paused` switch, after the fact.
- A poisoned catalogue row (EARN-010) attracts allocation with no dampener. The
  anomaly alerts (PRO-1867) shorten time-to-notice; nothing bounds what lands
  first.
- A compromised partner backend can build and submit for every owner it serves.
  Customers still sign, but a phished signature is cheap at scale.

Everything shipped against these so far (PRO-1863/1867/1903/1909) is detection.
Caps are the prevention half the threat model pairs with them.

Two constraints shape the design:

- **Exits never trap funds** (ADR 0002). Withdrawals cannot be refused by any
  platform cap.
- **Caps are not investment advice.** SDP does not constrain an org's allocation
  mix. V1 is single-vault programs, so most orgs are 100% in one vault by
  construction.

## Decision

Three layers, each bounding one thing. All three refuse or interpose on
**deposits only**.

| Layer | Owner | Bounds | On breach |
| -- | -- | -- | -- |
| 1. Vault exposure | SDP, platform-wide | SDP-wide holdings in one vault, as a share of the vault's TVL plus an absolute ceiling | Soft: alert at 80%. Hard: deposit refused with a typed 409, surfaced first as a preview `blockingIssues` entry. |
| 2. Org velocity defaults | SDP sets tier defaults; org may request a raise | Per-org rolling 24h deposit volume; per-transaction large-deposit line | Existing approval flow: 202 `SIGNING_PENDING`, approver clears in the dashboard. Never denied. |
| 3. Org-configured policy | The org | Whatever the org expresses via wallet policy or control profile | Existing deny / review / approval semantics. |

### Layer 1: vault exposure

Measured against the **vault's total TVL**, not the org's balance. If a vault
holds 50M and the cap is 10%, SDP customers may collectively hold 5M in it.
Sizing against TVL also bounds the full-utilization exit risk (EARN-015): SDP
stays a small enough fraction of any vault that its customers can always leave.

- Exposure is computed across all orgs on the environment from the movement
  ledger, not from positions: positions are read live from chain and never
  persisted as balances, so the ledger is the only durable SDP-wide figure.
  Implementation note (PRO-1934): the figure is the sum of non-failed vault
  deposits (in-flight included, on purpose) in deposit-token units. Exits are
  ledgered in shares, so they are NOT subtracted; the result is gross inflow,
  an over-estimate that only ever errs toward refusing a deposit. Recording
  the token payout at exit settlement is the follow-up that makes it net.
  Amounts and caps are in the vault's deposit-token units rather than USD (no
  price oracle; V1 vaults are dollar stablecoins), and the share bound compares
  them against the catalogue's USD TVL on that same dollar-for-dollar basis.
- Enforced inside the single admission predicate
  (`assertVaultDepositAdmissible`, `routes/earn/handlers/admission.ts`), so
  both the custody and external-wallet deposit paths meet it with no new gate
  ordering.
- Config lives beside `CURATED_VAULTS` in `curation.ts`, keyed by vault
  address, and inherits the CODEOWNERS gate from PRO-1869. A missing entry
  means the platform default applies; `null` means uncapped (explicit, so a
  reviewer sees it).
- Withdrawals are untouched. A vault over its cap is exit-only, same posture as
  `paused`.

### Layer 2: org velocity defaults

Reuses the policy engine rather than adding a parallel limits system.

- A new `velocity` rule kind in `@sdp/policy`: rolling-window sum of
  non-failed operation amounts for a scope (org, wallet, or API key), with
  `window`, `max` and `assets`. Prior art is the sponsorship budget's
  per-transaction / hourly / daily limits
  (`sponsorship-budget-operator.ts`). Implementation note (PRO-1933): the sum
  runs over `wallet_operations`, the generic ledger every policy-gated route
  writes, not `earn_movements`, which is what makes the rule reusable by
  payments unchanged. On breach the rule's `action` is the decision (default
  deny); within the limit it abstains.
- Tier defaults are synthesized as an implicit policy layer evaluated after the
  org's own policy and before `IMPLICIT_DEFAULT_ALLOW_POLICY`. Breaching a
  default yields the **approval** decision, never deny.
- Per-org overrides live in a small table with `expires_at` and an
  audit-ledger entry (PRO-1866 pattern), so a raise is temporary and
  attributable.
- Managed program withdrawals pay out to a caller-supplied address, the one
  real exfiltration path. Tier default: a withdrawal above the large-line to a
  destination this org has never paid before requires approval. Orgs can turn
  it off. Returning funds to the wallet that funded the program is always
  ungated, as is any custody vault withdrawal (funds return to the same custody
  wallet).

### Layer 2, embedded surface: partner volume tripwire

SDP cannot sensibly refuse an end-user's own money, and per-user limits are the
partner's KYC-tier problem. So on the external-wallet path layer 2 becomes a
**per-partner-key volume tripwire**, sized from the expected volume the partner
declares at STRIDE onboarding (PRD §4.4) times a generous multiple.

- Soft threshold: alert.
- Hard threshold: deposit builds return a `blockingIssues` entry naming the
  cap and "contact SDP". No 4xx after a customer signed.
- External-wallet withdrawal builds are never gated: SDP holds no key, and
  refusing the build only breaks the user's exit.

### Cross-cutting rules

- **Previews are the contract.** Every cap surfaces in the deposit preview and
  honors `Dry-Run: true`, so the dashboard and partner integrations see the
  refusal or the approval requirement before anyone signs.
- **Fail closed on deposits, never on exits.** A cap check that cannot run
  refuses the deposit. Same posture as a database outage today.
- **Shadow first.** Every layer ships in evaluate-and-log mode behind a flag:
  it computes the verdict, emits `sdp_api_earn_volume_cap_evaluated` with
  `would_block`, and enforces nothing. Defaults are set from two weeks of
  shadow data, then each layer flips to enforce independently.
- **Observability.** Three rules in the `sdp-earn` group, same shape as the
  sweep set: cap at 80%, cap hit, shadow would-have-blocked.

## Defaults (placeholders until shadow data exists)

| Cap | Placeholder | Notes |
| -- | -- | -- |
| Vault exposure, hard | 10% of vault TVL, ceiling 5M USD-equivalent | Soft alert at 80% of the hard cap. |
| Org daily deposit volume | by tier, to be set | Approval, not deny. |
| Org large single deposit | by tier, to be set | Approval, not deny. |
| Program withdrawal to a new destination | above the large-deposit line | Approval; org can disable. |
| Partner key daily volume | declared onboarding volume × 3 | Soft at ×2. |

## Consequences

- Orgs with no policy get a floor they cannot forget to set; orgs with a policy
  keep it and gain a velocity rule.
- Treasury operators see a 202 and an approval in the dashboard on outlier
  deposits instead of a refusal. The dashboard must handle a 202 on an earn
  deposit; that is verified in the implementation ticket, not assumed.
- Partners see caps as preview blocking issues, the same channel that already
  carries slippage and liquidity issues.
- One vault's failure costs SDP customers at most a known number.
- Caps add one ledger aggregate per deposit admission, indexed for the
  aggregate. Admissions read the ledger fresh so an enforced verdict never
  rests on a cached figure; only previews use the short in-process cache.
- Velocity windows count only decided, still-live operations. An operation
  awaiting its own decision does not count, so concurrent requests cannot
  veto each other; the overshoot concurrency can cause is bounded by the
  in-flight set, which is the failure direction this ADR prefers.

## Rejected

- **Refusing withdrawals over a cap.** Traps funds; ADR 0002.
- **Per-owner caps on the embedded surface.** The partner's KYC tiers own that.
  SDP documents it as a partner responsibility.
- **Constraining an org's allocation mix.** Investment advice, and meaningless
  under single-vault V1 programs.
- **A separate limits service.** The policy engine already has amount rules,
  approval interposition, 202 replay by idempotency key and a dry-run path.
- **Caps in the database from day one.** Curation-as-code keeps vault caps
  reviewable and CODEOWNERS-gated. Revisit when caps change more often than the
  shelf.

## Open questions for review

- Tier default numbers, once shadow data exists.
- Whether tier defaults are a launch requirement or may trail mainnet by one
  release. Layer 1 and the partner tripwire are launch requirements.
- Whether the Treasury dashboard gets a caps-and-usage view in V1 or only the
  blocking-issue text.
