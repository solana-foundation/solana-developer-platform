# Partner security intake and PII minimization

No third party receives SDP credentials, personal data, or funds-flow data until it has a record in the partner intake register. The register is `packages/sdp-types/src/partner-intake.ts`; this document is how to fill one in and what each answer commits you to.

This implements the application-side controls for threats `SDP-017` and `SDP-018` and Linear issue `HOO-1003`.

## What makes this a gate

Three things, none of them prose:

1. **The register is exhaustive by construction.** `PARTNER_INTAKE` is `satisfies` over every id in `CUSTODY_PROVIDERS`, `ORGANIZATION_RPC_PROVIDERS`, `COMPLIANCE_PROVIDERS`, `RAMP_PROVIDERS` and `EARN_PROVIDERS`. Registering a partner without answering the intake is a compile error.
2. **Clearance is enforced at runtime.** `assertPartnerIntakeCleared` runs first inside `assertProviderAvailable`, before the organization is loaded, and the same term folds into `enabled` in `getProviderAvailability`. A `blocked` partner is refused however complete its credentials are and whatever the organization is entitled to, and no override lifts it. Provisioning keys is the usual way an integration launches by accident; this is the check that makes that insufficient.
3. **The field allowlist is enforced at the egress.** `enforcePartnerFieldAllowlist` (`@sdp/payments/ramps/partner-egress`) refuses a forwarded personal-data payload carrying a field the register does not list. It refuses rather than strips: these payloads are built by SDP's own code from a declared spec, so an undeclared field is a disagreement between the builder and the register, and a silent strip would remove a field the partner needed and surface as a verification failure nobody traces back here.

The gate deliberately does not touch money-out. Earn withdrawals go through `assertEarnProviderConfigured`, which skips every admission check, so blocking a partner mid-review closes the way in without stranding a position taken while it was open (ADR 0002).

`partner-intake.drift.test.ts` checks the register against the code on every run: that every partner has a record, that the credential scope recorded matches the env keys each availability check actually reads, that the allowlist and the data map agree, and that the outstanding-review table below matches the register.

## Clearing a partner

A new partner starts `blocked`. Answer every field below, then change `clearance` to `cleared` with the review date and the accepting team. There is no third option: `provisional` exists only for integrations that predate this register and cannot be used for new work — the drift test's baseline list fails if it grows.

| Field | What it commits you to |
| --- | --- |
| `owner` | The team that carries the integration and gets paged for it. A handle, never a person. |
| `dataMap` | Everything crossing the boundary in either direction. Err toward listing a category. |
| `personalDataEgress` | `none`, `constructed` (built field by field from a declared requirement spec — the spec is the allowlist), or `allowlisted_bag` (forwarded as an object, which requires the enforced allowlist). |
| `personalDataFieldAllowlist` | Dotted paths permitted in a forwarded payload. Non-empty exactly when the egress is `allowlisted_bag`. |
| `retention.sdpStores` | What SDP keeps after the exchange. Must be a subset of the data map. |
| `retention.partnerPeriod` | The partner's documented retention period. `null` only under a provisional exception. |
| `disablement.levers` | How to stop data reaching the partner, reversible first. Every partner supports `intake_clearance`. |
| `disablement.canStrandValue` | Whether disabling can leave customer value unreachable. `true` demands an exit path before the switch is thrown. |
| `credentialScope.envKeys` | The env keys the deployment hands this partner. Pinned against what the availability check really reads. |
| `credentialScope.source` | `deployment`, `customer`, `both`, or `none`. |
| `credentialScope.capability` | What a stolen credential can do upstream: `read`, `read_write`, or `value_moving`. |
| `failureBehavior` | `fail_closed`, `failover`, or `degraded_read`. What the caller sees when the partner is down. |
| `dpa` | Who owns the data-processing agreement and its reference, or why none is required. Must be answered before `cleared`. |

Reviewing the provider's failure behavior and credential scope is not paperwork alongside the code — both fields are checked against the implementation, so an answer that does not match the adapter fails the build.

### Before production enablement

`cleared` is the production gate. It requires DPA ownership recorded (`dpa.status` is `executed` or `not_required` with a reason) and a partner retention period. A partner still carrying `unrecorded` cannot be cleared; the drift test enforces this rather than trusting the reviewer to remember.

## Currently blocked

| Partner | Why |
| --- | --- |
| `ramps:bvnk` | Draft integration. Customer creation is unimplemented pending just-in-time identity collection, and the identity fields it would forward have had no data-handling review. It is also the only partner with an `allowlisted_bag` egress, so its allowlist is enforced the moment that path is rewired. |
| `earn:veda`, `earn:upshift`, `earn:perena` | Registered so the catalogue sync and registry-consistency test have an entry, but never implemented; their clients throw `NOT_IMPLEMENTED`. |

These are the partners the gate stops today. Neither BVNK nor the unimplemented Earn providers can launch by having credentials provisioned.

## Outstanding reviews

Every integration below predates the register. Its answers were derived by reading the adapter rather than by reviewing the partner, no DPA ownership has been recorded, and the owner is the repository's `CODEOWNERS` team because no narrower owner is assigned. That is what `provisional` means — a dated exception under `HOO-1003`, not a pass.

The list is checked against the register on every test run, and the drift test's baseline stops it growing. Clearing a partner means deleting its row here, its entry from `PROVISIONAL_BASELINE`, and setting `clearance` to `cleared`.

| Partner | Credential capability | Personal data |
| --- | --- | --- |
| `custody:fireblocks` | value_moving | none |
| `custody:privy` | value_moving | none |
| `custody:coinbase_cdp` | value_moving | none |
| `custody:para` | value_moving | none |
| `custody:turnkey` | value_moving | none |
| `custody:dfns` | value_moving | none |
| `custody:ibm_haven` | value_moving | none |
| `custody:anchorage` | value_moving | none |
| `custody:utila` | value_moving | none |
| `rpc:default` | read_write | none |
| `rpc:alchemy` | read_write | none |
| `rpc:helius` | read_write | none |
| `rpc:nodit` | read_write | none |
| `rpc:quicknode` | read_write | none |
| `rpc:triton` | read_write | none |
| `rpc:validationcloud` | read_write | none |
| `compliance:range` | read | none |
| `compliance:elliptic` | read | none |
| `compliance:trm` | read | none |
| `compliance:chainalysis` | read | none |
| `ramps:moonpay` | value_moving | constructed |
| `ramps:lightspark` | value_moving | constructed |
| `ramps:moneygram` | value_moving | constructed |
| `ramps:coinbase` | value_moving | constructed |
| `ramps:mural` | value_moving | constructed |
| `ramps:stripe` | value_moving | constructed |
| `earn:ground` | value_moving | none |
| `earn:kamino` | none | none |

`rpc:default` is listed rather than treated as first-party: `SOLANA_RPC_URL` points at whatever endpoint the deployment chose, which is usually somebody's commercial RPC. The register cannot name the operator, so it records the exposure and leaves the review outstanding.

## Where personal data actually goes

Only the ramps family receives a natural person's data. Since #1507 SDP stores none of it — the counterparty row keeps provider references, the transfer keeps its economics, and identity fields are collected just-in-time and forwarded without being persisted. Keep it that way: a new column holding identity data is a change to `retention.sdpStores`, and the drift test will not let the register disagree with it.

Of those, only BVNK forwards a payload as an object. Everything else assembles the request field by field from a declared requirement spec, which cannot carry a field nobody declared. That distinction is the `personalDataEgress` field, and it is why the allowlist exists for exactly one partner today rather than as documentation everywhere.

The ingress remains open by design: `collectedData` on the payments routes is a `Record<string, string>` so providers can collect what their corridors require. It is the egress that is closed.

## When a partner is compromised or terminated

1. Set `clearance` to `blocked` with the reason and ship it. This closes every way in across all five families and needs no credential change.
2. Check `disablement.canStrandValue`. If true, drain in-flight transfers or confirm the exit route works before going further — withdrawals deliberately bypass this gate, and that must stay true.
3. Clear the `credentialScope.envKeys` in the affected deployment, then rotate them at the partner.
4. Record the incident against `dpa.owner` if one is executed.
