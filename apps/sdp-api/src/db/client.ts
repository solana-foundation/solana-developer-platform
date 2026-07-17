import { Client, Pool, type QueryResult, types } from "pg";

types.setTypeParser(20, (value) => Number.parseInt(value, 10));

export interface HyperdriveBinding {
  connectionString: string;
}

export interface DatabaseBindings {
  HYPERDRIVE?: HyperdriveBinding | null;
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
}

interface QueryArgs {
  text: string;
  values?: unknown[];
}

type Queryable = {
  query: (args: QueryArgs) => Promise<QueryResult>;
};

const pooledClients = new Map<string, PooledPostgresClient>();
const hyperdriveClients = new Map<string, HyperdrivePostgresClient>();

const NODE_POOL_OPTIONS = {
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  maxLifetimeSeconds: 300,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
} as const;

class ConnectionCoordinator implements Queryable {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly connectionString: string) {}

  async query(args: QueryArgs): Promise<QueryResult> {
    return this.runExclusive(async () => {
      const client = new Client({
        connectionString: this.connectionString,
      });

      try {
        await client.connect();
        return await client.query(args.text, args.values);
      } finally {
        await client.end().catch(() => {});
      }
    });
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release: (() => void) | undefined;
    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

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
}

class HyperdrivePostgresClient extends BasePostgresClient {
  private readonly coordinator: ConnectionCoordinator;

  constructor(private readonly connectionString: string) {
    const coordinator = new ConnectionCoordinator(connectionString);
    super(coordinator);
    this.coordinator = coordinator;
  }

  async transaction<T>(callback: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.coordinator.runExclusive(async () => {
      const client = new Client({
        connectionString: this.connectionString,
      });

      try {
        await client.connect();
        await client.query("BEGIN");
        const executor = new PostgresExecutor(client);
        const result = await callback(executor);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        await client.end().catch(() => {});
      }
    });
  }
}

class PooledPostgresClient extends BasePostgresClient {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    const pool = new Pool({
      connectionString,
      ...NODE_POOL_OPTIONS,
    });
    super(pool);
    this.pool = pool;

    // Idle pool errors are EventEmitter errors; without a listener Node treats
    // them as uncaught exceptions and terminates the process.
    this.pool.on("error", (error) => {
      console.error("Idle PostgreSQL pool client error:", error);
    });
  }

  async transaction<T>(callback: (tx: DatabaseExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const executor = new PostgresExecutor(client);
      const result = await callback(executor);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
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
  };
}

export function getConnectionString(bindings: DatabaseBindings): string {
  const hyperdriveUrl = bindings.HYPERDRIVE?.connectionString?.trim();
  if (hyperdriveUrl) {
    return hyperdriveUrl;
  }

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
  const hyperdriveUrl = bindings.HYPERDRIVE?.connectionString?.trim();
  if (hyperdriveUrl) {
    const existing = hyperdriveClients.get(hyperdriveUrl);
    if (existing) {
      return existing;
    }

    const client = new HyperdrivePostgresClient(hyperdriveUrl);
    hyperdriveClients.set(hyperdriveUrl, client);
    return client;
  }

  return createDatabaseClient(getConnectionString(bindings));
}

export async function closeDatabasePools(): Promise<void> {
  const pools = [...pooledClients.values()];
  pooledClients.clear();
  hyperdriveClients.clear();

  const results = await Promise.allSettled(pools.map((client) => client.close()));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to close PostgreSQL pools");
  }
}
