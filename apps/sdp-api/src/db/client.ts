import { Pool, type PoolClient, type QueryResult, types } from "pg";
import {
  currentDatabaseIdentity,
  type DatabaseIdentity,
  databaseIdentityConfigStatement,
} from "@/db/identity";
import {
  isStalePreparedStatementError,
  PreparedStatementNames,
  preparedStatementsEnabled,
} from "@/db/prepared-statements";
import { getLogger } from "@/runtime/logger";

types.setTypeParser(20, (value) => Number.parseInt(value, 10));

export interface DatabaseBindings {
  DATABASE_URL?: string | null;
}

export interface QueryManyResult<T> {
  results: T[];
  rows: T[];
}

export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<QueryManyResult<T>>;
  run(): Promise<number>;
}

export interface DatabaseExecutor {
  prepare(query: string): PreparedStatement;
  queryOne<T = Record<string, unknown>>(
    query: string,
    params?: readonly unknown[]
  ): Promise<T | null>;
  queryMany<T = Record<string, unknown>>(query: string, params?: readonly unknown[]): Promise<T[]>;
  execute(query: string, params?: readonly unknown[]): Promise<number>;
}

export interface DatabaseClient extends DatabaseExecutor {
  batch(statements: readonly PreparedStatement[]): Promise<number[]>;
  transaction<T>(callback: (tx: DatabaseExecutor) => Promise<T>): Promise<T>;
  /**
   * Run a transaction while retaining a session advisory lock until an
   * external post-commit action completes. The callback is committed before
   * `afterCommit` runs, so an external system can never advance on a database
   * transaction that later rolls back. When PostgreSQL confirms a rollback
   * after the callback completed, `afterRollback` may undo external pre-commit
   * state while the same session lock is still held.
   */
  lockedTransactionWithPostCommit?<T>(
    lockKey: string,
    callback: (tx: DatabaseExecutor) => Promise<T>,
    afterCommit: (result: T) => Promise<void>,
    afterRollback?: (result: T) => Promise<void>,
    options?: { wait?: boolean }
  ): Promise<T>;
}

export class SessionLockUnavailableError extends Error {
  readonly lockKey: string;

  constructor(lockKey: string) {
    super(`session lock is already held: ${lockKey}`);
    this.name = "SessionLockUnavailableError";
    this.lockKey = lockKey;
  }
}

/**
 * The database could not take the work at all: no pooled connection came free
 * in time, a new one could not be opened in time, or the server is out of
 * connection slots or still starting up. Every one of these fails before a
 * statement runs, so the request can be retried, and the API answers 503 with
 * `Retry-After` instead of 500 (src/app.ts).
 */
export class DatabaseUnavailableError extends Error {
  /** Pool counters when the failure happened; `waiting` is the queue behind a saturated pool. */
  readonly pool: { total: number; idle: number; waiting: number };
  readonly code?: string;

  constructor(cause: unknown, pool: Pick<Pool, "totalCount" | "idleCount" | "waitingCount">) {
    const counters = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
    // The counters ride in the message because the API logs an unexpected
    // error's message and nothing else of it, and they are what tells a
    // saturated pool from a database that is down.
    super(
      `Database unavailable: ${cause instanceof Error ? cause.message : String(cause)} ` +
        `(pool: ${counters.total} open, ${counters.idle} idle, ${counters.waiting} waiting)`,
      { cause }
    );
    this.name = "DatabaseUnavailableError";
    this.pool = counters;
    const code = (cause as { code?: unknown } | null)?.code;
    if (typeof code === "string") {
      this.code = code;
    }
  }
}

/** pg-pool messages for a connection that was never handed out. */
const POOL_ACQUIRE_TIMEOUT_MESSAGES: readonly string[] = [
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
];
/** `too_many_connections` and `cannot_connect_now` (starting up or shutting down). */
const CONNECT_REFUSED_CODES: readonly string[] = ["53300", "57P03"];

/** Whether `error` is a failure to get any connection, as opposed to a statement that failed. */
export function isDatabaseUnavailableCause(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    (typeof code === "string" && CONNECT_REFUSED_CODES.includes(code)) ||
    (typeof message === "string" && POOL_ACQUIRE_TIMEOUT_MESSAGES.includes(message))
  );
}

function asDatabaseUnavailable(error: unknown, pool: Pool): unknown {
  return isDatabaseUnavailableCause(error) ? new DatabaseUnavailableError(error, pool) : error;
}

async function acquireClient(pool: Pool): Promise<PoolClient> {
  try {
    return await pool.connect();
  } catch (error) {
    throw asDatabaseUnavailable(error, pool);
  }
}

interface QueryArgs {
  text: string;
  /** Server-side statement name, set for statements whose plan is cached (prepared-statements.ts). */
  name?: string;
  values?: unknown[];
}

type Queryable = {
  query: (args: QueryArgs) => Promise<QueryResult>;
};

function withStatementName(args: QueryArgs, names: PreparedStatementNames): QueryArgs {
  const name = names.nameFor(args.text);
  return name === undefined ? args : { ...args, name };
}

/** A connection inside a transaction, running its statements under cached plans. */
function namedQueryable(client: PoolClient, names: PreparedStatementNames): Queryable {
  return { query: (args) => client.query(withStatementName(args, names)) };
}

/**
 * The error to release a connection with so the pool closes it: a prepared
 * statement a migration made stale fails on this connection until it is
 * closed, so no later borrower may get it back.
 */
function staleStatementReleaseError(error: unknown): Error | undefined {
  if (!isStalePreparedStatementError(error)) {
    return undefined;
  }
  return error instanceof Error ? error : new Error(String(error));
}

const pooledClients = new Map<string, PooledPostgresClient>();

const NODE_POOL_OPTIONS = {
  max: 10,
  // Bounds every statement and every idle-in-transaction session (HOO-1918):
  // a hung query fails its request instead of holding its Idempotency-Key and
  // a pooled connection. Generous for OLTP. `job.ts` shares this pool, so a
  // transaction that must outlive a bound lifts it with SET LOCAL, as the
  // audit-ledger writer does for its Redis waits (`audit.service.ts`).
  statement_timeout: 30_000,
  idle_in_transaction_session_timeout: 60_000,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  maxLifetimeSeconds: 300,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
} as const;

/**
 * Stale prepared statements are found one connection at a time and each find
 * closes that connection, so no statement meets more stale connections than
 * the pool holds.
 */
const MAX_STALE_STATEMENT_RETRIES = NODE_POOL_OPTIONS.max;

function replacePositionalPlaceholders(query: string): string {
  let result = "";
  let placeholderIndex = 1;
  let inSingleQuotedString = false;
  let inDoubleQuotedString = false;

  for (let index = 0; index < query.length; index += 1) {
    const char = query[index];
    const next = query[index + 1];

    if (char === "'" && !inDoubleQuotedString) {
      result += char;
      if (inSingleQuotedString && next === "'") {
        result += next;
        index += 1;
        continue;
      }
      inSingleQuotedString = !inSingleQuotedString;
      continue;
    }

    if (char === '"' && !inSingleQuotedString) {
      result += char;
      inDoubleQuotedString = !inDoubleQuotedString;
      continue;
    }

    if (char === "?" && !inSingleQuotedString && !inDoubleQuotedString) {
      result += `$${placeholderIndex}`;
      placeholderIndex += 1;
      continue;
    }

    result += char;
  }

  return result;
}

function normalizeInsertConflictSyntax(query: string): string {
  const match = query.match(
    /^\s*INSERT\s+OR\s+(IGNORE|REPLACE)\s+INTO\s+([^\s(]+)\s*\(([^)]+)\)\s*VALUES\s*([\s\S]*?)\s*;?\s*$/i
  );

  if (!match) {
    return query;
  }

  const [, mode, tableName, columnsSource, valuesSource] = match;
  const columns = columnsSource
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean);

  if (columns.length === 0) {
    return query;
  }

  const baseInsert = `INSERT INTO ${tableName} (${columnsSource}) VALUES ${valuesSource.trim()}`;
  if (mode.toUpperCase() === "IGNORE") {
    return `${baseInsert} ON CONFLICT DO NOTHING`;
  }

  const conflictTarget = columns[0];
  const updateColumns = columns.slice(1);
  const updateClause =
    updateColumns.length > 0
      ? updateColumns.map((column) => `${column} = EXCLUDED.${column}`).join(", ")
      : `${conflictTarget} = EXCLUDED.${conflictTarget}`;

  return `${baseInsert} ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updateClause}`;
}

function normalizeSql(query: string): string {
  return (
    normalizeInsertConflictSyntax(replacePositionalPlaceholders(query))
      // biome-ignore lint/security/noSecrets: SQL datetime literal, not a secret.
      .replaceAll("datetime('now')", "sdp_datetime_now()")
      .replaceAll("STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')", "sdp_iso_now()")
  );
}

class PostgresPreparedStatement implements PreparedStatement {
  constructor(
    private readonly queryable: Queryable,
    private readonly query: string,
    private readonly values: readonly unknown[] = []
  ) {}

  withQueryable(queryable: Queryable): PostgresPreparedStatement {
    return new PostgresPreparedStatement(queryable, this.query, this.values);
  }

  bind(...values: unknown[]): PreparedStatement {
    return new PostgresPreparedStatement(this.queryable, this.query, values);
  }

  async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    const result = await this.queryable.query({
      text: normalizeSql(this.query),
      values: [...this.values],
    });

    const row = (result.rows[0] as Record<string, unknown> | undefined) ?? null;
    if (!row) {
      return null;
    }

    if (columnName) {
      return (row[columnName] as T | undefined) ?? null;
    }

    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<QueryManyResult<T>> {
    const result = await this.queryable.query({
      text: normalizeSql(this.query),
      values: [...this.values],
    });

    const rows = result.rows as T[];
    return {
      results: rows,
      rows,
    };
  }

  async run(): Promise<number> {
    const result = await this.queryable.query({
      text: normalizeSql(this.query),
      values: [...this.values],
    });

    return result.rowCount ?? 0;
  }
}

class PostgresExecutor implements DatabaseExecutor {
  constructor(protected readonly queryable: Queryable) {}

  rebindPreparedStatement(statement: PostgresPreparedStatement): PostgresPreparedStatement {
    return statement.withQueryable(this.queryable);
  }

  prepare(query: string): PreparedStatement {
    return new PostgresPreparedStatement(this.queryable, query);
  }

  async queryOne<T = Record<string, unknown>>(
    query: string,
    params: readonly unknown[] = []
  ): Promise<T | null> {
    return this.prepare(query)
      .bind(...params)
      .first<T>();
  }

  async queryMany<T = Record<string, unknown>>(
    query: string,
    params: readonly unknown[] = []
  ): Promise<T[]> {
    const result = await this.prepare(query)
      .bind(...params)
      .all<T>();
    return result.rows;
  }

  async execute(query: string, params: readonly unknown[] = []): Promise<number> {
    return this.prepare(query)
      .bind(...params)
      .run();
  }
}

abstract class BasePostgresClient extends PostgresExecutor implements DatabaseClient {
  async batch(statements: readonly PreparedStatement[]): Promise<number[]> {
    return this.transaction(async (tx) => {
      const results: number[] = [];
      for (const statement of statements) {
        const result =
          statement instanceof PostgresPreparedStatement && tx instanceof PostgresExecutor
            ? await tx.rebindPreparedStatement(statement).run()
            : await statement.run();
        results.push(result);
      }
      return results;
    });
  }

  abstract transaction<T>(callback: (tx: DatabaseExecutor) => Promise<T>): Promise<T>;
  abstract lockedTransactionWithPostCommit<T>(
    lockKey: string,
    callback: (tx: DatabaseExecutor) => Promise<T>,
    afterCommit: (result: T) => Promise<void>,
    afterRollback?: (result: T) => Promise<void>,
    options?: { wait?: boolean }
  ): Promise<T>;
}

/**
 * Open a transaction stamped with the ambient database identity
 * (src/db/identity.ts) in a single round trip. The GUCs are `SET LOCAL`, so
 * COMMIT/ROLLBACK clears them and pooled connection reuse can never leak an
 * identity across callers. A missing or `none` identity opens a bare
 * transaction — row-level security then denies by default.
 */
async function beginWithDatabaseIdentity(
  client: Queryable,
  identity: DatabaseIdentity | undefined
): Promise<void> {
  if (!identity || identity.kind === "none") {
    await client.query({ text: "BEGIN" });
    return;
  }
  await client.query({ text: `BEGIN; ${databaseIdentityConfigStatement(identity).text}` });
}

/**
 * Queryable for statements issued outside an explicit transaction. When an
 * identity is present, the statement runs in its own short transaction so the
 * transaction-local identity GUCs cover it; without one, the statement goes
 * straight to the pool and RLS fails closed.
 */
class IdentityStampingPoolQueryable implements Queryable {
  constructor(
    private readonly pool: Pool,
    private readonly statementNames: PreparedStatementNames
  ) {}

  async query(args: QueryArgs): Promise<QueryResult> {
    const named = withStatementName(args, this.statementNames);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.queryOnce(named);
      } catch (error) {
        // A migration can leave a prepared statement stale on the connections
        // that prepared it. The statement fails before it runs and its
        // connection is closed, so running it again on the next connection,
        // or a new one, cannot repeat a write.
        if (
          named.name === undefined ||
          attempt >= MAX_STALE_STATEMENT_RETRIES ||
          !isStalePreparedStatementError(error)
        ) {
          throw error;
        }
      }
    }
  }

  private async queryOnce(args: QueryArgs): Promise<QueryResult> {
    const identity = currentDatabaseIdentity();
    if (!identity || identity.kind === "none") {
      try {
        return await this.pool.query(args);
      } catch (error) {
        throw asDatabaseUnavailable(error, this.pool);
      }
    }

    const client = await acquireClient(this.pool);
    let releaseError: Error | undefined;
    try {
      await beginWithDatabaseIdentity(client, identity);
      const result = await client.query(args);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError =
          rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      releaseError ??= staleStatementReleaseError(error);
      throw error;
    } finally {
      client.release(releaseError);
    }
  }
}

class PooledPostgresClient extends BasePostgresClient {
  private readonly pool: Pool;
  private readonly statementNames: PreparedStatementNames;

  constructor(connectionString: string) {
    const pool = new Pool({
      connectionString,
      ...NODE_POOL_OPTIONS,
    });
    const statementNames = new PreparedStatementNames({
      enabled: preparedStatementsEnabled(process.env.DATABASE_PREPARED_STATEMENTS),
    });
    super(new IdentityStampingPoolQueryable(pool, statementNames));
    this.pool = pool;
    this.statementNames = statementNames;

    // Idle pool errors are EventEmitter errors; without a listener Node treats
    // them as uncaught exceptions and terminates the process.
    this.pool.on("error", (error) => {
      getLogger().error({ error }, "Idle PostgreSQL pool client error");
    });
  }

  async transaction<T>(callback: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    const client = await acquireClient(this.pool);
    let releaseError: Error | undefined;

    try {
      await beginWithDatabaseIdentity(client, currentDatabaseIdentity());
      const executor = new PostgresExecutor(namedQueryable(client, this.statementNames));
      const result = await callback(executor);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError =
          rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      releaseError ??= staleStatementReleaseError(error);
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async lockedTransactionWithPostCommit<T>(
    lockKey: string,
    callback: (tx: DatabaseExecutor) => Promise<T>,
    afterCommit: (result: T) => Promise<void>,
    afterRollback?: (result: T) => Promise<void>,
    options?: { wait?: boolean }
  ): Promise<T> {
    const client = await acquireClient(this.pool);
    let releaseError: Error | undefined;
    let transactionOpen = false;
    let lockHeld = false;
    let callbackCompleted = false;
    let callbackResult: T | undefined;
    const wait = options?.wait ?? true;

    try {
      if (wait) {
        await client.query({
          // biome-ignore lint/security/noSecrets: parameterized PostgreSQL function call.
          text: "SELECT pg_advisory_lock(hashtext($1))",
          values: [lockKey],
        });
      } else {
        const lockResult = await client.query({
          // biome-ignore lint/security/noSecrets: parameterized PostgreSQL function call.
          text: "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
          values: [lockKey],
        });
        if (lockResult.rows[0]?.acquired !== true) {
          throw new SessionLockUnavailableError(lockKey);
        }
      }
      lockHeld = true;

      // Marked open before the combined BEGIN + identity stamp: if the stamp
      // half fails, the connection may hold an aborted transaction, and a
      // defensive ROLLBACK on an idle connection is only a warning.
      transactionOpen = true;
      await beginWithDatabaseIdentity(client, currentDatabaseIdentity());
      const executor = new PostgresExecutor(namedQueryable(client, this.statementNames));
      const result = await callback(executor);
      callbackResult = result;
      callbackCompleted = true;
      await client.query("COMMIT");
      transactionOpen = false;

      await afterCommit(result);
      return result;
    } catch (error) {
      let rollbackConfirmed = false;
      if (transactionOpen) {
        try {
          await client.query("ROLLBACK");
          transactionOpen = false;
          rollbackConfirmed = true;
        } catch (rollbackError) {
          releaseError =
            rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        }
      }
      releaseError ??= staleStatementReleaseError(error);
      if (rollbackConfirmed && callbackCompleted && afterRollback) {
        try {
          await afterRollback(callbackResult as T);
        } catch (afterRollbackError) {
          throw new AggregateError(
            [error, afterRollbackError],
            "Database transaction rolled back but its external rollback action failed"
          );
        }
      }
      throw error;
    } finally {
      if (lockHeld) {
        try {
          await client.query({
            // biome-ignore lint/security/noSecrets: parameterized PostgreSQL function call.
            text: "SELECT pg_advisory_unlock(hashtext($1))",
            values: [lockKey],
          });
        } catch (unlockError) {
          releaseError =
            unlockError instanceof Error ? unlockError : new Error(String(unlockError));
        }
      }
      client.release(releaseError);
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

/**
 * Adapt a transaction executor to the full DatabaseClient interface so services
 * and repositories (which are constructed with a DatabaseClient) can run inside
 * an existing transaction opened via `db.transaction(...)`. All calls are
 * forwarded to the same `tx` connection, so every write shares one atomic
 * transaction:
 *   - `batch(...)` runs its statements sequentially on `tx` instead of opening
 *     its own transaction (they are already prepared against `tx`).
 *   - `transaction(cb)` runs the callback inline on `tx` — Postgres has no
 *     nestable BEGIN, and we are already inside one.
 */
export function asTransactionalClient(tx: DatabaseExecutor): DatabaseClient {
  return {
    prepare: (query: string) => tx.prepare(query),
    queryOne<T = Record<string, unknown>>(query: string, params?: readonly unknown[]) {
      return tx.queryOne<T>(query, params);
    },
    queryMany<T = Record<string, unknown>>(query: string, params?: readonly unknown[]) {
      return tx.queryMany<T>(query, params);
    },
    execute(query: string, params?: readonly unknown[]) {
      return tx.execute(query, params);
    },
    async batch(statements: readonly PreparedStatement[]) {
      const results: number[] = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    },
    transaction<T>(callback: (executor: DatabaseExecutor) => Promise<T>) {
      return callback(tx);
    },
    lockedTransactionWithPostCommit() {
      return Promise.reject(
        new Error("A session-locked post-commit action cannot run inside an existing transaction")
      );
    },
  };
}

export function getConnectionString(bindings: DatabaseBindings): string {
  const databaseUrl = bindings.DATABASE_URL?.trim() ?? process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    return databaseUrl;
  }

  throw new Error("A PostgreSQL connection string is required");
}

export function createDatabaseClient(connectionString: string): DatabaseClient {
  const existing = pooledClients.get(connectionString);
  if (existing) {
    return existing;
  }

  const client = new PooledPostgresClient(connectionString);
  pooledClients.set(connectionString, client);
  return client;
}

export function getDb(bindings: DatabaseBindings): DatabaseClient {
  return createDatabaseClient(getConnectionString(bindings));
}

export async function closeDatabasePools(): Promise<void> {
  const pools = [...pooledClients.values()];
  pooledClients.clear();

  const results = await Promise.allSettled(pools.map((client) => client.close()));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to close PostgreSQL pools");
  }
}
