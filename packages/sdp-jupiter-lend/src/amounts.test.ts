import { describe, expect, it } from "vitest";
import { fromAtoms, toAtoms } from "./amounts";

describe("Jupiter Lend amount conversion", () => {
  it("round-trips six-decimal USDT and jlUSDT amounts exactly", () => {
    for (const value of ["1", "1.5", "0.000001", "18446744073709.551615"]) {
      expect(fromAtoms(toAtoms("amount", value))).toBe(value);
    }
  });

  it.each(["0", "-1", "1e3", "1.0000001", "18446744073709.551616"])(
    "refuses an unencodable amount %s",
    (value) => expect(() => toAtoms("amount", value)).toThrow()
  );
});
