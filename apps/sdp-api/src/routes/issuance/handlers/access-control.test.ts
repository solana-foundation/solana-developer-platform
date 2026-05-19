import type { Token, TokenTemplate } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { getOnChainAllowlistMutationForMint, shouldEnableOnChainAcl } from "./access-control";

type Shape = Pick<Token, "template" | "requiresAllowlist">;
type WithAblList = Shape & Pick<Token, "ablListAddress">;

const allowlist = (template: TokenTemplate): Shape => ({ template, requiresAllowlist: true });
const denylist = (template: TokenTemplate): Shape => ({ template, requiresAllowlist: false });
const withAblList = (shape: Shape, ablListAddress: string | null = "LIST"): WithAblList => ({
  ...shape,
  ablListAddress,
});

describe("shouldEnableOnChainAcl", () => {
  it("returns false for templates without access control regardless of network", () => {
    const token = denylist("custom");
    expect(shouldEnableOnChainAcl(token, "devnet")).toBe(false);
    expect(shouldEnableOnChainAcl(token, "mainnet-beta")).toBe(false);
    expect(shouldEnableOnChainAcl(token, undefined)).toBe(false);
  });

  it("enables on-chain ABL for denylist tokens on every network", () => {
    for (const template of ["stablecoin", "tokenized-security"] as const) {
      const token = denylist(template);
      expect(shouldEnableOnChainAcl(token, "devnet")).toBe(true);
      expect(shouldEnableOnChainAcl(token, "mainnet-beta")).toBe(true);
      expect(shouldEnableOnChainAcl(token, undefined)).toBe(true);
    }
  });

  it("enables on-chain ABL for allowlist tokens on every network", () => {
    for (const template of ["stablecoin", "tokenized-security", "arcade"] as const) {
      const token = allowlist(template);
      expect(shouldEnableOnChainAcl(token, "mainnet-beta")).toBe(true);
      expect(shouldEnableOnChainAcl(token, "devnet")).toBe(true);
      expect(shouldEnableOnChainAcl(token, "testnet")).toBe(true);
      expect(shouldEnableOnChainAcl(token, undefined)).toBe(true);
    }
  });
});

describe("getOnChainAllowlistMutationForMint", () => {
  it("returns the list address for allowlist tokens with on-chain ABL active and a populated list", () => {
    for (const template of ["stablecoin", "tokenized-security", "arcade"] as const) {
      const token = withAblList(allowlist(template));
      expect(getOnChainAllowlistMutationForMint(token, "devnet")).toBe("LIST");
      expect(getOnChainAllowlistMutationForMint(token, "mainnet-beta")).toBe("LIST");
    }
  });

  it("returns null when the token has no ablListAddress yet", () => {
    const token = withAblList(allowlist("stablecoin"), null);
    expect(getOnChainAllowlistMutationForMint(token, "devnet")).toBeNull();
  });

  it("returns null for blocklist tokens regardless of on-chain ABL state", () => {
    for (const template of ["stablecoin", "tokenized-security"] as const) {
      const token = withAblList(denylist(template));
      expect(getOnChainAllowlistMutationForMint(token, "devnet")).toBeNull();
      expect(getOnChainAllowlistMutationForMint(token, "mainnet-beta")).toBeNull();
    }
  });

  it("returns null for tokens with disabled access control", () => {
    const token = withAblList(denylist("custom"));
    expect(getOnChainAllowlistMutationForMint(token, "mainnet-beta")).toBeNull();
  });
});
