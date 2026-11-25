import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testRuntime } from "#/test/runtime";
import {
  fireblocksRuleScope,
  fireblocksUngatedRuleJudged,
  inspectFireblocksPolicy,
  readFireblocksPolicy,
} from "./policy";

/** A hand-built rule matching the envelope's own rule type. */
type RuleFixture = { type: string } & Record<string, unknown>;

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
/** Reads the active policy from a Fireblocks that answers `body`. */
const readPolicyAnswering = (body: unknown) =>
  readFireblocksPolicy(
    testRuntime(async () => Response.json(body)),
    {
      apiKey: "api-key",
      apiSecretPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    }
  );

const inspect = (rules: RuleFixture[]) =>
  inspectFireblocksPolicy({ policy: { rules } }, "42", ["SOL", "usdc-asset"]);
/** A provider-shaped Transfer rule: Fireblocks keeps `type: TRANSFER` fixed and
 * names the operation in `transactionType`. */
const rule = (
  ids: string[][],
  asset = "SOL",
  action: Record<string, unknown> = { action: "2-TIER" }
) => ({
  type: "TRANSFER",
  transactionType: "TRANSFER",
  asset,
  src: { ids },
  ...action,
});
const approvers = { authorizationGroups: { groups: [{ users: ["usr_1"] }] } };
/**
 * A rule shaped like the provider's own for another operation: the same fixed
 * `type: TRANSFER`, with `transactionType` naming the operation.
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
    // Nor does a contract-call approval rule prove transfer coverage: without the
    // transactionType filter this reads as a gated transfer rule.
    expect(inspect([operationRule("CONTRACT_CALL")])).toEqual({
      status: "missing",
      reason: "no_policy",
    });
    // Nor does an ungated rule for another operation read as missing coverage,
    // or shadow a matching gated transfer rule.
    expect(inspect([operationRule("CONTRACT_CALL", { action: "ALLOW" })])).toEqual({
      status: "missing",
      reason: "no_policy",
    });
    expect(
      inspect([operationRule("CONTRACT_CALL", { action: "ALLOW" }), rule([["42", "VAULT"]])])
    ).toEqual({ status: "present", reason: "policy_detected" });
  });
  it("accepts a canonical token rule and an explicit empty policy", () => {
    expect(inspect([rule([["42", "VAULT"]], "usdc-asset")]).status).toBe("present");
    expect(inspect([])).toEqual({ status: "missing", reason: "no_policy" });
  });
  it("treats an ALLOW rule as ungated whatever approver fields it carries", () => {
    expect(inspect([rule([["42", "VAULT"]], "SOL", { action: "ALLOW" })])).toEqual({
      status: "missing",
      reason: "no_policy",
    });
    // Empty approver fields must still read as an ALLOW rule.
    expect(inspect([rule([["42", "VAULT"]], "SOL", { action: "ALLOW", authorizers: [] })])).toEqual(
      {
        status: "missing",
        reason: "no_policy",
      }
    );
    expect(
      inspect([rule([["42", "VAULT"]], "SOL", { action: "ALLOW", authorizationGroups: {} })])
    ).toEqual({ status: "missing", reason: "no_policy" });
    // Fireblocks defines ALLOW as requiring no additional approvals; populated
    // approver fields must not read as a policy and hide the warning.
    expect(
      inspect([rule([["42", "VAULT"]], "SOL", { action: "ALLOW", authorizers: ["usr_1"] })])
    ).toEqual({ status: "missing", reason: "no_policy" });
    expect(
      inspect([rule([["42", "VAULT"]], "SOL", { action: "ALLOW", authorizersCount: 2 })])
    ).toEqual({ status: "missing", reason: "no_policy" });
    expect(inspect([rule([["42", "VAULT"]], "SOL", { action: "ALLOW", ...approvers })])).toEqual({
      status: "missing",
      reason: "no_policy",
    });
  });
  it("recognizes an approval-gated or blocking rule as present", () => {
    expect(inspect([rule([["42", "VAULT"]], "SOL", { action: "2-TIER" })])).toEqual({
      status: "present",
      reason: "policy_detected",
    });
    expect(inspect([rule([["42", "VAULT"]], "SOL", { action: "BLOCK" })])).toEqual({
      status: "present",
      reason: "policy_detected",
    });
  });
  it("judges a wildcard-transaction rule as a transfer rule", () => {
    // `transactionType: "*"` governs every operation, transfers included: an
    // ALLOW on it must not hide behind a gated transfer rule.
    expect(inspect([operationRule("*", { action: "ALLOW" })])).toEqual({
      status: "missing",
      reason: "no_policy",
    });
    expect(
      inspect([
        rule([["42", "VAULT"]], "SOL", { action: "2-TIER" }),
        operationRule("*", { action: "ALLOW" }),
      ])
    ).toEqual({ status: "missing", reason: "no_policy" });
    expect(inspect([operationRule("*")])).toEqual({ status: "present", reason: "policy_detected" });
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
  it("keeps a wallet unknown when a matching rule cannot be read beside a gated one", () => {
    // The readable gated rule must not report presence while a matching rule's
    // terms are unreadable; only a proven ungated rule may overturn that.
    expect(
      inspect([
        rule([["42", "VAULT"]], "SOL", { action: "2-TIER" }),
        rule([["42", "VAULT"]], "SOL", { action: "MAYBE" }),
      ])
    ).toEqual({ status: "unknown", reason: "unsupported_response" });
    expect(
      inspect([
        rule([["42", "VAULT"]], "SOL", { action: "2-TIER" }),
        rule([["42", "VAULT"]], "SOL", { action: "ALLOW" }),
      ])
    ).toEqual({ status: "missing", reason: "no_policy" });
  });
  it("reports a body the envelope cannot read as unsupported before any rule walk", async () => {
    for (const body of [null, {}, { policy: {} }, { policy: { rules: null } }]) {
      await expect(readPolicyAnswering(body)).resolves.toEqual({
        error: { status: "unknown", reason: "unsupported_response" },
      });
    }
    // A well-formed envelope with unreadable rules parses; the walk keeps it unknown.
    const read = await readPolicyAnswering({
      policy: { rules: [{ type: "TRANSFER", asset: "SOL", srcId: "42" }] },
    });
    if (!("value" in read)) throw new Error("An envelope with unreadable rules must still parse");
    expect(inspectFireblocksPolicy(read.value, "42", ["SOL"])).toEqual({
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

describe("Fireblocks ungated-rule proof", () => {
  const judged = (rules: RuleFixture[], assets = ["SOL"]) =>
    fireblocksUngatedRuleJudged({ policy: { rules } }, "42", assets);
  it("is true only for an allow-without-approvers rule the asset list names", () => {
    expect(judged([rule([["42", "VAULT"]], "SOL", { action: "ALLOW" })])).toBe(true);
    expect(judged([rule([["*"]], "SOL", { action: "ALLOW" })])).toBe(true);
    expect(judged([rule([["42", "VAULT"]], "ETH", { action: "ALLOW" })])).toBe(false);
  });
  it("is false for gated rules, unreadable rules and rules for other operations", () => {
    expect(judged([rule([["42", "VAULT"]])])).toBe(false);
    expect(judged([rule([["42", "VAULT"]], "SOL", { action: "MAYBE" })])).toBe(false);
    expect(judged([operationRule("RAW", { action: "ALLOW" })])).toBe(false);
    expect(judged([{ type: "TRANSFER" }])).toBe(false);
  });
});

describe("Fireblocks rule scope", () => {
  const scope = (rules: RuleFixture[]) => fireblocksRuleScope({ policy: { rules } }, "42", ["SOL"]);
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
    // An ungated contract-call rule naming a foreign asset is out of scope too:
    // it must not even ask for the catalogue.
    expect(scope([operationRule("CONTRACT_CALL", { action: "ALLOW" }, "ETH")])).toBe("native");
    expect(
      scope([operationRule("CONTRACT_CALL", { action: "2-TIER" }, "ETH"), rule([["42", "VAULT"]])])
    ).toBe("native");
  });
});
