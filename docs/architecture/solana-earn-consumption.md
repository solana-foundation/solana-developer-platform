# Solana Earn consumption

Solana Earn is consumed through SDP's hosted HTTP API. SDP owns the public
contract, authentication, environment selection, tenancy, quotas, provider
orchestration, transaction construction, persistence, submission, and
reconciliation. Provider packages remain implementation details and are not a
client integration boundary.

## Hosted API access

Every `/v1/earn` operation requires an API key, or a dashboard session with a
selected project, and is implemented by one route and one handler. A build is
durable and is submitted through SDP, which verifies signatures, records the
movement before broadcast, and reconciles its final state.

## Environment selection

The authenticated project determines the environment, and every deployment
serves both clusters by project. A strategy read, quote or build answers for
the project's environment only: a strategy row from the other environment is
404. No request parameter selects the environment, and the deployment's own
`ENVIRONMENT` never selects a cluster.

## Contract ownership

The public source of truth is `apps/sdp-api/src/openapi/**`. The Embedded Yield
guide describes the supported integration flow. Generated API reference and AI
discovery resources must be regenerated from those sources rather than edited
by hand.

Changing which Earn routes are public is a security-boundary change.
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
