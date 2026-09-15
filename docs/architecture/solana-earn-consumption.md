# Solana Earn consumption

Solana Earn is an independent repository and the future single source of truth for portable provider
reads and self-custodial transaction plans. SDP remains the application and control-plane consumer: it
owns authentication, tenancy, policy, custody, sponsorship, persistence, signing, submission,
confirmation, and reconciliation.

## Package boundary

Committed SDP dependencies must use exact immutable package versions, either directly or through the
exact-version pnpm catalog. Do not commit `workspace:`, `link:`, `file:`, Git, or URL references into a
Solana Earn checkout. Those references couple CI and the lockfile to checkout layout and can bypass the
packed-artifact checks external consumers rely on.

Before registry publishing is authorized, CI-produced tarballs may be used for explicit local shadow
and packaging tests without committing them as dependencies. Cross-repository links are an uncommitted
local development convenience only.

SDP's Turborepo graph continues to orchestrate SDP. Solana Earn's recursive pnpm scripts orchestrate
its own repository and do not become part of SDP's build graph when packages are installed.

## Kit conversion

The portable `EarnTransactionPlan` remains JSON-safe. Once `@solana/earn-kit` is available from the
approved registry, SDP should use its validated conversion instead of maintaining its own mapping from
string addresses, signer/writable flags, base64 instruction data, and lookup-table addresses to
`@solana/kit` values.

That adapter does not produce a complete transaction message. SDP still chooses the fee payer and
transaction lifetime, resolves lookup tables, simulates, signs, submits, confirms, and reconciles the
transaction. The replacement should therefore occur at the narrow conversion seam immediately before
SDP assembles its Kit transaction message.

## Controlled cutover

1. Install exact prerelease versions from the approved registry.
2. Compare provider outputs and compiled instruction bytes against the pinned SDP golden fixtures.
3. Shadow reads before writes; retain the existing implementation for rollback during the evidence
   window.
4. Switch one provider path at a time behind the existing rollout controls.
5. Remove the duplicate provider and conversion implementation only after parity and production
   evidence satisfy the Solana Earn migration gates.
