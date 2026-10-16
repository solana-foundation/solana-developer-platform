import { describe, expect, it } from "vitest";
import {
  isStalePreparedStatementError,
  PreparedStatementNames,
  preparedStatementsEnabled,
} from "./prepared-statements";

const SELECT_ORG = "SELECT status FROM organizations WHERE id = $1";
const SELECT_KEY = "SELECT status FROM api_keys WHERE id = $1";
const SELECT_WALLET = "SELECT id FROM custody_wallets WHERE wallet_id = $1";

describe("PreparedStatementNames", () => {
  it("names a statement on its second sighting and keeps that name", () => {
    const names = new PreparedStatementNames();

    expect(names.nameFor(SELECT_ORG)).toBeUndefined();
    const name = names.nameFor(SELECT_ORG);
    expect(name).toMatch(/^sdp_[0-9a-f]{32}$/);
    expect(names.nameFor(SELECT_ORG)).toBe(name);
  });

  it("derives the name from the text so every connection agrees on it", () => {
    const first = new PreparedStatementNames();
    const second = new PreparedStatementNames();
    for (const names of [first, second]) {
      names.nameFor(SELECT_ORG);
    }

    expect(first.nameFor(SELECT_ORG)).toBe(second.nameFor(SELECT_ORG));
  });

  it("gives different statements different names, inside PostgreSQL's 63 byte limit", () => {
    const names = new PreparedStatementNames();
    for (const text of [SELECT_ORG, SELECT_KEY]) {
      names.nameFor(text);
    }

    const orgName = names.nameFor(SELECT_ORG);
    const keyName = names.nameFor(SELECT_KEY);
    expect(orgName).toBeDefined();
    expect(keyName).toBeDefined();
    expect(orgName).not.toBe(keyName);
    expect(Buffer.byteLength(orgName ?? "")).toBeLessThanOrEqual(63);
  });

  it.each([
    ["a session setting", "SET LOCAL idle_in_transaction_session_timeout = 0"],
    ["a transaction command", "BEGIN"],
    ["a DDL statement", "CREATE TABLE scratch (id INTEGER)"],
    ["two statements", "SELECT 1; SELECT 2"],
    ["a statement with a second one after a semicolon", "UPDATE a SET b = 1; DELETE FROM c"],
  ])("never names %s", (_label, text) => {
    const names = new PreparedStatementNames();

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
    const names = new PreparedStatementNames();
    names.nameFor(text);

    expect(names.nameFor(text)).toBeDefined();
  });

  it("does not let a statement seen once take one of the limited names", () => {
    const names = new PreparedStatementNames({ enabled: true, maxNames: 1 });

    names.nameFor("SELECT 'one-off literal 1'");
    names.nameFor(SELECT_ORG);

    expect(names.nameFor(SELECT_ORG)).toBeDefined();
  });

  it("stops naming new statements at the limit and keeps the names it gave", () => {
    const names = new PreparedStatementNames({ enabled: true, maxNames: 2 });
    for (const text of [SELECT_ORG, SELECT_KEY, SELECT_WALLET]) {
      names.nameFor(text);
    }

    const orgName = names.nameFor(SELECT_ORG);
    const keyName = names.nameFor(SELECT_KEY);
    expect(orgName).toBeDefined();
    expect(keyName).toBeDefined();
    expect(names.nameFor(SELECT_WALLET)).toBeUndefined();
    expect(names.nameFor(SELECT_WALLET)).toBeUndefined();
    expect(names.nameFor(SELECT_ORG)).toBe(orgName);
  });

  it("names nothing when turned off", () => {
    const names = new PreparedStatementNames({ enabled: false });

    for (let sighting = 0; sighting < 5; sighting += 1) {
      expect(names.nameFor(SELECT_ORG)).toBeUndefined();
    }
  });
});

describe("preparedStatementsEnabled", () => {
  it.each([undefined, "", "on", "true", "1", "anything else"])("leaves %j on", (setting) => {
    expect(preparedStatementsEnabled(setting)).toBe(true);
  });

  it.each(["off", "OFF", " Off ", "false", "FALSE", "0"])("turns %j off", (setting) => {
    expect(preparedStatementsEnabled(setting)).toBe(false);
  });
});

describe("isStalePreparedStatementError", () => {
  it("recognizes a result type change after a migration", () => {
    expect(
      isStalePreparedStatementError(
        Object.assign(new Error("cached plan must not change result type"), { code: "0A000" })
      )
    ).toBe(true);
  });

  it("recognizes a statement that no longer exists on the connection", () => {
    expect(
      isStalePreparedStatementError(
        Object.assign(new Error('prepared statement "sdp_1" does not exist'), { code: "26000" })
      )
    ).toBe(true);
  });

  it("leaves every other 0A000 and every other code alone", () => {
    expect(
      isStalePreparedStatementError(
        Object.assign(new Error("unsupported operation"), { code: "0A000" })
      )
    ).toBe(false);
    expect(
      isStalePreparedStatementError(
        Object.assign(new Error("duplicate key value"), { code: "23505" })
      )
    ).toBe(false);
    expect(
      isStalePreparedStatementError(new Error("cached plan must not change result type"))
    ).toBe(false);
    expect(isStalePreparedStatementError(null)).toBe(false);
    expect(isStalePreparedStatementError("0A000")).toBe(false);
  });
});
