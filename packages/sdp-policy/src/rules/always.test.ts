import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateAlwaysRule } from "./always";

describe("evaluateAlwaysRule", () => {
  it("allows by default", () => {
    assert.partialDeepStrictEqual(evaluateAlwaysRule({ kind: "always" }), {
      decision: "allow",
      reason: "Always rule matched.",
    });
  });

  it("applies a pinned action verbatim", () => {
    assert.equal(evaluateAlwaysRule({ kind: "always", action: "deny" }).decision, "deny");
  });
});
