import { describe, expect, it } from "vitest";
import { parseDatabaseEnv } from "./database-env";

describe("parseDatabaseEnv", () => {
  it.each([undefined, "on", "off"])("accepts DATABASE_PREPARED_STATEMENTS=%j", (value) => {
    expect(parseDatabaseEnv({ DATABASE_PREPARED_STATEMENTS: value })).toEqual({
      DATABASE_PREPARED_STATEMENTS: value,
    });
  });

  it.each(["", "of", "OFF", "false", "0", "yes"])(
    "refuses DATABASE_PREPARED_STATEMENTS=%j instead of leaving the default in place",
    (value) => {
      expect(() => parseDatabaseEnv({ DATABASE_PREPARED_STATEMENTS: value })).toThrow(
        /DATABASE_PREPARED_STATEMENTS/
      );
    }
  );
});
