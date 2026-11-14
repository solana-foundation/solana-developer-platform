import { describe, expect, it } from "vitest";
import { inspectFireblocksPolicy } from "./fireblocks-policy";

const inspect = (rules: unknown[]) =>
  inspectFireblocksPolicy({ policy: { rules } }, "42", ["SOL", "usdc-asset"]);
const rule = (
  ids: string[][],
  asset = "SOL",
  action: Record<string, unknown> = { action: "2-TIER" }
) => ({
  type: "TRANSFER",
  asset,
  src: { ids },
  ...action,
});
const approvers = { authorizationGroups: { groups: [{ users: ["usr_1"] }] } };

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
  it("does not call an allow rule without approvers a policy", () => {
    expect(inspect([rule([["42", "VAULT"]], "SOL", { action: "ALLOW" })])).toEqual({
      status: "missing",
      reason: "no_policy",
    });
    expect(inspect([rule([["42", "VAULT"]], "SOL", { action: "ALLOW", authorizers: [] })])).toEqual(
      {
        status: "missing",
        reason: "no_policy",
      }
    );
    expect(
      inspect([rule([["42", "VAULT"]], "SOL", { action: "ALLOW", authorizationGroups: {} })])
    ).toEqual({ status: "missing", reason: "no_policy" });
  });
  it.each([
    [{ action: "2-TIER" }],
    [{ action: "BLOCK" }],
    [{ action: "ALLOW", authorizers: ["usr_1"] }],
    [{ action: "ALLOW", authorizersCount: 1 }],
    [{ action: "ALLOW", ...approvers }],
  ])("recognizes an approval-gated or blocking rule as present: %j", (action) => {
    expect(inspect([rule([["42", "VAULT"]], "SOL", action)])).toEqual({
      status: "present",
      reason: "policy_detected",
    });
  });
  it("warns when any matching rule lets the credential move funds alone", () => {
    expect(
      inspect([
        rule([["42", "VAULT"]], "SOL", { action: "2-TIER" }),
        rule([["*"]], "SOL", { action: "ALLOW" }),
      ])
    ).toEqual({ status: "missing", reason: "no_policy" });
  });
  it("keeps an unrecognised action unknown", () => {
    expect(inspect([rule([["42", "VAULT"]], "SOL", { action: "MAYBE" })])).toEqual({
      status: "unknown",
      reason: "unsupported_response",
    });
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
