import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VelocityPolicyRule } from "@sdp/types";
import { operation } from "../test-support";
import { createVelocityLookup } from "../velocity";
import { evaluateVelocityRule } from "./velocity";

const rule: VelocityPolicyRule = { kind: "velocity", window: "P1D", max: "1000", asset: "USDC" };

/**
 * A lookup answering the rule's single USDC key with the given total.
 *
 * @param total - The observed window total.
 * @returns The evaluation context.
 */
function observed(total: string) {
  return {
    velocity: createVelocityLookup([
      { scope: "wallet", window: "P1D", asset: "USDC", operationTypes: null, total },
    ]),
  };
}

describe("evaluateVelocityRule", () => {
  it("reviews a rule that names no assets", () => {
    assert.partialDeepStrictEqual(
      evaluateVelocityRule({ kind: "velocity", window: "P1D", max: "1" }, operation, observed("0")),
      { decision: "review", reason: "Velocity rule has no assets." }
    );
  });

  it("reviews a missing or invalid window", () => {
    for (const window of ["", "P1W", "1D"]) {
      assert.partialDeepStrictEqual(
        evaluateVelocityRule({ ...rule, window }, operation, observed("0")),
        { decision: "review", reason: "Velocity rule has an invalid window." }
      );
    }
    assert.partialDeepStrictEqual(
      evaluateVelocityRule(
        { kind: "velocity", asset: "USDC", max: "1" } as unknown as VelocityPolicyRule,
        operation,
        observed("0")
      ),
      { decision: "review", reason: "Velocity rule has an invalid window." }
    );
  });

  it("reviews a missing or invalid max", () => {
    for (const max of ["", "abc", "1.2.3"]) {
      assert.partialDeepStrictEqual(
        evaluateVelocityRule({ ...rule, max }, operation, observed("0")),
        {
          decision: "review",
          reason: "Velocity rule has an invalid max.",
        }
      );
    }
    assert.partialDeepStrictEqual(
      evaluateVelocityRule(
        { kind: "velocity", asset: "USDC", window: "P1D" } as unknown as VelocityPolicyRule,
        operation,
        observed("0")
      ),
      { decision: "review", reason: "Velocity rule has an invalid max." }
    );
  });

  it("abstains when the operation's asset is null or not named", () => {
    assert.equal(evaluateVelocityRule(rule, { ...operation, asset: null }, observed("0")), null);
    assert.equal(evaluateVelocityRule(rule, { ...operation, asset: "SOL" }, observed("0")), null);
  });

  it("abstains when the operation carries no amount and reviews an invalid one", () => {
    assert.equal(evaluateVelocityRule(rule, { ...operation, amount: null }, observed("0")), null);
    assert.partialDeepStrictEqual(
      evaluateVelocityRule(rule, { ...operation, amount: "12,5" }, observed("0")),
      { decision: "review", reason: "Operation amount is invalid for velocity policy evaluation." }
    );
  });

  it("abstains when the operation type is filtered out", () => {
    const filtered: VelocityPolicyRule = { ...rule, operationTypes: ["earn_vault_deposit"] };
    assert.equal(evaluateVelocityRule(filtered, operation, observed("0")), null);
  });

  it("reviews when the observation is missing from the lookup or the lookup is absent", () => {
    assert.partialDeepStrictEqual(evaluateVelocityRule(rule, operation), {
      decision: "review",
      reason: "Velocity window unavailable.",
    });
    assert.partialDeepStrictEqual(
      evaluateVelocityRule(rule, operation, { velocity: createVelocityLookup([]) }),
      { decision: "review", reason: "Velocity window unavailable." }
    );
    assert.partialDeepStrictEqual(
      evaluateVelocityRule({ ...rule, scope: "organization" }, operation, observed("0")),
      { decision: "review", reason: "Velocity window unavailable." }
    );
  });

  it("abstains within the limit, including exactly at the limit", () => {
    assert.equal(evaluateVelocityRule(rule, operation, observed("0")), null);
    assert.equal(evaluateVelocityRule(rule, operation, observed("874.50")), null);
    assert.equal(evaluateVelocityRule(rule, { ...operation, amount: "1000" }, observed("0")), null);
  });

  it("denies by default when the projected total exceeds max", () => {
    assert.partialDeepStrictEqual(evaluateVelocityRule(rule, operation, observed("874.51")), {
      decision: "deny",
      reason:
        "Window total 874.51 plus operation amount 125.50 exceeds policy velocity maximum 1000 over P1D.",
    });
  });

  it("uses the rule action as the breach decision", () => {
    assert.partialDeepStrictEqual(
      evaluateVelocityRule({ ...rule, action: "approval_required" }, operation, observed("900")),
      { decision: "approval_required" }
    );
    assert.partialDeepStrictEqual(
      evaluateVelocityRule({ ...rule, action: "review" }, operation, observed("900")),
      { decision: "review" }
    );
  });

  it("matches the observation for the operation's asset when the rule names several", () => {
    const multi: VelocityPolicyRule = { ...rule, asset: undefined, assets: ["USDG", "USDC"] };
    const context = {
      velocity: createVelocityLookup([
        { scope: "wallet", window: "P1D", asset: "USDG", operationTypes: null, total: "999" },
        { scope: "wallet", window: "P1D", asset: "USDC", operationTypes: null, total: "0" },
      ]),
    };
    assert.equal(evaluateVelocityRule(multi, operation, context), null);
    assert.partialDeepStrictEqual(
      evaluateVelocityRule(multi, { ...operation, asset: "USDG" }, context),
      { decision: "deny" }
    );
  });
});
