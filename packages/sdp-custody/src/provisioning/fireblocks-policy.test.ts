import { describe, expect, it } from "vitest";
import { inspectFireblocksPolicy } from "./fireblocks-policy";

const inspect = (rules: unknown[]) =>
  inspectFireblocksPolicy({ policy: { rules } }, "42", ["SOL", "usdc-asset"]);
const rule = (ids: string[][], asset = "SOL") => ({ type: "TRANSFER", asset, src: { ids } });

describe("Fireblocks policy presence", () => {
  it.each([[["*"]], [["*", "VAULT", "*"]], [["42", "VAULT"]], [["42", "*"]]])(
    "recognizes source selector %j",
    (source) => {
      expect(inspect([rule([source])])).toEqual({ status: "present", reason: "policy_detected" });
    }
  );
  it("does not confuse a different vault, account type, asset or RAW rule with a transfer policy", () => {
    expect(
      inspect([
        rule([["43", "VAULT"]]),
        rule([["42", "EXCHANGE"]]),
        rule([["42", "VAULT"]], "ETH"),
        { type: "RAW" },
      ])
    ).toEqual({ status: "missing", reason: "no_policy" });
  });
  it("accepts a canonical token rule and an explicit empty policy", () => {
    expect(inspect([rule([["42", "VAULT"]], "usdc-asset")]).status).toBe("present");
    expect(inspect([])).toEqual({ status: "missing", reason: "no_policy" });
  });
  it.each([
    {},
    { policy: {} },
    { policy: { rules: null } },
    { policy: { rules: [{ type: "TRANSFER", asset: "SOL", srcId: "42" }] } },
  ])("keeps unsupported responses unknown: %j", (value) => {
    expect(inspectFireblocksPolicy(value, "42", ["SOL"])).toEqual({
      status: "unknown",
      reason: "unsupported_response",
    });
  });
  it("does not guess the meaning of an unknown vault subtype", () => {
    expect(inspect([rule([["42", "VAULT", "FUTURE"]])]).status).toBe("unknown");
  });
});
