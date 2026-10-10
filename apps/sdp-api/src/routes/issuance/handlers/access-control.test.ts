import type { Token, TokenTemplate } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  controlListMovement,
  getOnChainAllowlistMutationForMint,
  shouldEnableOnChainAcl,
} from "./access-control";

type Shape = Pick<Token, "template" | "requiresAllowlist">;
type WithAblList = Shape & Pick<Token, "ablListAddress">;

const allowlist = (template: TokenTemplate): Shape => ({ template, requiresAllowlist: true });
const denylist = (template: TokenTemplate): Shape => ({ template, requiresAllowlist: false });
const withAblList = (shape: Shape, ablListAddress: string | null = "LIST"): WithAblList => ({
  ...shape,
  ablListAddress,
});

describe("shouldEnableOnChainAcl", () => {
  it("returns false for templates without access control", () => {
    expect(shouldEnableOnChainAcl(denylist("custom"))).toBe(false);
  });

  it("enables on-chain ABL for denylist tokens", () => {
    for (const template of ["stablecoin", "tokenized-security"] as const) {
      expect(shouldEnableOnChainAcl(denylist(template))).toBe(true);
    }
  });

  it("enables on-chain ABL for allowlist tokens", () => {
    for (const template of ["stablecoin", "tokenized-security", "arcade"] as const) {
      expect(shouldEnableOnChainAcl(allowlist(template))).toBe(true);
    }
  });
});

describe("getOnChainAllowlistMutationForMint", () => {
  it("returns the list address for allowlist tokens with on-chain ABL active and a populated list", () => {
    for (const template of ["stablecoin", "tokenized-security", "arcade"] as const) {
      const token = withAblList(allowlist(template));
      expect(getOnChainAllowlistMutationForMint(token)).toBe("LIST");
    }
  });

  it("returns null when the token has no ablListAddress yet", () => {
    const token = withAblList(allowlist("stablecoin"), null);
    expect(getOnChainAllowlistMutationForMint(token)).toBeNull();
  });

  it("treats an empty-string ablListAddress as unset and returns null", () => {
    const token = withAblList(allowlist("stablecoin"), "");
    expect(getOnChainAllowlistMutationForMint(token)).toBeNull();
  });

  it("returns null for blocklist tokens regardless of on-chain ABL state", () => {
    for (const template of ["stablecoin", "tokenized-security"] as const) {
      expect(getOnChainAllowlistMutationForMint(withAblList(denylist(template)))).toBeNull();
    }
  });

  it("returns null for tokens with disabled access control", () => {
    expect(getOnChainAllowlistMutationForMint(withAblList(denylist("custom")))).toBeNull();
  });
});

describe("controlListMovement", () => {
  it("treats a change that takes access away as a control", () => {
    expect(controlListMovement(allowlist("stablecoin"), "remove")).toBe("issuance.control");
    expect(controlListMovement(denylist("stablecoin"), "add")).toBe("issuance.control");
  });

  it("treats a change that grants access as a start", () => {
    expect(controlListMovement(allowlist("stablecoin"), "add")).toBe("issuance.authority");
    expect(controlListMovement(denylist("tokenized-security"), "remove")).toBe(
      "issuance.authority"
    );
  });
});
