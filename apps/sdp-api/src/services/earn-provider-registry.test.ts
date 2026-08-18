import { supportsPortfolioWallets, supportsVaultDirect } from "@sdp/earn/capabilities";
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
    expect(resolveEarnProviderClient("ground")).toBe(EARN_PROVIDER_CLIENTS.ground);
  });
});
