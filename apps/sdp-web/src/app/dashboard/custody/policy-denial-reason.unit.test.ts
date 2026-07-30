import { describe, expect, it } from "vitest";
import { extractPolicyDenialReason, withPolicyDenialReason } from "./policy-denial-reason";

function denial(details: Record<string, unknown>): string {
  return JSON.stringify({
    error: { code: "FORBIDDEN", message: "Wallet operation denied by policy", details },
  });
}

describe("extractPolicyDenialReason", () => {
  it("prefers the human-written reason", () => {
    expect(
      extractPolicyDenialReason(
        denial({ reason: "Destination is not on the allowlist", reasonCode: "destination_denied" })
      )
    ).toBe("Destination is not on the allowlist");
  });

  it("falls back to a tidied reason code", () => {
    expect(extractPolicyDenialReason(denial({ reasonCode: "destination_not_allowlisted" }))).toBe(
      "Destination not allowlisted"
    );
  });

  it("ignores a blank reason and uses the code", () => {
    expect(extractPolicyDenialReason(denial({ reason: "   ", reasonCode: "asset_denied" }))).toBe(
      "Asset denied"
    );
  });

  it("returns null when details carry neither", () => {
    expect(extractPolicyDenialReason(denial({ decision: "deny" }))).toBeNull();
  });

  it("returns null when there are no details at all", () => {
    expect(extractPolicyDenialReason(JSON.stringify({ error: { message: "Nope" } }))).toBeNull();
  });

  it("returns null for a non-JSON body rather than throwing", () => {
    expect(extractPolicyDenialReason("<html>502 Bad Gateway</html>")).toBeNull();
  });

  it("ignores non-string reason values", () => {
    expect(extractPolicyDenialReason(denial({ reason: 42, reasonCode: null }))).toBeNull();
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
