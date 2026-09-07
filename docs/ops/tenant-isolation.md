# Database-enforced tenant isolation

Migration `0081_tenant_isolation_rls.sql` puts forced row-level security on
every tenant-owned table in the SDP API database, so an application query or
scoping mistake cannot cross an organization boundary. This is
defense-in-depth beneath the application layer's `TenantScope` repository
binding (`apps/sdp-api/src/lib/tenant-scope.ts`); it implements the residual
`SDP-005` risk (Linear: database-enforced tenant isolation under
HOO-976 Security Audits & Mainnet Readiness).

## How enforcement works

Every statement the API executes is stamped with a transaction-local session
identity by the database client (`apps/sdp-api/src/db/identity.ts` +
`src/db/client.ts`):

| GUC | Meaning |
| --- | --- |
| `app.tenant_isolation_identity` | `tenant`, `system`, or `operator` |
| `app.tenant_isolation_organization_id` | the organization a `tenant` identity is pinned to |
| `app.tenant_isolation_actor` | system component name / operator actor |

The policies (`sdp_tenant_isolation` on each table) admit:

- **tenant** — only rows whose `organization_id` (directly, or through the
  row's parent for child tables) matches the stamped organization.
- **system** — everything. Granted only at registered entry points: the auth
  middlewares (key/session/Clerk resolution runs before a tenant is known),
  provider webhooks, the public payment page and token metadata, the login
  routes, cron ticks, the managed reconciliation job, and ops scripts. The
  registry is enforced by `src/lib/tenant-boundary.test.ts`.
- **operator** — everything, but only obtainable through
  `runWithOperatorDatabaseAccess` (`src/db/operator-access.ts`), which
  refuses to run until the bypass is recorded in the append-only audit
  ledger (see `docs/ops/audit-ledger.md`) with the actor and reason.
- **no identity** — nothing. Reads return zero rows and writes are rejected,
  so a code path that never declared an identity fails closed.

Because the GUCs are stamped with `SET LOCAL` inside the transaction that
carries each statement, pooled connection reuse can never leak one request's
identity into another's.

Shared tables (global identity, operator allowlist, the shared earn strategy
catalog, singleton state rows) deliberately carry no tenant policy; the
registry with reasons lives in
`apps/sdp-api/src/db/migrations/tenant-isolation-coverage.test.ts`, which
fails if a new migration creates a table without either a forced RLS policy
or an explicit entry there.

## Counterparty provider lookups

Provider webhooks resolve tenants from provider references. Mural still
lives on the counterparty row (`mural_organization_id`, with a
`provider_data` JSON fallback); BVNK moved to
`counterparty_provider_accounts` rows of kind `customer_link`
(`provider_customer_reference`). Migration
`0080_counterparty_provider_lookup_integrity.sql` makes both lookup keys
unique among active rows: the *effective* mural key —
`COALESCE(mural_organization_id, provider_data JSON path)` — and the
`(provider, provider_customer_reference)` pair for active customer links.
A reference therefore resolves to at most one tenant in every migration
phase; two tenants racing to claim the same reference get a
unique-violation failure instead of a silent cross-tenant resolution.

### If migration 0080 refuses to apply

The migration pre-checks for active counterparties that already share an
effective reference (one row claiming it in the denormalized column, another
only in `provider_data` JSON — a state the historical indexes permitted) and
stops with the conflicting ids. Those rows are *already* broken in
production: the webhook lookups fail closed on the ambiguity today. Which
row legitimately owns the provider relationship is a business decision, so
the migration never picks a winner. Confirm ownership with the provider,
then archive the loser or clear its stale reference via
`runWithOperatorDatabaseAccess` (recording why), and re-run the migration.

## Runtime role requirements

Same contract as the audit ledger: the API and every worker must connect as
a role that is `NOSUPERUSER` and `NOBYPASSRLS` — a superuser bypasses RLS
entirely and silently disables this control. `FORCE ROW LEVEL SECURITY`
binds even the table owner, so a non-superuser owner credential is still
constrained. Verify posture with:

```sh
pnpm --filter @sdp/api audit:ledger verify
```

Migrations, `db:seed:local`, and the maintenance scripts declare the
privileged `system` identity for their session; run them with the
migration/admin credential as before.

The test harness mirrors production posture: vitest connects through a
dedicated `sdp_runtime` role (`NOSUPERUSER NOBYPASSRLS`), so the enforcement
suite (`src/db/tenant-isolation.test.ts`,
`src/routes/tenant-isolation-http.test.ts`) exercises the real policies.

## Adding a new table, view, or entry point

- New tenant-owned table → add it to the appropriate block of the RLS
  migration series (a follow-up migration with the same policy shape) or the
  coverage test fails.
- New view → create it `WITH (security_invoker = true)`. A default
  (owner-rights) view reads its underlying tables as the migration role and
  punches straight through RLS; the coverage test rejects any view without
  the option.
- New public/unauthenticated surface that reaches the database → grant a
  named system identity where the surface is registered
  (`src/middleware/database-identity.ts` for HTTP prefixes, or an explicit
  `runWithSystemDatabaseIdentity` wrap) and extend the registry test.
- Ad-hoc cross-tenant operational work → `runWithOperatorDatabaseAccess`
  with a real actor and reason; the audit row is the record reviewers check.
