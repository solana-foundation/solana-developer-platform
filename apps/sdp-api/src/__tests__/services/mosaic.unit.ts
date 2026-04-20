/**
 * Mosaic Utils Unit Tests
 *
 * Tests for pure Mosaic utility functions.
 * No mocks needed - these are pure functions.
 */

import { describe, expect, it } from "vitest";
import { bigIntReplacer, safeStringify } from "@/services/mosaic/utils";

describe("bigIntReplacer", () => {
  it("converts bigint to string", () => {
    expect(bigIntReplacer("slot", 12345n)).toBe("12345");
  });

  it("preserves non-bigint values", () => {
    expect(bigIntReplacer("name", "test")).toBe("test");
    expect(bigIntReplacer("count", 42)).toBe(42);
    expect(bigIntReplacer("active", true)).toBe(true);
    expect(bigIntReplacer("data", null)).toBeNull();
  });

  it("handles large bigints", () => {
    const largeValue = 9007199254740993n; // Larger than Number.MAX_SAFE_INTEGER
    expect(bigIntReplacer("amount", largeValue)).toBe("9007199254740993");
  });

  it("handles zero bigint", () => {
    expect(bigIntReplacer("balance", 0n)).toBe("0");
  });

  it("handles negative bigint", () => {
    expect(bigIntReplacer("delta", -100n)).toBe("-100");
  });
});

describe("safeStringify", () => {
  it("stringifies simple objects", () => {
    const obj = { name: "test", count: 42 };
    expect(safeStringify(obj)).toBe('{"name":"test","count":42}');
  });

  it("handles objects with bigint values", () => {
    const obj = { slot: 12345n, name: "test" };
    expect(safeStringify(obj)).toBe('{"slot":"12345","name":"test"}');
  });

  it("handles nested objects with bigints", () => {
    const obj = {
      transaction: {
        slot: 12345n,
        fee: 5000n,
      },
      status: "confirmed",
    };
    const result = JSON.parse(safeStringify(obj));
    expect(result.transaction.slot).toBe("12345");
    expect(result.transaction.fee).toBe("5000");
    expect(result.status).toBe("confirmed");
  });

  it("handles arrays with bigints", () => {
    const arr = [1n, 2n, 3n];
    expect(safeStringify(arr)).toBe('["1","2","3"]');
  });

  it("handles mixed arrays", () => {
    const arr = [1, "two", 3n, null];
    expect(safeStringify(arr)).toBe('[1,"two","3",null]');
  });

  it("handles Solana-like RPC response", () => {
    const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const rpcResponse = {
      slot: 123456789n,
      lamports: 1000000000n,
      owner: tokenProgram,
      executable: false,
      rentEpoch: 361n,
    };
    const result = JSON.parse(safeStringify(rpcResponse));
    expect(result.slot).toBe("123456789");
    expect(result.lamports).toBe("1000000000");
    expect(result.owner).toBe(tokenProgram);
    expect(result.rentEpoch).toBe("361");
  });

  it("handles null and undefined", () => {
    expect(safeStringify(null)).toBe("null");
  });

  it("handles primitives", () => {
    expect(safeStringify("test")).toBe('"test"');
    expect(safeStringify(42)).toBe("42");
    expect(safeStringify(true)).toBe("true");
  });
});
