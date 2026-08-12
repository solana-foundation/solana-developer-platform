import { describe, expect, it } from "vitest";
import { extractPolicyDenialReason, withPolicyDenialReason } from "./policy-denial-reason";

function denial(details: Record<string, unknown>): string {
  return JSON.stringify({
    error: { code: "FORBIDDEN", message: "Wallet operation denied by policy", details },
  });
}

describe("extractPolicyDenialReason", () => {
  it("returns the prose reason that names the rule", () => {
    expect(
      extractPolicyDenialReason(denial({ reason: "Destination is not on the allowlist" }))
    ).toBe("Destination is not on the allowlist");
  });

  it("ignores reasonCode, which names the scope rather than the rule", () => {
    // Surfacing it produced "denied by policy — Wallet policy match", which restates
    // the message. `reason` is set on every branch that can deny, so there is nothing
    // to fall back to.
    expect(extractPolicyDenialReason(denial({ reasonCode: "wallet_policy_match" }))).toBeNull();
    expect(
      extractPolicyDenialReason(
        denial({ reason: "Asset not allowed", reasonCode: "wallet_policy_match" })
      )
    ).toBe("Asset not allowed");
  });

  it("treats a blank reason as absent", () => {
    expect(extractPolicyDenialReason(denial({ reason: "   " }))).toBeNull();
  });

  it("returns null when details carry nothing usable", () => {
    expect(extractPolicyDenialReason(denial({ decision: "deny" }))).toBeNull();
    expect(extractPolicyDenialReason(JSON.stringify({ error: { message: "Nope" } }))).toBeNull();
  });

  it("returns null for a non-JSON body rather than throwing", () => {
    expect(extractPolicyDenialReason("<html>502 Bad Gateway</html>")).toBeNull();
  });

  it("ignores a non-string reason", () => {
    expect(extractPolicyDenialReason(denial({ reason: 42 }))).toBeNull();
  });
});

describe("withPolicyDenialReason", () => {
  it("appends the reason to the generic message", () => {
    expect(withPolicyDenialReason("Wallet operation denied by policy", "Asset not allowed")).toBe(
      "Wallet operation denied by policy — Asset not allowed"
    );
  });

  it("leaves the message alone when there is no reason", () => {
    expect(withPolicyDenialReason("Wallet operation denied by policy", null)).toBe(
      "Wallet operation denied by policy"
    );
  });

  it("does not repeat a reason the message already states", () => {
    expect(withPolicyDenialReason("Denied: asset not allowed", "Asset not allowed")).toBe(
      "Denied: asset not allowed"
    );
  });
});
