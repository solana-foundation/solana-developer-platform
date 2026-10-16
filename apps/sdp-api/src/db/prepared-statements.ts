/**
 * Server-side prepared statements for the pooled PostgreSQL client.
 *
 * A statement sent without a `name` goes through PostgreSQL's unnamed prepared
 * statement, so the server parses, rewrites (row-level security is applied
 * here) and plans it again on every execution. On the request path that
 * planning, not execution, is the largest database cost: the API-key auth
 * query spends 2.35 ms planning for a 0.06 ms execution. A named statement is
 * parsed once per connection, and after five executions PostgreSQL reuses one
 * generic plan, so a 2 vCPU database serves several times the request rate.
 *
 * Names derive from the statement text, so one statement has the same name on
 * every connection and node-postgres skips the `Parse` message for a name it
 * has already prepared on that connection.
 *
 * Row-level security stays correct under a cached plan. The policy helpers
 * (`sdp_tenant_isolation_*`, migration 0081) are `STABLE` and read their
 * transaction-local settings when the statement runs, never when it is
 * planned, so one connection can run one statement for many tenants. Marking
 * one of them `IMMUTABLE` would let PostgreSQL fold one tenant's identity into
 * a generic plan and serve it to the next; client.prepared-statements.test.ts
 * fails if that happens.
 *
 * Set `DATABASE_PREPARED_STATEMENTS=off` to send every statement unnamed
 * again. A transaction-mode connection pooler (PgBouncer before 1.21) needs
 * that: it hands each transaction a different server connection, so a name
 * prepared earlier is not there.
 */

import { createHash } from "node:crypto";

/**
 * The most statement texts that may hold a server-side name. Every pooled
 * backend keeps the parse tree and plan of each name it has prepared, so this
 * bounds that memory per connection.
 */
export const MAX_NAMED_STATEMENTS = 512;

/**
 * A text earns a name on its second sighting, so SQL built with a literal or a
 * variable-length list that is seen once never takes a slot.
 */
const SIGHTINGS_BEFORE_NAMING = 2;

/** Texts remembered while they wait to earn a name; the oldest is forgotten first. */
const MAX_TRACKED_TEXTS = 4_096;

/** Only statements PostgreSQL can plan are worth naming. */
const PLANNABLE_STATEMENT = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH|VALUES)\b/i;

/**
 * Whether `text` is one plannable statement. A second statement after a `;`
 * cannot go through the extended protocol that names require, and a `;` inside
 * a string literal is refused too, which only costs the plan cache.
 */
function isNameable(text: string): boolean {
  if (!PLANNABLE_STATEMENT.test(text)) {
    return false;
  }
  const firstSemicolon = text.indexOf(";");
  return firstSemicolon === -1 || text.slice(firstSemicolon + 1).trim() === "";
}

/** Whether the `DATABASE_PREPARED_STATEMENTS` setting leaves named statements on. */
export function preparedStatementsEnabled(setting: string | undefined): boolean {
  const normalized = setting?.trim().toLowerCase();
  return normalized !== "off" && normalized !== "false" && normalized !== "0";
}

export class PreparedStatementNames {
  private readonly names = new Map<string, string>();
  /** Sightings per text; -1 marks a text that can never be named. */
  private readonly sightings = new Map<string, number>();

  constructor(
    private readonly options: { enabled: boolean; maxNames?: number } = { enabled: true }
  ) {}

  /** The server-side name `text` runs under, or undefined to run it unnamed. */
  nameFor(text: string): string | undefined {
    if (!this.options.enabled) {
      return undefined;
    }
    const known = this.names.get(text);
    if (known !== undefined) {
      return known;
    }

    const seen = this.sightings.get(text) ?? 0;
    if (seen < 0) {
      return undefined;
    }
    if (seen === 0 && !isNameable(text)) {
      this.track(text, -1);
      return undefined;
    }
    if (seen + 1 < SIGHTINGS_BEFORE_NAMING) {
      this.track(text, seen + 1);
      return undefined;
    }
    if (this.names.size >= (this.options.maxNames ?? MAX_NAMED_STATEMENTS)) {
      return undefined;
    }

    const name = `sdp_${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
    this.names.set(text, name);
    this.sightings.delete(text);
    return name;
  }

  private track(text: string, count: number): void {
    if (!this.sightings.has(text) && this.sightings.size >= MAX_TRACKED_TEXTS) {
      const oldest = this.sightings.keys().next();
      if (!oldest.done) {
        this.sightings.delete(oldest.value);
      }
    }
    this.sightings.set(text, count);
  }
}

/**
 * Whether `error` means a prepared statement went stale on its connection,
 * which only a fresh connection fixes:
 *
 * - `0A000` "cached plan must not change result type": a migration changed
 *   the columns a `SELECT *` or `RETURNING *` statement returns after the
 *   connection prepared it. The connection keeps failing that statement until
 *   it is closed.
 * - `26000` "prepared statement does not exist": something deallocated the
 *   name behind the driver's back, for example a pooler.
 */
export function isStalePreparedStatementError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === "26000" ||
    (code === "0A000" &&
      typeof message === "string" &&
      message.includes("cached plan must not change result type"))
  );
}
