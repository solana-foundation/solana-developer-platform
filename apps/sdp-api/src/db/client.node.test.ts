import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface MockQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

interface SentQuery {
  text: string;
  name?: string;
  values?: unknown[];
}

/** What the client hands the driver: a bare command or a statement with its values. */
type SentInput = string | SentQuery;

interface MockPoolClient {
  queries: [SentInput][];
  release: ReturnType<typeof vi.fn>;
}

interface MockPool {
  config: Record<string, unknown>;
  queries: SentQuery[];
  connectedClients: MockPoolClient[];
  end: ReturnType<typeof vi.fn>;
}

interface PgMockState {
  DatabaseError: new (message: string) => Error & { code: string | undefined };
  pools: MockPool[];
  connectError: Error | undefined;
  lastClientQuery: SentInput | undefined;
  poolQuery: () => Promise<MockQueryResult>;
  poolClientQuery: () => Promise<MockQueryResult>;
  poolEnd: () => Promise<void>;
}

const pgMock = vi.hoisted((): PgMockState => {
  // One class for every evaluation of the "pg" mock factory below, so
  // `instanceof` agrees between the client under test and the errors built here.
  class DatabaseError extends Error {
    code: string | undefined = undefined;
  }

  return {
    DatabaseError,
    pools: [],
    connectError: undefined,
    lastClientQuery: undefined,
    poolQuery: async () => ({ rows: [], rowCount: 0 }),
    poolClientQuery: async () => ({ rows: [], rowCount: 0 }),
    poolEnd: async () => {},
  };
});

vi.mock("pg", () => {
  class Pool {
    readonly config: Record<string, unknown>;
    readonly queries: SentQuery[] = [];
    readonly connectedClients: MockPoolClient[] = [];
    readonly end = vi.fn(() => pgMock.poolEnd());
    readonly totalCount = 10;
    readonly idleCount = 0;
    readonly waitingCount = 3;

    constructor(config: Record<string, unknown>) {
      this.config = config;
      pgMock.pools.push(this);
    }

    on(): this {
      return this;
    }

    async query(args: SentQuery): Promise<MockQueryResult> {
      this.queries.push(args);
      return pgMock.poolQuery();
    }

    async connect(): Promise<
      MockPoolClient & { query: (input: SentInput) => Promise<MockQueryResult> }
    > {
      if (pgMock.connectError) {
        throw pgMock.connectError;
      }
      const queries: [SentInput][] = [];
      const client = {
        queries,
        query: async (input: SentInput): Promise<MockQueryResult> => {
          queries.push([input]);
          pgMock.lastClientQuery = input;
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
    DatabaseError: pgMock.DatabaseError,
    types: { setTypeParser: vi.fn() },
  };
});

const STATUS_QUERY = "SELECT status FROM organizations WHERE id = ?";

/** A failure the server reported, with its SQLSTATE. */
function serverError(code: string, message: string): Error {
  return Object.assign(new pgMock.DatabaseError(message), { code });
}

function staleStatement(): Error {
  return serverError("0A000", "cached plan must not change result type");
}

function isNamedQuery(query: SentInput | undefined): boolean {
  return typeof query === "object" && query.name !== undefined;
}

function firstPool(): MockPool {
  const [pool] = pgMock.pools;
  if (pool === undefined) {
    throw new Error("expected the client to create a pool");
  }
  return pool;
}

function connectedClient(index: number): MockPoolClient {
  const client = firstPool().connectedClients.at(index);
  if (client === undefined) {
    throw new Error(`expected a connected client at ${index}`);
  }
  return client;
}

let closeDatabasePools: typeof import("./client").closeDatabasePools;
let createDatabaseClient: typeof import("./client").createDatabaseClient;
let SessionLockUnavailableError: typeof import("./client").SessionLockUnavailableError;
let DatabaseUnavailableError: typeof import("./client").DatabaseUnavailableError;
let runWithTenantDatabaseIdentity: typeof import("./identity").runWithTenantDatabaseIdentity;

describe("database client connection management", () => {
  beforeAll(async () => {
    // Reload this module after installing the pg mock so targeted runs always
    // exercise the mocked client, regardless of import timing within the file.
    vi.resetModules();
    const database = await import("./client");
    closeDatabasePools = database.closeDatabasePools;
    createDatabaseClient = database.createDatabaseClient;
    SessionLockUnavailableError = database.SessionLockUnavailableError;
    DatabaseUnavailableError = database.DatabaseUnavailableError;
    // The same module instance the client reads its ambient identity from.
    runWithTenantDatabaseIdentity = (await import("./identity")).runWithTenantDatabaseIdentity;
  });

  beforeEach(async () => {
    await closeDatabasePools();
    pgMock.pools.length = 0;
    pgMock.connectError = undefined;
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
      expect.objectContaining({ text: "BEGIN" }),
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
      expect.objectContaining({ text: "BEGIN" }),
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
      expect.objectContaining({ text: "BEGIN" }),
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

  it("does not wait for a busy session lock", async () => {
    pgMock.poolClientQuery = async () => ({
      rows: [{ acquired: false }],
      rowCount: 1,
    });
    const db = createDatabaseClient("postgresql://node-try-lock-busy/sdp");
    const afterCommit = vi.fn();

    const operation = db.lockedTransactionWithPostCommit?.(
      "rings-rekey",
      async () => "claimed",
      afterCommit,
      undefined,
      { wait: false }
    );
    if (!operation) throw new Error("locked post-commit transactions are unavailable");
    await expect(operation).rejects.toBeInstanceOf(SessionLockUnavailableError);

    const client = pgMock.pools[0]?.connectedClients[0];
    expect(client?.queries.map(([query]) => query)).toEqual([
      expect.objectContaining({ text: "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired" }),
    ]);
    expect(afterCommit).not.toHaveBeenCalled();
    expect(client?.release).toHaveBeenCalledWith(undefined);
  });

  it("acquires a session lock without waiting when the lock is free", async () => {
    pgMock.poolClientQuery = async () => {
      const client = pgMock.pools[0]?.connectedClients[0];
      const latestQuery = client?.queries.at(-1)?.[0];
      if (
        typeof latestQuery === "object" &&
        latestQuery &&
        "text" in latestQuery &&
        latestQuery.text === "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired"
      ) {
        return { rows: [{ acquired: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const db = createDatabaseClient("postgresql://node-try-lock-free/sdp");

    const operation = db.lockedTransactionWithPostCommit?.(
      "rings-rekey",
      async (tx) => {
        await tx.execute("UPDATE wallets SET updated_at = datetime('now')");
        return "claimed";
      },
      async () => {},
      undefined,
      { wait: false }
    );
    if (!operation) throw new Error("locked post-commit transactions are unavailable");
    await operation;

    const client = pgMock.pools[0]?.connectedClients[0];
    expect(client?.queries.map(([query]) => query)).toEqual([
      expect.objectContaining({ text: "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired" }),
      expect.objectContaining({ text: "BEGIN" }),
      expect.objectContaining({ text: "UPDATE wallets SET updated_at = sdp_datetime_now()" }),
      "COMMIT",
      expect.objectContaining({ text: "SELECT pg_advisory_unlock(hashtext($1))" }),
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
      expect.objectContaining({ text: "BEGIN" }),
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
      expect.objectContaining({ text: "BEGIN" }),
      expect.objectContaining({ text: "UPDATE wallets SET updated_at = sdp_datetime_now()" }),
      "ROLLBACK",
    ]);
    expect(client?.release).toHaveBeenCalledWith(rollbackFailure);
  });

  it("runs a repeated statement under a server-side name from its second execution", async () => {
    const db = createDatabaseClient("postgresql://node-named-statements/sdp");

    await db.queryOne(STATUS_QUERY, ["org_1"]);
    await db.queryOne(STATUS_QUERY, ["org_1"]);
    await db.queryOne(STATUS_QUERY, ["org_2"]);

    const { queries } = firstPool();
    const names = queries.map((query) => query.name);
    expect(names[0]).toBeUndefined();
    expect(names[1]).toMatch(/^sdp_[0-9a-f]{32}$/);
    expect(names[2]).toBe(names[1]);
    expect(queries[2]).toMatchObject({
      text: "SELECT status FROM organizations WHERE id = $1",
      values: ["org_2"],
    });
  });

  it("names a transaction's repeated statements and leaves its control statements unnamed", async () => {
    const db = createDatabaseClient("postgresql://node-named-transaction/sdp");

    for (let run = 0; run < 2; run += 1) {
      await db.transaction(async (tx) => {
        await tx.queryOne(STATUS_QUERY, ["org_1"]);
      });
    }

    const sent = firstPool().connectedClients.flatMap((client) =>
      client.queries.map(([query]) => query)
    );
    const statements = sent.filter(
      (query): query is SentQuery => typeof query === "object" && query.text !== "BEGIN"
    );
    expect(statements.map((query) => query.name === undefined)).toEqual([true, false]);
    expect(sent.filter(isNamedQuery)).toHaveLength(1);
  });

  it("leaves SQL that is not one plannable statement unnamed", async () => {
    const db = createDatabaseClient("postgresql://node-unnamed-statements/sdp");

    for (let run = 0; run < 3; run += 1) {
      await db.execute("SET LOCAL idle_in_transaction_session_timeout = 0");
      await db.execute("SELECT 1; SELECT 2");
    }

    const { queries } = firstPool();
    expect(queries).toHaveLength(6);
    expect(queries.some(isNamedQuery)).toBe(false);
  });

  it("sends every statement unnamed when DATABASE_PREPARED_STATEMENTS is off", async () => {
    vi.stubEnv("DATABASE_PREPARED_STATEMENTS", "off");
    try {
      const db = createDatabaseClient("postgresql://node-prepared-statements-off/sdp");

      for (let run = 0; run < 4; run += 1) {
        await db.queryOne(STATUS_QUERY, ["org_1"]);
      }

      const { queries } = firstPool();
      expect(queries).toHaveLength(4);
      expect(queries.some(isNamedQuery)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("runs a stale named statement again after the pool drops its connection", async () => {
    const db = createDatabaseClient("postgresql://node-stale-pool/sdp");
    await db.queryOne(STATUS_QUERY, ["org_1"]);
    await db.queryOne(STATUS_QUERY, ["org_1"]);
    let failures = 1;
    pgMock.poolQuery = async () => {
      if (failures > 0) {
        failures -= 1;
        throw staleStatement();
      }
      return { rows: [{ status: "active" }], rowCount: 1 };
    };

    await expect(db.queryOne(STATUS_QUERY, ["org_1"])).resolves.toEqual({ status: "active" });

    expect(firstPool().queries).toHaveLength(4);
  });

  it("closes the connection that held a stale statement and runs it on another", async () => {
    const db = createDatabaseClient("postgresql://node-stale-identity/sdp");
    const run = () =>
      runWithTenantDatabaseIdentity({ organizationId: "org_1" }, () =>
        db.queryOne(STATUS_QUERY, ["org_1"])
      );
    await run();
    await run();
    const stale = staleStatement();
    let failures = 1;
    pgMock.poolClientQuery = async () => {
      if (failures > 0 && isNamedQuery(pgMock.lastClientQuery)) {
        failures -= 1;
        throw stale;
      }
      return { rows: [{ status: "active" }], rowCount: 1 };
    };

    await expect(run()).resolves.toEqual({ status: "active" });

    const failed = connectedClient(2);
    const retried = connectedClient(3);
    expect(failed.queries.map(([query]) => query)).toEqual([
      expect.objectContaining({ text: expect.stringContaining("BEGIN") }),
      expect.objectContaining({ name: expect.stringMatching(/^sdp_/) }),
      "ROLLBACK",
    ]);
    expect(failed.release).toHaveBeenCalledWith(stale);
    expect(retried.release).toHaveBeenCalledWith(undefined);
  });

  it("does not run a stale error again for a statement that has no name", async () => {
    const stale = staleStatement();
    pgMock.poolQuery = async () => {
      throw stale;
    };
    const db = createDatabaseClient("postgresql://node-stale-unnamed/sdp");

    await expect(db.queryOne(STATUS_QUERY, ["org_1"])).rejects.toBe(stale);

    expect(firstPool().queries).toHaveLength(1);
  });

  it("gives up once a statement is stale on every connection the pool can hold", async () => {
    const db = createDatabaseClient("postgresql://node-stale-everywhere/sdp");
    await db.queryOne(STATUS_QUERY, ["org_1"]);
    await db.queryOne(STATUS_QUERY, ["org_1"]);
    const stale = staleStatement();
    pgMock.poolQuery = async () => {
      throw stale;
    };

    await expect(db.queryOne(STATUS_QUERY, ["org_1"])).rejects.toBe(stale);

    // The first attempt plus one retry per pooled connection.
    expect(firstPool().queries).toHaveLength(2 + 1 + 10);
  });

  it("closes a transaction's connection when a statement in it went stale", async () => {
    const db = createDatabaseClient("postgresql://node-stale-transaction/sdp");
    await db.queryOne(STATUS_QUERY, ["org_1"]);
    await db.queryOne(STATUS_QUERY, ["org_1"]);
    const stale = staleStatement();
    pgMock.poolClientQuery = async () => {
      if (isNamedQuery(pgMock.lastClientQuery)) {
        throw stale;
      }
      return { rows: [], rowCount: 0 };
    };

    await expect(db.transaction((tx) => tx.queryOne(STATUS_QUERY, ["org_1"]))).rejects.toBe(stale);

    const client = connectedClient(-1);
    expect(client.queries.map(([query]) => query)).toEqual([
      expect.objectContaining({ text: "BEGIN" }),
      expect.objectContaining({ name: expect.stringMatching(/^sdp_/) }),
      "ROLLBACK",
    ]);
    expect(client.release).toHaveBeenCalledWith(stale);
  });

  it.each([
    [
      "the pool's wait for a free connection ran out",
      new Error("timeout exceeded when trying to connect"),
    ],
    [
      "a new connection could not be opened in time",
      new Error("Connection terminated due to connection timeout"),
    ],
    [
      "the server has no connection slots left",
      serverError("53300", "sorry, too many clients already"),
    ],
    ["the server is starting up", serverError("57P03", "the database system is starting up")],
  ])("reports a database that cannot take work when %s", async (_reason, failure) => {
    pgMock.connectError = failure;
    const db = createDatabaseClient("postgresql://node-unavailable/sdp");

    const error = await db.transaction(async () => {}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DatabaseUnavailableError);
    expect(error).toMatchObject({
      cause: failure,
      pool: { total: 10, idle: 0, waiting: 3 },
      message: expect.stringContaining("(pool: 10 open, 0 idle, 3 waiting)"),
    });
  });

  it("reports an unavailable database from every way the client takes a connection", async () => {
    const failure = new Error("timeout exceeded when trying to connect");
    pgMock.connectError = failure;
    const db = createDatabaseClient("postgresql://node-unavailable-everywhere/sdp");

    await expect(
      runWithTenantDatabaseIdentity({ organizationId: "org_1" }, () => db.queryOne("SELECT 1"))
    ).rejects.toBeInstanceOf(DatabaseUnavailableError);
    const locked = db.lockedTransactionWithPostCommit?.(
      "audit-checkpoint",
      async () => "done",
      async () => {}
    );
    if (!locked) throw new Error("locked post-commit transactions are unavailable");
    await expect(locked).rejects.toBeInstanceOf(DatabaseUnavailableError);
    pgMock.connectError = undefined;
    pgMock.poolQuery = async () => {
      throw failure;
    };
    await expect(db.queryOne("SELECT 1")).rejects.toBeInstanceOf(DatabaseUnavailableError);
  });

  it("passes other connection errors and failing statements through unchanged", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), {
      code: "ECONNREFUSED",
    });
    pgMock.connectError = refused;
    const db = createDatabaseClient("postgresql://node-other-errors/sdp");
    await expect(db.transaction(async () => {})).rejects.toBe(refused);

    const duplicate = serverError("23505", "duplicate key value");
    pgMock.connectError = undefined;
    pgMock.poolQuery = async () => {
      throw duplicate;
    };
    await expect(db.execute("INSERT INTO t (id) VALUES (?)", ["a"])).rejects.toBe(duplicate);
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
