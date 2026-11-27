# RWA provider audit, 2026-11-27

Reviewed main `b05ae558b978614b43e661eb3c3aed05e82791d6` against current
provider documentation and Hastra's pinned public program source. Local fixes
are on `codex/rwa-audit`. This covers code and offline behavior;
production deployment settings and live provider settlement were not tested.

## Provider inventory

| Provider | Code exposure | Settlement model |
| --- | --- | --- |
| Ondo USDY | Hidden, mainnet integration retained | New deposits disabled; existing holdings retain the reverse-swap exit. |
| Hastra PRIME | Hidden, mainnet integration registered | Atomic USDC/wYLDS/PRIME deposit; default USDC exit waits for an operator. Optional Jupiter exit is separately gated. |
| WisdomTree | Hidden, no admitted execution cluster | Subscription/redemption transfers open issuer orders; delivery follows later. |
| Plume/Nest | Hidden, no admitted execution cluster | Cross-chain deposits/redemptions; source finality precedes destination delivery. |

Exposure comes from `packages/sdp-types/src/provider-access.ts`. Organization
entitlements, project environment and deployment credentials are additional
requirements. Veda's provider-supplied mainnet USDC PRIME (vault 4) and
OUSD PRIME (vault 5) identities already match main's shared deployment registry.
Its atomic deposit/instant exit and separate solver queue were also reviewed;
queue creation escrows shares and never claims payout.

## Participation requirements and terms

Every strategy now exposes `requiresKyc`, `requiresKyb`,
`geographicallyRestricted` and `termsUrl`. Provider declarations supply defaults;
typed `riskMetadata.participation` can override them per strategy. `null` keeps
unknown or conditional requirements distinct from a confirmed `false`.
WisdomTree's business route declares KYC/KYB; other providers remain unknown
rather than treating permissionless access as an exemption.

These fields describe published requirements. They do not report customer
approval, perform geography checks, record acceptance or gate withdrawals.
The terms URL starts a review; it cannot replace additional product agreements.
All registered providers have verified terms links and published geographic
restrictions. Those declarations do not enable the pre-launch integrations.

Metadata validation passed 90 API contract, discovery, persistence and exit
checks, plus 101 dashboard client, data, Treasury and surfacing tests. Shared
types, Earn, API and dashboard typechecks passed. All four fields are required
by OpenAPI and the dashboard parser; explicit `false` and `null` overrides
survive metrics refresh. Existing rows gain defaults without a resync, with
zero additional provider/RPC requests. Deploy the API producer before the
stricter dashboard parser. No live customer verification or geofencing was run.

RWA source verification, 2026-11-27:

| Route | Terms | Requirement evidence |
| --- | --- | --- |
| WisdomTree Connect | [Portal/API terms](https://app.wisdomtreeconnect.com/web/order/terms-and-conditions) | Institutional onboarding includes beneficial-owner identity checks; market/jurisdiction restrictions apply. |
| Ondo secondary USDY | [Provider terms](https://docs.ondo.finance/legal/terms-of-service) | [Bearer transfers do not require issuer onboarding](https://docs.ondo.finance/general-access-products/usdy/comparison-stablecoins); [acquisition eligibility still applies](https://docs.ondo.finance/general-access-products/usdy/eligibility). |
| Hastra Solana | [Terms of Use](https://hastra.io/terms) | Terms restrict geography and reserve documentation requests. The [Solana guide](https://help.hastra.io/35f2339356548002a00ef2e113e44090) describes permissionless access with sanctions freezing. |
| Plume/Nest | [Provider terms](https://www.plume.org/terms-of-service), [Nest product terms](https://docs.nest.credit/security-and-compliance/terms-and-conditions) | [Wallet AML screening](https://docs.nest.credit/security-and-compliance/aml) and [geographic restrictions](https://docs.nest.credit/security-and-compliance/geographic-restrictions) remain distinct from KYC/KYB. |

Hastra's terms route is linked by its official footer. The current public
site bundle contains the agreement text; its HTML shell alone is unreadable.
This review verified the route and text without a signed-in browser session.

## Fixed locally

- **Hastra unknown value was reported as zero.** A valid oracle configuration
  change clears its price and timestamp. An existing 100 PRIME holding then
  returned `tokenValue: "0"`. The adapter now keeps the holding and omits its
  unavailable value. A genuine zero PRIME balance and independently valued
  residual wYLDS remain known values. Two regressions cover both cases.
- **Plume rejected valid status responses.** The published Core OpenAPI allows
  null `error.code` and `error.message`. The parser required strings when those
  fields were present, preventing otherwise valid delivery evidence from
  reaching reconciliation. Both fields now accept null. Eight regressions
  preserve source, owner, destination and populated-error recovery behavior.
- **Issuer eligibility could become stale during custody approval.** The
  prepared WisdomTree Purchase sends ordinary USDC; its later fund-token hook
  cannot stop that source transfer. The shared worker now rechecks supported
  deposit eligibility for the recorded owner and instrument before broadcast.
  Refusal durably stops new sends and observes exposed bytes; provider outages
  retry. Approval polling, withdrawals and settlement do not gain this gate.
  This reduces stale admission but cannot guarantee future issuer delivery.

The Hastra position description and integration guide explain unavailable
valuation; generated API, playground, reference and AI artifacts were refreshed.
These fixes are conservatively classified Critical. They add no signing
permission, trust boundary or money movement path.

Ondo is now hidden with the existing provider-wide `surfaced` switch. Its
adapter and credentials remain in place. Regression coverage proves hidden
Ondo is still ingested into production and the sandbox mirror, new deposits
stop before building/signing, and an existing deprecated holding can withdraw
through signed submission and worker broadcast despite disabled deposit
entitlements.

## Shared integration cleanup

Execution adapters now register once in a typed factory table shared by the
singleton and operation-scoped API registries. Catalogue clients remain
SDK-free. The common runner and proven-RPC resolver types cover every execution
adapter; provider-owned validation still runs in its existing order.

Settlement lookup inputs and candidate receipts have named shared interfaces.
Plume declares those capabilities explicitly. A launch-readiness check requires
a delivery observer before any surfaced, deployed provider-order integration
can pass the registry suite. WisdomTree now implements this reader; live
validation and launch gates remain separate.

Ondo and Hastra share the output-floor proof and bounded zero-tolerance retry.
Each retains its amount parsing, mint selection, payer rules, instruction
admission and error mapping. The normal path remains one quote and one build;
a retry adds one build, with no extra Solana RPC. The provider playbook names
these contracts and the single registration point.

## Mint, redeem and signing invariants

- **Ondo:** the route is a secondary-market swap, not primary issuance. Both
  directions enforce the approved output floor in the built transaction.
- **Hastra:** USDC mint/stake is atomic. DEX redemption consumes only freshly
  redeemed wYLDS and enforces the approved floor. At-par redemption tracks a
  separate request; only a finalized, matching `RedeemCompleted` invocation
  proves payout. Cancellation leaves actual residual wYLDS available.
- **Veda:** instant exits and solver requests are separate capabilities. Queue
  identity, owner, asset, share quantity and authenticated fulfillment evidence
  must match before payout; closed/unknown requests remain recoverable.
- **WisdomTree and Plume:** source payment or burn finality is only the opening
  leg. Correlated finalized destination delivery is required for completion.
  Provider-reported failure, missing status or timeout never proves nonexecution.
- **Every provider:** prepared bytes and required signatures remain immutable.
  Pending custody proposals are observed by their original identity. Expired
  approvals are cancelled and reconciled, never silently rebuilt or re-POSTed.
  Provider settlement can continue beyond the source blockhash lifetime.

Atomic Hastra/Ondo deposits currently leave per-movement `shares_out` unknown;
live position reads report actual holdings. Their estimates are never substituted
for minted-share receipts. Extending provider-specific atomic deposit receipt
accounting remains separate from the completed async settlement work.

## WisdomTree settlement trust boundary

Authenticated Connect order data can now propose delivery evidence to the
shared financial reconciler. The original owner, fund, direction and source
signature remain authoritative; mutable provider fields cannot replace them.
Only an independently verified finalized token credit records settlement.
Reported/observed amount mismatches remain unresolved, and the delivery receipt
unique constraint plus compare-and-set transition prevent repeated completion.
Concurrent or crashed polls perform reads only; retry observes the same source,
and does not create an order, sign, broadcast or reopen admission. Issuer/RPC
compromise, unavailable historical evidence and unsupported batching remain
external risks. Surfacing and production admission remain disabled.

## Remaining release blockers and limits

- **WisdomTree's reader is implemented; live validation remains.** It reads
  the source-correlated accessible order and checks wallet, fund, direction,
  network, currency and exact `Settled` status. The shared reconciler requires
  successful finalized token delivery; a reported amount only cross-checks the
  observed credit. Missing hashes/statuses remain recoverable. No order POST,
  `fetch-hash` command or renewed deposit eligibility runs during observation.
  Exact Solana wire fields, reported output conventions, batching behavior and
  actual issuer delivery require an authorized live tenant before launch.
  The issuer must also confirm that a resolved on-receipt address remains valid
  across the complete recent-blockhash signing window: the public API exposes
  no reservation/version or old-address grace guarantee. A changed recipient
  requires a new explicit review after proven nonexecution, never mutated bytes.
  Documented authentication still uses the password grant; the provider's
  authentication replacement is unverified.
- **Hastra needs a live operator payout proof.** Source-level review and tests
  cover request-cycle identity, delegation, cancellation, finalized completion
  events and residual wYLDS. No operator completion was executed. The optional
  DEX exit remains off by default; it is not an automatic fallback.
- **Plume needs live keeper delivery and failure recovery validation.** Status
  correlation checks source signature and owner, then verifies a finalized
  destination token credit through the expected program. Actual cross-chain
  delivery, interrupted keeper work, refund/cancellation recovery, current ABI
  fixtures and fee/rent behavior were not exercised. Both standard-redemption
  builder routes appear in the current Core OpenAPI; their naming difference
  is not a verified defect.
- **Ondo uses secondary-market liquidity.** It has no issuer order to poll.
  Both directions require output floors; frozen and auxiliary accounts remain
  holdings but are excluded from executable withdrawals. No new defect was
  found in that path. SDP does not enforce Ondo's investor/jurisdiction rules;
  eligibility remains a separate product/partner requirement.

Opening transaction finality correctly leaves provider orders and operator
requests pending. Shared tests cover ambiguous sends, retained signed bytes,
repeated submission, tenant scoping, cancellation/recovery and settlement
projection. Provider settlement requires correlated delivery evidence rather
than an unrelated wallet balance increase.

## Verification

Initial shared integration cleanup, before adding the WisdomTree reader:

| Surface | Result |
| --- | --- |
| Seven execution packages | 640 passed; 9 opt-in live tests skipped; all package typechecks passed. |
| Earn catalogue, contracts and shared swap floor | 234 passed; typecheck passed. |
| Shared operations, settlement and swap admission | 161 passed. |
| Reconciliation, recovery, repository and route flows | 278 passed. |
| API registries and provider availability | 58 passed; API typecheck passed. |

Total: 1,371 passed, 9 skipped. Veda and Kamino RPC budget suites passed with
unchanged request counts. Module boundaries, value-movement guards, docs prose,
docs links and changed TypeScript formatting passed. The module map was
regenerated without drift. No new dependencies were added.

The completed WisdomTree reader passed 81 package tests (1 opt-in live test
skipped), 257 Earn wire/catalogue tests, and 205 API settlement, operation,
reconciliation, registry and OpenAPI tests: 543 passed for this follow-up.
The API, Earn and WisdomTree typechecks passed. API/docs/AI artifacts were
regenerated; docs prose/links, playground drift, module/value-movement guards,
formatting and whitespace passed. Two independent reviews found no remaining
implementation defect.

Final async approval and eligibility validation passed 114 API tests covering
operations, exact-message signing, deposit eligibility, delivery verification
and real WisdomTree reconciliation. A separate provider/worker review passed
Ondo's 29 client tests, Hastra's 55 client tests and 177 shared signing, queue,
source-finality and payout tests. API typecheck and formatting passed after the
eligibility fix. These suites also cover refusal while approval is pending,
retryable issuer outages, caller-signed deposits and later landed observations.

The pre-broadcast check adds one eligibility invocation and no Solana RPC.
WisdomTree's hosted-customer path reads moderator, child wallets and products
(three live GETs, with the existing OAuth grant if needed). Approval polling,
withdrawals and settlement observation add no eligibility calls.

Warm WisdomTree observations add one provider GET and no Solana RPC; cold
authentication adds the existing token grant. Destination verification uses the
shared finalized transaction read only after the reader has a usable candidate.

The Ondo pause passed 75 provider policy/registry tests, 42 operation-flow and
production-exit tests, and 36 catalogue-sync tests. Shared types/API typechecks,
formatting, docs prose/links and generated playground drift passed. These are
local checks; no production disablement or deployment was performed.

Full workspace tests/builds, live provider transactions, production
credentials/configuration and signed-in browser flows were not run.

## Primary sources

Provider defaults also link to [Veda terms](https://veda.tech/terms),
[Kamino terms](https://kamino.com/terms),
[Jupiter terms](https://developers.jup.ag/docs/legal/terms-of-use),
[Upshift terms](https://docs.upshift.finance/resources/legal/terms-of-use) and
[Perena terms](https://perena.gitbook.io/perena/legal/terms-of-use).
Jupiter Lend additionally publishes service terms through its
[transparency page](https://jup.ag/lend/transparency).

- [Hastra Solana guide](https://help.hastra.io/35f2339356548002a00ef2e113e44090)
- [Hastra pinned oracle reset implementation](https://github.com/provenance-io/hastra-sol-vault/blob/121e4cc600b976a97faa018359e00bda48113ec2/programs/vault-stake/src/processor.rs#L690)
- [Plume Core OpenAPI](https://api.nest.credit/v1/docs)
- [Plume Solana integration guide](https://app.plume.org/docs/developers/integration-guides/nopal#solana-integration)
- [WisdomTree on-receipt address resolution](https://docs.wisdomtreeconnect.com/connect/orders/on-receipt)
- [WisdomTree order hash roles](https://docs.wisdomtreeconnect.com/connect/orders/by-hash)
- [WisdomTree order lifecycle](https://docs.wisdomtreeconnect.com/guides/direct-org.md)
- [WisdomTree Connect OpenAPI](https://docs.wisdomtreeconnect.com/openapi/connect.openapi.json)
- [Ondo USDY transfer and onboarding model](https://docs.ondo.finance/general-access-products/usdy/comparison-stablecoins)
- [Ondo USDY eligibility](https://docs.ondo.finance/general-access-products/usdy/eligibility)
- [Jupiter instruction-building contract](https://developers.jup.ag/docs/swap/build)
