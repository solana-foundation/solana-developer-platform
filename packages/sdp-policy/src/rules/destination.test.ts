import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { operation } from "../test-support";
import { evaluateDestinationRule } from "./destination";

describe("evaluateDestinationRule", () => {
  it("reviews a rule with neither allowlist nor blocklist", () => {
    assert.partialDeepStrictEqual(evaluateDestinationRule({ kind: "destination" }, operation), {
      decision: "review",
      reason: "Destination rule has no allowlist or blocklist.",
    });
  });

  it("denies a blocklisted destination", () => {
    const evaluation = evaluateDestinationRule(
      { kind: "destination", blocklist: ["recipient_blocked"] },
      operation
    );
    assert.equal(evaluation?.decision, "deny");
  });

  it("abstains when only a blocklist exists and the destination is not on it", () => {
    assert.equal(
      evaluateDestinationRule({ kind: "destination", blocklist: ["someone_else"] }, operation),
      null
    );
  });

  it("denies destinations outside an allowlist", () => {
    const evaluation = evaluateDestinationRule(
      { kind: "destination", allowlist: ["recipient_allowed"] },
      operation
    );
    assert.equal(evaluation?.decision, "deny");
  });

  it("denies allowlist rules when the operation has no destination", () => {
    const evaluation = evaluateDestinationRule(
      { kind: "destination", allowlist: ["recipient_allowed"] },
      { ...operation, destination: null }
    );
    assert.partialDeepStrictEqual(evaluation, {
      decision: "deny",
      reason: "Operation has no destination for destination policy evaluation.",
    });
  });

  it("merges destination, destinations, and allowlist into one allowlist", () => {
    const evaluation = evaluateDestinationRule(
      {
        kind: "destination",
        destination: "recipient_blocked",
        destinations: ["other_a"],
        allowlist: ["other_b"],
      },
      operation
    );
    assert.equal(evaluation?.decision, "allow");
  });
});
