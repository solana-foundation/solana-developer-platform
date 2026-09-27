/**
 * Database session identity — the application half of database-enforced tenant
 * isolation.
 *
 * Migration 0063 enables forced row-level security on every tenant-owned
 * table. Policies read three transaction-local GUCs
 * (`app.tenant_isolation_identity`, `app.tenant_isolation_organization_id`,
 * `app.tenant_isolation_actor`) that the pooled client injects per statement /
 * per transaction from the ambient identity carried here in AsyncLocalStorage.
 *
 * Identities:
 *  - `tenant`   — an authenticated request bound to one organization. RLS
 *                 restricts every read and write to that organization's rows.
 *  - `system`   — a named platform workload (cron tick, webhook processor,
 *                 auth middleware, public endpoint). RLS grants cross-tenant
 *                 access; the component name travels to Postgres for
 *                 attribution.
 *  - `operator` — the audited break-glass path. Only obtainable through the
 *                 helper in src/db/operator-access.ts, which refuses to
 *                 proceed until the bypass is recorded in the append-only
 *                 audit ledger.
 *  - `none`     — explicitly no identity (e.g. an HTTP request before
 *                 authentication). The client injects nothing and RLS denies.
 *
 * When no identity is present at all the client also injects nothing, so any
 * code path that never established one fails closed at the database.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  DatabaseIdentityError,
  databaseIdentityConfigStatement,
} from "../../scripts/lib/database-identity.mjs";

// The GUC statement builder and its error type live in
// scripts/lib/database-identity.mjs so privileged maintenance CLIs stamp the
// exact same identity contract as the pooled application client. Re-exported
// here to keep the application import surface unchanged.
export { DatabaseIdentityError, databaseIdentityConfigStatement };

export type DatabaseIdentity =
  | { readonly kind: "tenant"; readonly organizationId: string }
  | { readonly kind: "system"; readonly component: string }
  | { readonly kind: "operator"; readonly actor: string; readonly reason: string }
  | { readonly kind: "none"; readonly component: string };

const identityStorage = new AsyncLocalStorage<DatabaseIdentity>();

/**
 * Fallback consulted only when no ambient identity exists at all. Set
 * exclusively by the vitest per-worker setup so existing tests that talk to
 * repositories directly keep working; production never sets it, so unwired
 * code paths fail closed. Guarded by src/db/identity-boundary.test.ts.
 */
let defaultIdentity: DatabaseIdentity | undefined;

function assertNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new DatabaseIdentityError(`${label} is required for a database identity`);
  }
  return trimmed;
}

export function currentDatabaseIdentity(): DatabaseIdentity | undefined {
  return identityStorage.getStore() ?? defaultIdentity;
}

export function runWithDatabaseIdentity<T>(identity: DatabaseIdentity, fn: () => T): T {
  switch (identity.kind) {
    case "tenant":
      assertNonEmpty(identity.organizationId, "organizationId");
      break;
    case "system":
    case "none":
      assertNonEmpty(identity.component, "component");
      break;
    case "operator":
      assertNonEmpty(identity.actor, "actor");
      assertNonEmpty(identity.reason, "reason");
      break;
  }
  return identityStorage.run(identity, fn);
}

/**
 * Bind everything inside `fn` (including promises it starts) to one
 * organization. Established by the authentication middlewares around the rest
 * of the request once the caller's organization is known.
 */
export function runWithTenantDatabaseIdentity<T>(
  scope: { organizationId: string },
  fn: () => T
): T {
  return runWithDatabaseIdentity({ kind: "tenant", organizationId: scope.organizationId }, fn);
}

/**
 * Grant a named platform workload cross-tenant database access. Every grant
 * site is registered in src/lib/tenant-boundary.test.ts — extend the registry
 * when adding one.
 */
export function runWithSystemDatabaseIdentity<T>(component: string, fn: () => T): T {
  return runWithDatabaseIdentity({ kind: "system", component }, fn);
}

/**
 * Explicitly mark `fn` as having no database identity so it cannot inherit an
 * outer one and cannot fall back to the test default: RLS denies everything.
 */
export function runWithoutDatabaseIdentity<T>(component: string, fn: () => T): T {
  return runWithDatabaseIdentity({ kind: "none", component }, fn);
}

/**
 * Test-only fallback for code that talks to the database outside any entry
 * point (fixtures, direct repository tests). Importable only from src/test —
 * enforced by src/db/identity-boundary.test.ts.
 */
export function setDefaultDatabaseIdentityForTesting(identity: DatabaseIdentity | undefined): void {
  defaultIdentity = identity;
}
