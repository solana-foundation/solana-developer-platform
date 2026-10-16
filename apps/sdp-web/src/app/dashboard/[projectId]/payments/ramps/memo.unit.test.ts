import { describe, expect, it } from "vitest";
import { memoRowsToRecord, normalizeMemoKey, validateMemoRows } from "./memo";

describe("normalizeMemoKey", () => {
  it("trims and replaces whitespace runs with dashes", () => {
    expect(normalizeMemoKey("  invoice  number ")).toBe("invoice-number");
  });
});

describe("memoRowsToRecord", () => {
  it("stores normalized keys", () => {
    expect(memoRowsToRecord([{ key: "invoice number", value: "INV-123" }])).toEqual({
      "invoice-number": "INV-123",
    });
  });
});

describe("validateMemoRows", () => {
  it("flags keys that collide after normalization", () => {
    const errors = validateMemoRows([
      { key: "invoice number", value: "a" },
      { key: "invoice-number", value: "b" },
    ]);
    expect(errors).toEqual([
      { row: 1, code: "keyDuplicate" },
      { row: 2, code: "keyDuplicate" },
    ]);
  });

  it("treats whitespace-only keys as missing", () => {
    expect(validateMemoRows([{ key: "   ", value: "a" }])).toEqual([
      { row: 1, code: "keyRequired" },
    ]);
  });
});
