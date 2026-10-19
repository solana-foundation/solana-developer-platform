/**
 * Server-side prepared statements for the pooled PostgreSQL client.
 *
 * A statement sent without a `name` goes through PostgreSQL's unnamed prepared
 * statement, so the server parses, rewrites (row-level security is applied
 * here) and plans it again on every execution. On the request path that
 * planning, not execution, is the largest database cost: the API-key auth
 * query spends 2.35 ms planning for a 0.06 ms execution. A named statement is
 * parsed once per connection, and from its sixth execution PostgreSQL switches
 * to one generic plan whenever that costs no more than planning each run, so a
 * 2 vCPU database serves several times the request rate.
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
import { DatabaseError, type QueryResult } from "pg";

/**
 * The most statement texts that may hold a server-side name. Every pooled
 * backend keeps the parse tree and plan of each name it has prepared, so this
 * bounds that memory per connection.
 */
export const MAX_NAMED_STATEMENTS = 512;

/** Texts remembered after their first sighting; the oldest is forgotten first. */
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

export class PreparedStatementNames {
  private readonly names = new Map<string, string>();
  /** Each text seen once, and whether it can ever be named. */
  private readonly seenOnce = new Map<string, boolean>();

  constructor(private readonly options: { enabled: boolean; maxNames: number }) {}

  /**
   * The server-side name `text` runs under, or undefined to run it unnamed. A
   * text earns a name on its second sighting, so SQL built with a literal or a
   * variable-length list that is seen once never takes one of the limited names.
   */
  nameFor(text: string): string | undefined {
    if (!this.options.enabled) {
      return undefined;
    }
    const known = this.names.get(text);
    if (known !== undefined) {
      return known;
    }

    const nameable = this.seenOnce.get(text);
    if (nameable === undefined) {
      this.rememberFirstSighting(text, isNameable(text));
      return undefined;
    }
    if (!nameable || this.names.size >= this.options.maxNames) {
      return undefined;
    }

    const name = `sdp_${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
    this.names.set(text, name);
    this.seenOnce.delete(text);
    return name;
  }

  private rememberFirstSighting(text: string, nameable: boolean): void {
    if (this.seenOnce.size >= MAX_TRACKED_TEXTS) {
      const oldest = this.seenOnce.keys().next();
      if (!oldest.done) {
        this.seenOnce.delete(oldest.value);
      }
    }
    this.seenOnce.set(text, nameable);
  }
}

/** What a statement needs to run: its text, its values, and its server-side name when it has one. */
export interface QueryArgs {
  text: string;
  /** Server-side statement name; set only by the cache, for statements whose plan is cached. */
  name?: string;
  values?: unknown[];
}

export type Queryable = {
  query: (args: QueryArgs) => Promise<QueryResult>;
};

/** A leased connection: what the cache needs from a pooled client. */
export interface LeasedConnection extends Queryable {
  release: (failure?: Error) => void;
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
export function isStalePreparedStatementError(error: Error): boolean {
  return (
    error instanceof DatabaseError &&
    (error.code === "26000" ||
      (error.code === "0A000" && error.message.includes("cached plan must not change result type")))
  );
}

/**
 * Everything the client does about cached plans, so a new way of leasing a
 * connection cannot forget part of it:
 *
 * - `retryingStale` names a statement and runs an attempt at it again while it
 *   keeps going stale on connections. A stale statement fails before it runs
 *   and its connection is closed, so an attempt never repeats a write.
 * - `on` and `run` execute statements on a leased connection under their
 *   cached plans, remembering which connection a statement went stale on.
 * - `release` returns a connection, or closes one a statement went stale on.
 *
 * Every connection a statement runs on must be released through `release`.
 */
export class StatementCache {
  private readonly names: PreparedStatementNames;
  /** Connections a statement went stale on, with the error that showed it. */
  private readonly stale = new WeakMap<object, Error>();

  constructor(
    options: { enabled: boolean; maxNames: number },
    /** No statement meets more stale connections than the pool holds. */
    private readonly maxStaleRetries: number
  ) {
    this.names = new PreparedStatementNames(options);
  }

  async retryingStale<T>(args: QueryArgs, attempt: (named: QueryArgs) => Promise<T>): Promise<T> {
    const name = this.names.nameFor(args.text);
    const named = name === undefined ? args : { ...args, name };
    for (let tries = 0; ; tries += 1) {
      try {
        return await attempt(named);
      } catch (error) {
        if (
          name === undefined ||
          tries >= this.maxStaleRetries ||
          !(error instanceof Error) ||
          !isStalePreparedStatementError(error)
        ) {
          throw error;
        }
      }
    }
  }

  /** Statements of one leased connection, each under its cached plan. */
  on(connection: LeasedConnection): Queryable {
    return { query: (args) => this.run(connection, this.withName(args)) };
  }

  /** Runs an already named statement, remembering when it went stale on this connection. */
  run(connection: LeasedConnection, named: QueryArgs): Promise<QueryResult> {
    return connection.query(named).catch((error: unknown) => {
      if (error instanceof Error && isStalePreparedStatementError(error)) {
        this.stale.set(connection, error);
      }
      throw error;
    });
  }

  /** Returns a connection to the pool, or closes it when a statement went stale on it. */
  release(connection: LeasedConnection, failure: Error | undefined): void {
    connection.release(failure === undefined ? this.stale.get(connection) : failure);
  }

  private withName(args: QueryArgs): QueryArgs {
    const name = this.names.nameFor(args.text);
    return name === undefined ? args : { ...args, name };
  }
}
