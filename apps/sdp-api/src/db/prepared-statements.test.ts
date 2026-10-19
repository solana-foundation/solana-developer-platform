import { DatabaseError, type QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  isStalePreparedStatementError,
  type LeasedConnection,
  MAX_NAMED_STATEMENTS,
  PreparedStatementNames,
  type QueryArgs,
  StatementCache,
} from "./prepared-statements";

const SELECT_ORG = "SELECT status FROM organizations WHERE id = $1";
const SELECT_KEY = "SELECT status FROM api_keys WHERE id = $1";
const SELECT_WALLET = "SELECT id FROM custody_wallets WHERE wallet_id = $1";

function limitedTo(maxNames: number): PreparedStatementNames {
  return new PreparedStatementNames({ enabled: true, maxNames });
}

function unlimited(): PreparedStatementNames {
  return limitedTo(MAX_NAMED_STATEMENTS);
}

function serverError(code: string, message: string): DatabaseError {
  return Object.assign(new DatabaseError(message, 0, "error"), { code });
}

describe("PreparedStatementNames", () => {
  it("names a statement on its second sighting and keeps that name", () => {
    const names = unlimited();

    expect(names.nameFor(SELECT_ORG)).toBeUndefined();
    const name = names.nameFor(SELECT_ORG);
    expect(name).toMatch(/^sdp_[0-9a-f]{32}$/);
    expect(names.nameFor(SELECT_ORG)).toBe(name);
  });

  it("derives the name from the text so every connection agrees on it", () => {
    const first = unlimited();
    const second = unlimited();
    for (const names of [first, second]) {
      names.nameFor(SELECT_ORG);
    }

    expect(first.nameFor(SELECT_ORG)).toBe(second.nameFor(SELECT_ORG));
  });

  it("gives different statements different names, inside PostgreSQL's 63 byte limit", () => {
    const names = unlimited();
    for (const text of [SELECT_ORG, SELECT_KEY]) {
      names.nameFor(text);
    }

    const orgName = names.nameFor(SELECT_ORG);
    const keyName = names.nameFor(SELECT_KEY);
    expect(orgName).toMatch(/^sdp_[0-9a-f]{32}$/);
    expect(keyName).toMatch(/^sdp_[0-9a-f]{32}$/);
    expect(orgName).not.toBe(keyName);
  });

  it.each([
    ["a session setting", "SET LOCAL idle_in_transaction_session_timeout = 0"],
    ["a transaction command", "BEGIN"],
    ["a DDL statement", "CREATE TABLE scratch (id INTEGER)"],
    ["two statements", "SELECT 1; SELECT 2"],
    ["a statement with a second one after a semicolon", "UPDATE a SET b = 1; DELETE FROM c"],
  ])("never names %s", (_label, text) => {
    const names = unlimited();

    for (let sighting = 0; sighting < 5; sighting += 1) {
      expect(names.nameFor(text)).toBeUndefined();
    }
  });

  it.each([
    ["a select", SELECT_ORG],
    ["an insert", "INSERT INTO t (a) VALUES ($1) RETURNING a"],
    ["an update", "UPDATE t SET a = $1 WHERE id = $2"],
    ["a delete", "DELETE FROM t WHERE id = $1"],
    ["a CTE", "WITH x AS (SELECT 1) SELECT * FROM x"],
    ["lowercase SQL", "select 1 from t where id = $1"],
    ["a statement ending in a semicolon", "SELECT status FROM organizations WHERE id = $1;"],
  ])("names %s", (_label, text) => {
    const names = unlimited();
    names.nameFor(text);

    expect(names.nameFor(text)).toMatch(/^sdp_[0-9a-f]{32}$/);
  });

  it("does not let a statement seen once take one of the limited names", () => {
    const names = limitedTo(1);

    names.nameFor("SELECT 'one-off literal 1'");
    names.nameFor(SELECT_ORG);

    expect(names.nameFor(SELECT_ORG)).toMatch(/^sdp_[0-9a-f]{32}$/);
  });

  it("stops naming new statements at the limit and keeps the names it gave", () => {
    const names = limitedTo(2);
    for (const text of [SELECT_ORG, SELECT_KEY, SELECT_WALLET]) {
      names.nameFor(text);
    }

    const orgName = names.nameFor(SELECT_ORG);
    const keyName = names.nameFor(SELECT_KEY);
    expect(orgName).toMatch(/^sdp_/);
    expect(keyName).toMatch(/^sdp_/);
    expect(names.nameFor(SELECT_WALLET)).toBeUndefined();
    expect(names.nameFor(SELECT_WALLET)).toBeUndefined();
    expect(names.nameFor(SELECT_ORG)).toBe(orgName);
  });

  it("names nothing when turned off", () => {
    const names = new PreparedStatementNames({ enabled: false, maxNames: MAX_NAMED_STATEMENTS });

    for (let sighting = 0; sighting < 5; sighting += 1) {
      expect(names.nameFor(SELECT_ORG)).toBeUndefined();
    }
  });
});

describe("isStalePreparedStatementError", () => {
  it("recognizes a result type change after a migration", () => {
    expect(
      isStalePreparedStatementError(serverError("0A000", "cached plan must not change result type"))
    ).toBe(true);
  });

  it("recognizes a statement that no longer exists on the connection", () => {
    expect(
      isStalePreparedStatementError(
        serverError("26000", 'prepared statement "sdp_1" does not exist')
      )
    ).toBe(true);
  });

  it("leaves every other 0A000 and every other code alone", () => {
    expect(isStalePreparedStatementError(serverError("0A000", "unsupported operation"))).toBe(
      false
    );
    expect(isStalePreparedStatementError(serverError("23505", "duplicate key value"))).toBe(false);
    expect(
      isStalePreparedStatementError(serverError("42P01", "cached plan must not change result type"))
    ).toBe(false);
  });
});

const ROWS: QueryResult = { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] };
const STALE = serverError("0A000", "cached plan must not change result type");

function connection(query: LeasedConnection["query"]) {
  return { query, release: vi.fn<LeasedConnection["release"]>() };
}

function cacheOf(maxStaleRetries: number): StatementCache {
  return new StatementCache({ enabled: true, maxNames: MAX_NAMED_STATEMENTS }, maxStaleRetries);
}

describe("StatementCache", () => {
  it("returns a connection that ran its statements fine", async () => {
    const cache = cacheOf(3);
    const conn = connection(async () => ROWS);

    await cache.on(conn).query({ text: SELECT_ORG, values: ["org_1"] });
    cache.release(conn, undefined);

    expect(conn.release).toHaveBeenCalledWith(undefined);
  });

  it("closes a connection a statement went stale on, whatever else happened to it", async () => {
    const cache = cacheOf(3);
    const conn = connection(async () => {
      throw STALE;
    });

    await expect(cache.on(conn).query({ text: SELECT_ORG })).rejects.toBe(STALE);
    cache.release(conn, undefined);
    expect(conn.release).toHaveBeenLastCalledWith(STALE);

    const rollbackFailure = new Error("connection lost during rollback");
    cache.release(conn, rollbackFailure);
    expect(conn.release).toHaveBeenLastCalledWith(rollbackFailure);
  });

  it("does not close a connection over a failure that is not a stale statement", async () => {
    const cache = cacheOf(3);
    const conn = connection(async () => {
      throw serverError("23505", "duplicate key value");
    });

    await expect(cache.on(conn).query({ text: SELECT_ORG })).rejects.toThrow("duplicate key");
    cache.release(conn, undefined);

    expect(conn.release).toHaveBeenCalledWith(undefined);
  });

  it("runs a statement under its name from the second time", async () => {
    const cache = cacheOf(3);
    const seen: QueryArgs[] = [];
    const conn = connection(async (args) => {
      seen.push(args);
      return ROWS;
    });

    for (let run = 0; run < 3; run += 1) {
      await cache.on(conn).query({ text: SELECT_ORG, values: ["org_1"] });
    }

    expect(seen.map((args) => args.name === undefined)).toEqual([true, false, false]);
  });

  describe("retryingStale", () => {
    it("repeats a named attempt until it stops going stale", async () => {
      const cache = cacheOf(5);
      await cache.retryingStale({ text: SELECT_ORG }, async () => "warm");
      let calls = 0;

      const result = await cache.retryingStale({ text: SELECT_ORG }, async (named) => {
        calls += 1;
        expect(named.name).toMatch(/^sdp_/);
        if (calls < 3) {
          throw STALE;
        }
        return "done";
      });

      expect(result).toBe("done");
      expect(calls).toBe(3);
    });

    it("gives up after the retry budget", async () => {
      const cache = cacheOf(2);
      await cache.retryingStale({ text: SELECT_ORG }, async () => "warm");
      let calls = 0;

      await expect(
        cache.retryingStale({ text: SELECT_ORG }, async () => {
          calls += 1;
          throw STALE;
        })
      ).rejects.toBe(STALE);

      expect(calls).toBe(3);
    });

    it("never repeats an unnamed statement or another kind of failure", async () => {
      const cache = cacheOf(5);
      let unnamedCalls = 0;
      await expect(
        cache.retryingStale({ text: SELECT_ORG }, async () => {
          unnamedCalls += 1;
          throw STALE;
        })
      ).rejects.toBe(STALE);
      expect(unnamedCalls).toBe(1);

      let namedCalls = 0;
      const other = serverError("23505", "duplicate key value");
      await expect(
        cache.retryingStale({ text: SELECT_ORG }, async () => {
          namedCalls += 1;
          throw other;
        })
      ).rejects.toBe(other);
      expect(namedCalls).toBe(1);
    });
  });
});
