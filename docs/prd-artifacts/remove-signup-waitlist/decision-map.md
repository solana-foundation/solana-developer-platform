# Remove the signup waitlist

Status: scoped; custody/add-on classification, activation ownership, and deployed-account plans need
confirmation. RPC and ramp access is decided.

This map is about opening SDP signup while keeping selected third-party providers on manual
onboarding. It must not introduce customer tiers or change token allowlists, destination allowlists,
or issuance access controls.

Useful existing machinery:

- provider configuration and availability are already centralized across custody, RPC, compliance,
  and ramps
- API enforcement already exists on the main provider-backed routes
- the custody catalog already has a `request_access` display mode and a Typeform link

The missing work is a tier-independent activation lifecycle, consistent UI across provider families,
request attribution for BD, coverage for Kora/MagicBlock, shared-account guardrails, and migration of
existing tier-derived access. New organizations also complete the RPC/custody flow in
[`organization-onboarding-flow.md`](./organization-onboarding-flow.md) before entering the dashboard.

## #1: What replaces the signup waitlist?

Blocked by: none
Type: Discuss

### Question

How can anybody start using SDP without opening every contracted provider to every organization?

### Answer

Open Clerk signup and organization creation. Every user operates through an organization/team and
gets the same SDP product surface. Provider access is a separate concern with two access modes:

- `general`: every organization can use the provider when it is configured in the deployment
- `manual`: the provider is visible, but each organization needs an explicit activation after
  contacting SDP and completing onboarding

Do not use `individual`, `enterprise`, team size, billing plan, or user type to decide provider
availability. If the existing organization `tier` field must remain temporarily for compatibility,
make it inert for provider access and remove tier language from product UI and provider errors.

Launch-critical changes:

- change the landing-page waitlist CTA to `/sign-up`
- disable Clerk's signup restriction in the production Clerk instance
- stop deriving provider access from organization tier
- keep self-hosted behavior: configured providers are usable unless explicitly disabled
- leave the local `/admin/allowlist` cleanup for later; it is not the provisioning gate and must not
  be confused with product-level token allowlists

## #2: How should provider availability be represented?

Blocked by: #1
Type: Discuss

### Question

What is the minimum model that supports open signup and a provider-specific BD funnel?

### Answer

Use a global provider catalog plus organization-specific activation state:

```text
provider access mode: general | manual
organization activation: not_requested | requested | enabled | disabled
configured: true | false
available = configured && (access_mode == general || activation == enabled)
```

`requested` matters because a boolean override loses the BD lead between clicking `Contact us` and
being approved. Record provider, provider family, organization, environment, request time, source
surface, and requesting member. `disabled` supports revocation without pretending the organization
changed tiers.

The provider-availability response should expose `accessMode`, `activationStatus`, `configured`, and
`available`. Deprecate `entitled` and the response-level `tier`. API enforcement should return one
stable reason such as `PROVIDER_ACTIVATION_REQUIRED`, including provider and contact URL, rather than
`ENTERPRISE_ACCESS_REQUIRED`.

Existing `providerOverrides` may be migrated into activation records, but should not remain the
long-term name because `true` now means a reviewed provider activation, not a generic override.

## #3: Which providers are general and which are manual?

Blocked by: #2
Type: Discuss

### Question

Which provider choices should a newly created organization be able to use?

### Answer

Recommended launch classification, using today's lower-exposure set as the baseline:

| Family | Generally available | Manual onboarding |
| --- | --- | --- |
| Custody/signing | Privy, Coinbase CDP, Para, Turnkey | Fireblocks, Dfns, IBM Digital Asset Haven, Anchorage, Utila |
| RPC | Default RPC, Alchemy, Helius, QuickNode, Triton, Validation Cloud | None |
| Compliance | None | Range, Elliptic, TRM, Chainalysis |
| Ramps | MoonPay, Lightspark Grid, BVNK, MoneyGram sandbox, Coinbase Onramp, Mural Pay, Stripe | None |
| Payments add-ons | None pending contract review | Kora fee payment, MagicBlock private payments |

Notes:

- `local` signing is not a shared vendor account; keep it self-hosted/internal rather than presenting
  it as a managed provider choice.
- Fireblocks, Utila, Dfns, Anchorage, and all compliance providers are confirmed manual-onboarding
  requirements from product direction.
- The repository integrates Elliptic, not a provider named Ellipsis; this scope treats the user's
  “Ellipsis” reference as Elliptic unless another integration exists outside this repository.
- Para is confirmed generally available. Its shared Beta project limits affect launch capacity, not
  organization-specific access.
- IBM Haven remains recommended manual because it currently sits with the contracted custody set.
- All RPC and ramp providers are confirmed generally available. Their commercial onboarding,
  sandbox restrictions, and shared-account limits affect whether they are configured and usable,
  but do not create organization-specific access gates.
- Kora and MagicBlock classifications remain recommendations pending contract review.

The full account and contract inventory is in
[`provider-account-readiness.md`](./provider-account-readiness.md).

## #4: Where should “Contact us” appear?

Blocked by: #2, #3
Type: Prototype

### Question

How do we keep manual providers discoverable without turning the dashboard into an upsell surface?

### Answer

Show the prompt only at a provider decision point:

1. Provider selectors: show manual providers as selectable-looking cards with `Manual onboarding`
   status, a short explanation, and `Contact us`; do not hide them and do not allow activation.
2. Compliance: show one compact `Enable compliance screening` panel where screening is configured
   or invoked, listing the available integrations and one `Contact us` action. Do not place the
   prompt on every counterparty or transaction row.
3. Kora and MagicBlock, if confirmed manual: show it at fee-payment/private-payment setup only.
4. Direct API: return the stable activation-required response with a contact link for manual
   providers only.

RPC and ramp selectors must not show `Contact us`, `Manual onboarding`, or plan/tier gating. A
provider may still be unavailable when its shared SDP credentials are not configured for the
requested environment; present that as environment availability, not organization access.

The CTA should create or update the `requested` activation state and then open the existing contact
flow with organization, provider, environment, and source context. If the Typeform cannot accept
hidden context reliably, create a small SDP request-access endpoint first and treat the external
form as the follow-up channel.

Do not show `Upgrade`, `Enterprise only`, customer-tier comparisons, a global contact banner, or a
waitlist message. The landing-page CTA remains `Get started`.

## #5: How are existing organizations migrated?

Blocked by: #2, #3
Type: Discuss

### Question

How do we remove tier-derived defaults without broadening or silently removing existing access?

### Answer

Materialize current manual-provider access before switching the resolver:

1. Export every managed organization, its tier, provider overrides, configured custody provider,
   activated compliance/add-on providers, and recent manual-provider use.
2. Create explicit `enabled` activations for manual providers that an organization currently uses or
   that BD confirms it should retain.
3. Do not activate every manual provider merely because an organization currently says
   `enterprise`; that would preserve an accidental blanket entitlement.
4. Convert existing explicit `true` overrides to `enabled` only after review. Convert explicit
   `false` overrides to `disabled` when the distinction still matters.
5. Deploy the new access resolver, compare old and new availability for every organization, then
   make tier inert.

Open decision: name the authoritative owner who approves the initial activation export and future
manual activations.

## #6: Which shared accounts need capacity work?

Blocked by: #3
Type: Research

### Question

Which vendor accounts, plans, contracts, balances, or quotas can constrain more teams on devnet?

### Answer

The repository declares 28 external product-provider integrations plus shared platform accounts. Source
code proves that an integration exists, but not which plan is deployed. The actionable inventory is
[`provider-account-readiness.md`](./provider-account-readiness.md).

Before opening signup, confirm or increase capacity for every generally available shared account:

- Clerk organization/auth usage
- the deployed Cloudflare Workers, Hyperdrive, KV, database, and Redis accounts
- every RPC account: default Solana RPC, Alchemy, Helius, QuickNode, Triton, and Validation Cloud
- Privy, Coinbase CDP wallets, Para, and Turnkey
- every ramp account: MoonPay, Lightspark Grid, BVNK, MoneyGram sandbox, Coinbase Onramp, Mural Pay,
  and Stripe
- Resend, Sentry, Google Places, and GCP Secret Manager
- Kora fee-payer balance and per-wallet limits if Kora becomes generally available

Manual providers do not need blanket public capacity before signup, but every one still needs a
recorded sandbox/devnet allowance, contract owner, activation lead time, and maximum safe pilot size
before it can be enabled for another organization.

Opening signup also exposes wallet creation and other provider-cost operations to authenticated
dashboard traffic that currently bypasses the general API limiter. Add per-organization limits,
provider-specific backoff, usage telemetry, budget alerts, and a kill switch before relying on paid
overages.

## #7: What is the minimum safe test plan?

Blocked by: #1, #2, #3, #4, #5
Type: Prototype

### Question

How do we prove this is provider activation, not a hidden customer-tier system?

### Answer

Automate an organization/provider matrix:

- two newly created organizations receive the same base product surface and can create teams,
  projects, API keys, and dev-mode resources
- both can use every configured generally available provider
- both can use configured Para custody without an activation record
- both can use every configured RPC and ramp provider without an activation record
- a manual provider is visible with `Manual onboarding` and `Contact us`, but its API call fails with
  `PROVIDER_ACTIVATION_REQUIRED` before the vendor is called
- clicking `Contact us` records `requested` with provider/source context
- enabling Fireblocks for organization A changes only Fireblocks for A; it does not enable
  compliance, other custody providers, or anything for organization B
- disabling the activation revokes use without changing organization type
- a configured-but-unactivated provider and an activated-but-unconfigured provider report different
  states
- compliance does not fan out any vendor calls until at least one compliance provider is activated
- self-hosted deployments still expose configured providers without managed SDP activations
- legacy tier values produce no provider-access difference
- token/destination allowlists remain unchanged
- a new organization must explicitly choose RPC, provision its first general-provider sandbox
  wallet, and complete onboarding before dashboard access
- an invited member of an already-complete organization must skip onboarding

Add contract tests for every enforcement path: custody initialization and switching, wallet
creation, RPC selection, ramps, compliance screening, Kora, and MagicBlock.

## #8: What is the rollout sequence?

Blocked by: #5, #6, #7
Type: Discuss

### Question

What order opens signup without losing access control or exhausting shared devnet accounts?

### Answer

1. Confirm the remaining custody/add-on classifications and activation owner; RPC and ramps are
   already confirmed general.
2. Complete the deployed-account worksheet and bump launch-critical generally available accounts.
3. Add activation states and materialize existing organizations' manual-provider access.
4. Replace tier-derived availability and API errors; add per-organization cost/rate controls.
5. Add the new-organization RPC/custody onboarding flow and backfill existing organizations as
   complete.
6. Add contextual manual-onboarding UI and request attribution.
7. Run the cross-organization test matrix and compare old/new access for existing organizations.
8. Switch the landing CTA to signup and disable Clerk's signup restriction.
9. Monitor signups, organizations, onboarding completion, wallet creation, provider 429s, screens,
   signatures, ramp sessions, fee-payer spend, outbound volume, email, auth, database, and RPC usage.
10. Remove dead local signup-allowlist machinery and later remove the inert organization-tier field.

Rollback should re-enable Clerk's signup restriction and disable new activations. It must not delete
organizations, activation records, wallets, or provider data.

## #9: What are the implementation workstreams?

Blocked by: #2, #3, #4
Type: Discuss

### Question

How should this be split into independently reviewable delivery slices?

### Answer

1. **Access model and storage**: add provider access mode and activation status to shared types;
   persist organization/provider activation requests with audit fields; add the migration/export
   tooling.
2. **Resolver and enforcement**: replace tier defaults in the provider-availability service; return
   stable activation-required errors; add Kora and MagicBlock to the same enforcement model.
3. **Activation workflow**: add authenticated request-access and restricted enable/disable actions;
   preserve the external Typeform as the contact surface while SDP records the lead and decision.
4. **Contextual UI**: reuse custody's existing `request_access` presentation; make every configured
   ramp/RPC option generally available; add one compliance setup prompt; remove `plan` and
   `enterprise tier` language.
5. **New-organization setup**: add the organization-level RPC/custody wizard, completion state,
   route gate, existing-organization backfill, and resume behavior.
6. **Open signup**: change the landing CTA and Clerk setting only after access migration, account
   readiness, and onboarding verification.
7. **Capacity and abuse controls**: per-organization wallet/provider limits, provider-specific 429
   handling, cost attribution, alerts, and kill switches.
8. **Verification and cleanup**: cross-organization E2E matrix, old/new access diff, rollout
   dashboards, dead signup-allowlist removal, and later tier-field removal.

Workstreams 1-5 form the functional feature. Workstreams 6-7 are launch gates. Workstream 8 closes
the migration and prevents the old tier/waitlist model from lingering.

## #10: What happens on the first login to a new organization?

Blocked by: #1, #3
Type: Discuss

### Question

How does a new organization choose its shared infrastructure before entering the dashboard?

### Answer

Use a mandatory, organization-level two-step flow:

1. Choose and explicitly persist any configured RPC provider.
2. Choose Privy, Coinbase CDP, Para, or Turnkey and provision the first default sandbox wallet.
3. Mark the organization complete and redirect directly to the dashboard.

The interaction reuses the new-wallet selection cards, two-step progress, and stable footer. It has
no welcome or review screen. Manual custody/compliance providers are not shown because they must not
block basic workspace setup. RPC testing remains optional in Settings rather than becoming an
onboarding gate.

Onboarding is completed once per organization, not once per user. Existing organizations are
backfilled as complete; invited members skip the flow when their organization is already ready.
Only organization administrators can make these organization-wide choices.

The detailed state, copy, failure behavior, reuse points, and acceptance tests are in
[`organization-onboarding-flow.md`](./organization-onboarding-flow.md).
