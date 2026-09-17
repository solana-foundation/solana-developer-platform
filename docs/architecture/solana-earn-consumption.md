# Solana Earn consumption

Solana Earn is consumed through SDP's hosted HTTP API. SDP owns the public
contract, authentication, environment selection, tenancy, quotas, provider
orchestration, transaction construction, persistence, submission, and
reconciliation. Provider packages remain implementation details and are not a
client integration boundary.

## Hosted API tiers

The `/v1/earn` surface has two access tiers implemented by one route and one
handler per operation:

| Capability | Without an API key | With an API key |
| --- | --- | --- |
| List and inspect strategies | Yes | Yes |
| Quote deposits and withdrawals | Yes | Yes |
| Build unsigned external-wallet transactions | Yes, owner pays | Yes, owner or caller-provided fee payer |
| Submit signed transactions | No | Yes |
| Record movements and positions | No | Yes |
| Read positions, activity, and earnings | No | Yes |

Anonymous requests have no organization or project identity. They read only
the deployment's global catalogue and write no build, advisory, movement, or
position rows. The caller signs, broadcasts, and tracks an anonymous build.

Authenticated requests preserve the established project boundary. A keyed
build is durable and may be submitted through SDP, which verifies signatures,
records the movement before broadcast, and reconciles its final state.

## Environment selection

An authenticated project determines its own environment. A keyless request
uses an Earn-only exhaustive mapping from the deployment's validated
`ENVIRONMENT`: `development` selects sandbox and `production` selects
production. Unknown deployment modes fail closed. Request input never selects
production. This keeps catalogue curation and transaction construction on one
operator-controlled network.

## Contract ownership

The public source of truth is `apps/sdp-api/src/openapi/**`. The Embedded Yield
guide describes the supported integration flow. Generated API reference and AI
discovery resources must be regenerated from those sources rather than edited
by hand.

Changing which Earn routes are public or keyless is a security-boundary change.
It requires the PRO-1872 security review gate and a named security sign-off.
Provider-specific code, credentials, and operational details stay outside the
public contract.

## Implementation boundary

SDP may reuse provider libraries internally, but committed dependencies must
still use exact immutable package versions or the exact-version pnpm catalog.
Do not commit `workspace:`, `link:`, `file:`, Git, or URL dependencies that
couple CI to another checkout.

Internal provider refactors must preserve the hosted API's request, response,
authorization, tenant isolation, slippage floors, signer rules, and
record-before-broadcast guarantees. Consumers should not need a provider SDK or
repository checkout to integrate Earn.
