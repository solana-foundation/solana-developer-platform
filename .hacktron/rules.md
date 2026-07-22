# Solana Developer Platform review context

## System boundaries

- `apps/sdp-api` is a Node.js API deployed to Cloud Run. Treat route handlers, middleware, repositories, Postgres, Redis, and provider adapters as server-side code.
- `apps/sdp-web` is a browser-facing Next.js dashboard. Treat browser input, URL parameters, client state, and rendered user-controlled content as untrusted.
- `apps/sdp-docs` is a public documentation site. Documentation and generated API reference content are public and must not contain secrets or private operational details.
- `packages/*` contains shared runtime types and constants used by more than one application. Changes here can affect both API and dashboard trust boundaries.

## Authentication and authorization

- API requests are authenticated with Clerk sessions or SDP API keys. Authentication alone is not authorization: organization, project, API-key scope, wallet ownership, and resource status must be enforced at the route/service boundary.
- Project-scoped API keys must not access resources from another project. Organization-admin access must not silently bypass project and resource ownership checks unless the route explicitly defines that behavior.
- Wallet policy is the baseline for custody operations. API-key policy can narrow access or require approval, but must not expand past the effective wallet policy.
- Treat webhook signatures, provider callbacks, and externally supplied identity/compliance data as untrusted until validated by the provider-specific verification and schema paths.

## High-risk assets and flows

- Custody credentials, signing keys, API-key secrets, Clerk tokens, webhook secrets, provider credentials, encryption keys, and database connection strings are secrets. Never log, return, commit, or expose them to browser code.
- Signing, raw transaction submission, token administration, custody provisioning, payment execution, fiat on/off-ramp settlement, and compliance decisions are high-risk flows. Review authorization, replay/idempotency, state transitions, and audit behavior strictly.
- Sensitive operations should preserve organization/project scoping and should not trust client-supplied wallet, provider, project, or actor identifiers without resolving them server-side.
- Audit records and settlement records are security-relevant evidence. Do not weaken their immutability, provenance, or correlation fields to make a request succeed.

## Trusted dependencies and environments

- External custody, compliance, payments, RPC, and fiat-rail providers are not trusted merely because they are configured. Validate their responses, signatures, status transitions, and identifiers at the provider adapter boundary.
- Solana RPC responses and transaction metadata are external data. Do not treat a successful submission, signature, account address, or token amount as proof that the intended business operation is authorized or settled.
- Local development and devnet defaults are not production security controls. Do not infer production safety from local `.env.local`, test fixtures, mocks, or devnet behavior.

## Review guidance

- Flag missing authorization, cross-tenant access, secret exposure, signature-verification gaps, replay/idempotency flaws, unsafe state transitions, and changes that can cause unauthorized signing or settlement.
- Treat generated OpenAPI/API reference artifacts as derived output; review the owning source and regeneration path instead of reporting generated duplication by itself.
- Keep false-positive decisions specific to the affected flow. Do not suppress a finding broadly when the same pattern could be exploitable in a public route, browser surface, custody path, webhook, or provider adapter.
