import type { Token, TokenTemplate } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { shouldEnableOnChainAcl } from "./access-control";

type Shape = Pick<Token, "template" | "requiresAllowlist">;

const allowlist = (template: TokenTemplate): Shape => ({ template, requiresAllowlist: true });
const denylist = (template: TokenTemplate): Shape => ({ template, requiresAllowlist: false });

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

  it("enables on-chain ABL for allowlist tokens only on mainnet", () => {
    for (const template of ["stablecoin", "tokenized-security", "arcade"] as const) {
      const token = allowlist(template);
      expect(shouldEnableOnChainAcl(token, "mainnet-beta")).toBe(true);
      expect(shouldEnableOnChainAcl(token, "devnet")).toBe(false);
      expect(shouldEnableOnChainAcl(token, "testnet")).toBe(false);
      expect(shouldEnableOnChainAcl(token, undefined)).toBe(false);
    }
  });
});
