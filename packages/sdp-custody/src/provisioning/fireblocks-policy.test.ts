import { describe, expect, it } from "vitest";
import { fireblocksRuleScope, inspectFireblocksPolicy } from "./fireblocks-policy";

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
/**
 * A rule shaped like the provider's own: Fireblocks keeps `type: TRANSFER` fixed
 * for every transaction rule and names the operation in `transactionType`.
 */
const operationRule = (
  transactionType: string,
  action: Record<string, unknown> = { action: "2-TIER" },
  asset = "*"
) => ({
  type: "TRANSFER",
  transactionType,
  asset,
  src: { ids: [["*", "VAULT", "*"]] },
  ...action,
  authorizationGroups: { logic: "OR", groups: [{ th: 1, users: ["usr_1"] }] },
});

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
        operationRule("RAW"),
      ])
    ).toEqual({ status: "missing", reason: "no_policy" });
  });
  it("ignores provider-shaped rules for other operations when judging transfer coverage", () => {
    // A raw-signing approval rule does not prove native-transfer coverage, and it
    // must not shadow a matching transfer rule either.
    expect(inspect([operationRule("RAW")])).toEqual({ status: "missing", reason: "no_policy" });
    expect(inspect([operationRule("CONTRACT_CALL"), rule([["42", "VAULT"]])])).toEqual({
      status: "present",
      reason: "policy_detected",
    });
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
  it("judges every readable rule when the caller cannot name the asset list", () => {
    const unreadable = [rule([["42", "VAULT"]], "usdc-asset", { action: "MAYBE" })];
    expect(inspectFireblocksPolicy({ policy: { rules: unreadable } }, "42", null)).toEqual({
      status: "unknown",
      reason: "unsupported_response",
    });
    const proven = [
      rule([["42", "VAULT"]], "SOL", { action: "ALLOW" }),
      rule([["42", "VAULT"]], "usdc-asset", { action: "MAYBE" }),
    ];
    expect(inspectFireblocksPolicy({ policy: { rules: proven } }, "42", null)).toEqual({
      status: "missing",
      reason: "no_policy",
    });
  });
});

describe("Fireblocks rule scope", () => {
  const scope = (rules: unknown[]) => fireblocksRuleScope({ policy: { rules } }, "42", ["SOL"]);
  it("keeps native, wildcard and foreign-vault rules catalogue-free", () => {
    expect(scope([rule([["42", "VAULT"]]), rule([["42", "VAULT"]], "*")])).toBe("native");
    expect(scope([rule([["42", "VAULT"]], "SOL", { action: "MAYBE" })])).toBe("native");
    expect(scope([rule([["43", "VAULT"]], "ETH")])).toBe("native");
    expect(scope([])).toBe("native");
  });
  it("asks for the catalogue when a recognized matching rule names another asset", () => {
    expect(scope([rule([["42", "VAULT"]], "ETH")])).toBe("outside");
    expect(scope([rule([["*", "VAULT", "*"]], "ETH")])).toBe("outside");
  });
  it("stays unknown when a matching foreign rule cannot be read", () => {
    expect(scope([rule([["42", "VAULT"]], "ETH", { action: "MAYBE" })])).toBe("unknown");
    expect(scope([{ type: "TRANSFER" }])).toBe("unknown");
    expect(scope([rule([["42", "VAULT", "FUTURE"]], "ETH")])).toBe("unknown");
  });
  it("treats provider-shaped rules for other operations as out of scope", () => {
    // A raw-signing rule naming a foreign asset needs no catalogue read: it is
    // not a transfer rule, so the native judgement alone decides the wallet.
    expect(scope([operationRule("RAW", { action: "ALLOW", authorizers: ["usr_1"] }, "ETH")])).toBe(
      "native"
    );
    expect(scope([operationRule("CONTRACT_CALL", { action: "2-TIER" }, "ETH")])).toBe("native");
    expect(
      scope([operationRule("CONTRACT_CALL", { action: "2-TIER" }, "ETH"), rule([["42", "VAULT"]])])
    ).toBe("native");
  });
});
