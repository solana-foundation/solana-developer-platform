import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface MockQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

interface MockPoolClient {
  queries: unknown[][];
  release: ReturnType<typeof vi.fn>;
}

interface MockPool {
  config: Record<string, unknown>;
  queries: unknown[];
  connectedClients: MockPoolClient[];
  end: ReturnType<typeof vi.fn>;
}

const pgMock = vi.hoisted(() => ({
  pools: [] as MockPool[],
  poolQuery: async (): Promise<MockQueryResult> => ({ rows: [], rowCount: 0 }),
  poolClientQuery: async (): Promise<MockQueryResult> => ({ rows: [], rowCount: 0 }),
  poolEnd: async (): Promise<void> => {},
}));

vi.mock("pg", () => {
  class Pool {
    readonly config: Record<string, unknown>;
    readonly queries: unknown[] = [];
    readonly connectedClients: MockPoolClient[] = [];
    readonly end = vi.fn(() => pgMock.poolEnd());

    constructor(config: Record<string, unknown>) {
      this.config = config;
      pgMock.pools.push(this);
    }

    on(): this {
      return this;
    }

    async query(args: unknown): Promise<MockQueryResult> {
      this.queries.push(args);
      return pgMock.poolQuery();
    }

    async connect(): Promise<
      MockPoolClient & { query: (...args: unknown[]) => Promise<MockQueryResult> }
    > {
      const client = {
        queries: [] as unknown[][],
        query: async (...args: unknown[]): Promise<MockQueryResult> => {
          client.queries.push(args);
          return pgMock.poolClientQuery();
        },
        release: vi.fn(),
      };
      this.connectedClients.push(client);
      return client;
    }
  }

  return {
    Pool,
    types: { setTypeParser: vi.fn() },
  };
});

let closeDatabasePools: typeof import("./client").closeDatabasePools;
let createDatabaseClient: typeof import("./client").createDatabaseClient;

describe("database client connection management", () => {
  beforeAll(async () => {
    // Reload this module after installing the pg mock so targeted runs always
    // exercise the mocked client, regardless of import timing within the file.
    vi.resetModules();
    const database = await import("./client");
    closeDatabasePools = database.closeDatabasePools;
    createDatabaseClient = database.createDatabaseClient;
  });

  beforeEach(async () => {
    await closeDatabasePools();
    pgMock.pools.length = 0;
    pgMock.poolQuery = async () => ({ rows: [], rowCount: 0 });
    pgMock.poolClientQuery = async () => ({ rows: [], rowCount: 0 });
    pgMock.poolEnd = async () => {};
  });

  afterEach(async () => {
    pgMock.poolEnd = async () => {};
    await closeDatabasePools();
  });

  it("reuses one configured pool and starts independent Node queries concurrently", async () => {
    const pendingQueries: Array<() => void> = [];
    pgMock.poolQuery = () =>
      new Promise<MockQueryResult>((resolve) => {
        pendingQueries.push(() => resolve({ rows: [], rowCount: 0 }));
      });

    const db = createDatabaseClient("postgresql://node-database/sdp");
    const sameDb = createDatabaseClient("postgresql://node-database/sdp");
    const queries = Array.from({ length: 4 }, () => db.queryOne("SELECT 1"));

    await vi.waitFor(() => {
      expect(pendingQueries).toHaveLength(4);
    });
    expect(sameDb).toBe(db);
    expect(pgMock.pools).toHaveLength(1);
    expect(pgMock.pools[0]?.config).toMatchObject({
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      maxLifetimeSeconds: 300,
      keepAlive: true,
    });

    for (const resolve of pendingQueries) {
      resolve();
    }
    await Promise.all(queries);
  });

  it("checks out one pooled connection and commits a successful transaction", async () => {
    const db = createDatabaseClient("postgresql://node-transaction/sdp");

    await db.transaction(async (tx) => {
      await tx.execute("UPDATE wallets SET updated_at = datetime('now')");
      await tx.queryOne("SELECT 1");
    });

    const client = pgMock.pools[0]?.connectedClients[0];
    expect(pgMock.pools[0]?.connectedClients).toHaveLength(1);
    expect(client?.queries.map(([query]) => query)).toEqual([
      "BEGIN",
      expect.objectContaining({ text: "UPDATE wallets SET updated_at = sdp_datetime_now()" }),
      expect.objectContaining({ text: "SELECT 1" }),
      "COMMIT",
    ]);
    expect(client?.release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases the pooled connection when a transaction fails", async () => {
    const db = createDatabaseClient("postgresql://node-rollback/sdp");
    const failure = new Error("write failed");

    await expect(
      db.transaction(async (tx) => {
        await tx.execute("UPDATE wallets SET updated_at = datetime('now')");
        throw failure;
      })
    ).rejects.toBe(failure);

    const client = pgMock.pools[0]?.connectedClients[0];
    expect(client?.queries.map(([query]) => query)).toEqual([
      "BEGIN",
      expect.objectContaining({ text: "UPDATE wallets SET updated_at = sdp_datetime_now()" }),
      "ROLLBACK",
    ]);
    expect(client?.release).toHaveBeenCalledWith(undefined);
  });

  it("commits before the session-locked post-commit action", async () => {
    const events: string[] = [];
    pgMock.poolClientQuery = async () => {
      events.push("database");
      return { rows: [], rowCount: 0 };
    };
    const db = createDatabaseClient("postgresql://node-post-commit/sdp");

    const operation = db.lockedTransactionWithPostCommit?.(
      "audit-checkpoint",
      async (tx) => {
        await tx.execute("INSERT INTO audit_logs (id) VALUES (?)", ["aud_1"]);
        return "committed";
      },
      async (result) => {
        expect(result).toBe("committed");
        events.push("external");
      }
    );
    if (!operation) throw new Error("locked post-commit transactions are unavailable");
    await operation;

    const client = pgMock.pools[0]?.connectedClients[0];
    expect(client?.queries.map(([query]) => query)).toEqual([
      expect.objectContaining({ text: "SELECT pg_advisory_lock(hashtext($1))" }),
      "BEGIN",
      expect.objectContaining({ text: "INSERT INTO audit_logs (id) VALUES ($1)" }),
      "COMMIT",
      expect.objectContaining({ text: "SELECT pg_advisory_unlock(hashtext($1))" }),
    ]);
    expect(events).toEqual([
      "database",
      "database",
      "database",
      "database",
      "external",
      "database",
    ]);
    expect(client?.release).toHaveBeenCalledWith(undefined);
  });

  it("does not run a post-commit action when commit fails", async () => {
    const commitFailure = new Error("commit failed");
    pgMock.poolClientQuery = async () => {
      const client = pgMock.pools[0]?.connectedClients[0];
      const latestQuery = client?.queries.at(-1)?.[0];
      if (latestQuery === "COMMIT") throw commitFailure;
      return { rows: [], rowCount: 0 };
    };
    const db = createDatabaseClient("postgresql://node-post-commit-failure/sdp");
    const afterCommit = vi.fn();
    const afterRollback = vi.fn();

    const operation = db.lockedTransactionWithPostCommit?.(
      "audit-checkpoint",
      async (tx) => {
        await tx.execute("INSERT INTO audit_logs (id) VALUES (?)", ["aud_1"]);
      },
      afterCommit,
      afterRollback
    );
    if (!operation) throw new Error("locked post-commit transactions are unavailable");
    await expect(operation).rejects.toBe(commitFailure);

    const client = pgMock.pools[0]?.connectedClients[0];
    expect(client?.queries.map(([query]) => query)).toEqual([
      expect.objectContaining({ text: "SELECT pg_advisory_lock(hashtext($1))" }),
      "BEGIN",
      expect.objectContaining({ text: "INSERT INTO audit_logs (id) VALUES ($1)" }),
      "COMMIT",
      "ROLLBACK",
      expect.objectContaining({ text: "SELECT pg_advisory_unlock(hashtext($1))" }),
    ]);
    expect(afterCommit).not.toHaveBeenCalled();
    expect(afterRollback).toHaveBeenCalledOnce();
    expect(afterRollback).toHaveBeenCalledWith(undefined);
  });

  it("does not run an external rollback action when PostgreSQL cannot confirm rollback", async () => {
    const commitFailure = new Error("commit failed");
    const rollbackFailure = new Error("connection lost during rollback");
    pgMock.poolClientQuery = async () => {
      const client = pgMock.pools[0]?.connectedClients[0];
      const latestQuery = client?.queries.at(-1)?.[0];
      if (latestQuery === "COMMIT") throw commitFailure;
      if (latestQuery === "ROLLBACK") throw rollbackFailure;
      return { rows: [], rowCount: 0 };
    };
    const db = createDatabaseClient("postgresql://node-ambiguous-commit/sdp");
    const afterRollback = vi.fn();

    const operation = db.lockedTransactionWithPostCommit?.(
      "audit-checkpoint",
      async (tx) => {
        await tx.execute("INSERT INTO audit_logs (id) VALUES (?)", ["aud_1"]);
      },
      vi.fn(),
      afterRollback
    );
    if (!operation) throw new Error("locked post-commit transactions are unavailable");
    await expect(operation).rejects.toBe(commitFailure);

    expect(afterRollback).not.toHaveBeenCalled();
    const client = pgMock.pools[0]?.connectedClients[0];
    expect(client?.release).toHaveBeenCalledWith(rollbackFailure);
  });

  it("discards the pooled connection when rollback fails", async () => {
    const transactionFailure = new Error("write failed");
    const rollbackFailure = new Error("connection reset during rollback");
    let queryCount = 0;
    pgMock.poolClientQuery = async () => {
      queryCount += 1;
      if (queryCount === 3) {
        throw rollbackFailure;
      }
      return { rows: [], rowCount: 0 };
    };
    const db = createDatabaseClient("postgresql://node-rollback-connection-error/sdp");

    await expect(
      db.transaction(async (tx) => {
        await tx.execute("UPDATE wallets SET updated_at = datetime('now')");
        throw transactionFailure;
      })
    ).rejects.toBe(transactionFailure);

    const client = pgMock.pools[0]?.connectedClients[0];
    expect(client?.queries.map(([query]) => query)).toEqual([
      "BEGIN",
      expect.objectContaining({ text: "UPDATE wallets SET updated_at = sdp_datetime_now()" }),
      "ROLLBACK",
    ]);
    expect(client?.release).toHaveBeenCalledWith(rollbackFailure);
  });

  it("waits for every pool to close before shutdown completes", async () => {
    let resolveEnd: (() => void) | undefined;
    pgMock.poolEnd = () =>
      new Promise<void>((resolve) => {
        resolveEnd = resolve;
      });

    createDatabaseClient("postgresql://node-shutdown/sdp");
    let closed = false;
    const closing = closeDatabasePools().then(() => {
      closed = true;
    });

    await vi.waitFor(() => {
      expect(resolveEnd).toBeTypeOf("function");
    });
    expect(closed).toBe(false);
    resolveEnd?.();
    await closing;

    expect(pgMock.pools[0]?.end).toHaveBeenCalledOnce();
    expect(closed).toBe(true);
  });

  it("surfaces pool shutdown failures", async () => {
    pgMock.poolEnd = async () => {
      throw new Error("pool close failed");
    };
    createDatabaseClient("postgresql://node-shutdown-error/sdp");

    await expect(closeDatabasePools()).rejects.toThrow("Failed to close PostgreSQL pools");
  });
});
