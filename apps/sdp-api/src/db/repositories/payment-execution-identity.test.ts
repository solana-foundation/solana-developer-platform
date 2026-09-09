import { describe, expect, it } from "vitest";
import { parseNullableCustodyWalletId } from "./payment-execution-identity";

describe("parseNullableCustodyWalletId", () => {
  it.each(["cwlt_exact", null])("accepts a persisted exact-wallet value: %s", (value) => {
    expect(parseNullableCustodyWalletId(value)).toBe(value);
  });

  it.each([undefined, ""])("rejects a missing or empty exact-wallet value: %s", (value) => {
    expect(() => parseNullableCustodyWalletId(value)).toThrow();
  });
});
