import {
  supportsPortfolioWallets,
  supportsVaultDirect,
  supportsVaultParRedemption,
  supportsVaultWithdraw,
} from "@sdp/earn/capabilities";
import { describe, expect, it } from "vitest";
import { EARN_PROVIDER_CLIENTS, resolveEarnProviderClient } from "./earn-provider-registry";

describe("API Earn provider registry", () => {
  it("registers Kamino's executable vault-direct client", () => {
    const client = resolveEarnProviderClient("kamino");

    expect(client).toBe(EARN_PROVIDER_CLIENTS.kamino);
    expect(supportsVaultDirect(client)).toBe(true);
    expect(supportsPortfolioWallets(client)).toBe(false);
  });

  it("keeps the non-Kamino provider singletons", () => {
    expect(resolveEarnProviderClient("upshift")).toBe(EARN_PROVIDER_CLIENTS.upshift);
  });

  it("registers Hastra's deposit, par, and optional liquid-exit capabilities", () => {
    const client = resolveEarnProviderClient("hastra");

    expect(client).toBe(EARN_PROVIDER_CLIENTS.hastra);
    expect(supportsVaultDirect(client)).toBe(true);
    expect(supportsVaultWithdraw(client)).toBe(true);
    expect(supportsVaultParRedemption(client)).toBe(true);
    expect(supportsPortfolioWallets(client)).toBe(false);
  });
});
