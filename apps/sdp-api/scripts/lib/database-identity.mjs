/**
 * The database session identity stamp shared between the application client
 * (src/db/identity.ts) and privileged maintenance scripts such as
 * scripts/audit-ledger.mjs.
 *
 * Migration 0063 enables forced row-level security on every tenant-owned
 * table. Policies read three GUCs (`app.tenant_isolation_identity`,
 * `app.tenant_isolation_organization_id`, `app.tenant_isolation_actor`) that
 * callers stamp from a `DatabaseIdentity`:
 *
 *  - `tenant`   — an authenticated request bound to one organization. RLS
 *                 restricts every read and write to that organization's rows.
 *  - `system`   — a named platform workload (cron tick, webhook processor,
 *                 auth middleware, maintenance script). RLS grants
 *                 cross-tenant access; the component name travels to
 *                 Postgres for attribution.
 *  - `operator` — the audited break-glass path.
 *  - `none`     — explicitly no identity. The client injects nothing and RLS
 *                 denies.
 *
 * Both statement builders here are the single source of truth for the GUC
 * names, values, and escaping, so a script consumer can never diverge from
 * the application's identity semantics.
 */

export class DatabaseIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = "DatabaseIdentityError";
  }
}

/**
 * GUC values travel as escaped literals because the stamp must be `SET`
 * utility commands, which cannot be parameterized. With
 * standard_conforming_strings (the PostgreSQL default) doubling single quotes
 * is a complete escape; NUL can never appear in a valid value and is refused
 * outright.
 */
function quoteGucLiteral(value) {
  if (value.includes("\0")) {
    throw new DatabaseIdentityError("A database identity value cannot contain NUL");
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function identityConfigStatement(identity, scope) {
  let organizationId = "";
  let actor = "";
  switch (identity.kind) {
    case "tenant":
      organizationId = identity.organizationId;
      break;
    case "system":
      actor = identity.component;
      break;
    case "operator":
      actor = identity.actor;
      break;
    case "none":
      throw new DatabaseIdentityError(
        "A 'none' identity must not be stamped onto a database session"
      );
    default:
      throw new DatabaseIdentityError(`Unknown database identity kind: ${String(identity?.kind)}`);
  }
  return {
    text:
      `SET ${scope} app.tenant_isolation_identity = ${quoteGucLiteral(identity.kind)}; ` +
      `SET ${scope} app.tenant_isolation_organization_id = ${quoteGucLiteral(organizationId)}; ` +
      `SET ${scope} app.tenant_isolation_actor = ${quoteGucLiteral(actor)}`,
  };
}

/**
 * The statement text the application client runs to stamp the current
 * identity onto a transaction. `SET LOCAL` is transaction-local, so pooled
 * connection reuse can never leak one caller's identity into another's
 * statements — and, unlike `SELECT set_config(...)`, it is a utility command
 * that takes no snapshot, so a transaction callback can still open with
 * `SET TRANSACTION ISOLATION LEVEL ...`.
 */
export function databaseIdentityConfigStatement(identity) {
  return identityConfigStatement(identity, "LOCAL");
}

/**
 * Session-scope stamp for a dedicated, single-purpose connection such as an
 * operations CLI client: the same GUC contract as
 * `databaseIdentityConfigStatement`, lasting for the whole life of the
 * connection instead of one transaction. Only safe on connections that
 * outlive one logical workload and are never reused by another caller.
 */
export function databaseIdentitySessionConfigStatement(identity) {
  return identityConfigStatement(identity, "SESSION");
}
