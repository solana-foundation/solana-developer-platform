import { describe, expect, it } from "vitest";
import {
  isPostgresUniqueViolation,
  parseOptionalPostgresJson,
  parseOptionalPostgresJsonOr,
} from "./postgres-utils";

describe("isPostgresUniqueViolation", () => {
  it("matches errors carrying SQLSTATE 23505", () => {
    const err = Object.assign(
      new Error('duplicate key value violates unique constraint "allowlist_type_value_key"'),
      { code: "23505" }
    );
    expect(isPostgresUniqueViolation(err)).toBe(true);
  });

  it("ignores SQLite-style messages without a Postgres error code", () => {
    expect(isPostgresUniqueViolation(new Error("UNIQUE constraint failed: allowlist.value"))).toBe(
      false
    );
  });
});

describe("postgres JSON helpers", () => {
  it("treats only nullish optional values as absent", () => {
    expect(parseOptionalPostgresJson<unknown>(null)).toBeNull();
    expect(parseOptionalPostgresJson<unknown>(undefined)).toBeNull();
    expect(parseOptionalPostgresJsonOr(null, "fallback")).toBe("fallback");
    expect(parseOptionalPostgresJsonOr(undefined, "fallback")).toBe("fallback");
  });

  it("preserves valid falsy JSON primitive values", () => {
    expect(parseOptionalPostgresJson<boolean>(false)).toBe(false);
    expect(parseOptionalPostgresJson<number>(0)).toBe(0);
    expect(parseOptionalPostgresJson<boolean>("false")).toBe(false);
    expect(parseOptionalPostgresJson<number>("0")).toBe(0);
    expect(parseOptionalPostgresJsonOr(false, true)).toBe(false);
    expect(parseOptionalPostgresJsonOr(0, 42)).toBe(0);
    expect(parseOptionalPostgresJsonOr("false", true)).toBe(false);
    expect(parseOptionalPostgresJsonOr("0", 42)).toBe(0);
  });
});
