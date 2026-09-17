/** Token-2022 JSON utility unit tests. */

import { bigIntReplacer, safeStringify } from "@sdp/solana/token-2022.utils";
import { describe, expect, it } from "vitest";

describe("bigIntReplacer", () => {
  it("converts bigint to string", () => {
    expect(bigIntReplacer("slot", 12345n)).toBe("12345");
  });

  it("preserves non-bigint values", () => {
    expect(bigIntReplacer("name", "test")).toBe("test");
    expect(bigIntReplacer("count", 42)).toBe(42);
  });
});

describe("safeStringify", () => {
  it("stringifies objects with bigint values", () => {
    const obj = { slot: 12345n, name: "test" };
    expect(safeStringify(obj)).toBe('{"slot":"12345","name":"test"}');
  });
});
