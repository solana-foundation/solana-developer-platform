import type { EarnStrategy } from "@sdp/types/earn";
import { earnStrategyParticipation } from "@sdp/types/provider-access";
import { describe, expect, it } from "vitest";
import {
  earnDepositsNotOnPlan,
  earnVaultDepositAvailability,
  SURFACED_VAULT_DIRECT_EARN_PROVIDERS,
} from "./earn-surfacing";

const strategy: EarnStrategy = {
  ...earnStrategyParticipation("kamino"),
  id: "earn_strategy_live",
  provider: "kamino",
  providerReference: "Kvault11111111111111111111111111111111111",
  name: "Kamino USDC Vault",
  sourceKind: "defi",
  depositMints: ["So11111111111111111111111111111111111111112"],
  apyType: "variable",
  liquidityTerm: "instant",
  status: "active",
  depositSlippage: null,
  withdrawalSlippage: null,
  hostCluster: "devnet",
  fundable: true,
  feeSponsored: false,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
};

describe("earnVaultDepositAvailability", () => {
  it("requires the strategy, environment, and organization provider to all allow deposits", () => {
    expect(
      earnVaultDepositAvailability(strategy, "sandbox", {
        kamino: { entitled: true, configured: true, enabled: true },
      })
    ).toBe("available");
    // Kamino and Veda deposits open in production too (PRO-1986, PRO-1777);
    // the environment gate now bites a mainnet-only provider, Jupiter Lend,
    // from a sandbox project.
    expect(
      earnVaultDepositAvailability({ ...strategy, hostCluster: "mainnet-beta" }, "production", {
        kamino: { entitled: true, configured: true, enabled: true },
      })
    ).toBe("available");
    expect(
      earnVaultDepositAvailability(
        { ...strategy, provider: "jupiter_lend", hostCluster: "mainnet-beta" },
        "sandbox",
        { jupiter_lend: { entitled: true, configured: true, enabled: true } }
      )
    ).toBe("environment_unavailable");
    expect(earnVaultDepositAvailability(strategy, "sandbox", null)).toBe("access_unavailable");
    expect(
      earnVaultDepositAvailability(strategy, "sandbox", {
        kamino: { entitled: false, configured: true, enabled: false },
      })
    ).toBe("provider_not_entitled");
    expect(
      earnVaultDepositAvailability({ ...strategy, fundable: false }, "sandbox", {
        kamino: { entitled: true, configured: true, enabled: true },
      })
    ).toBe("cluster_unavailable");
  });

  it("answers the cluster reason first — the one fact that cannot change under the row", () => {
    // A mirrored mainnet row (PRO-1742) that is ALSO paused still names the
    // cluster: the pause is transient, the instrument's home cluster is not.
    expect(
      earnVaultDepositAvailability(
        { ...strategy, fundable: false, hostCluster: "mainnet-beta", status: "paused" },
        "sandbox",
        { kamino: { entitled: true, configured: true, enabled: true } }
      )
    ).toBe("cluster_unavailable");
    // And it outranks the environment gate too: a non-fundable row in
    // production is cluster-shaped, not environment-shaped.
    expect(
      earnVaultDepositAvailability({ ...strategy, fundable: false }, "production", {
        kamino: { entitled: true, configured: true, enabled: true },
      })
    ).toBe("cluster_unavailable");
  });

  it("offers Jupiter Lend on production while its mirrored sandbox row stays browse-only", () => {
    const jupiter = {
      ...strategy,
      provider: "jupiter_lend",
      hostCluster: "mainnet-beta" as const,
    };
    const access = {
      jupiter_lend: { entitled: true, configured: true, enabled: true },
    };

    expect(earnVaultDepositAvailability(jupiter, "production", access)).toBe("available");
    expect(earnVaultDepositAvailability({ ...jupiter, fundable: false }, "sandbox", access)).toBe(
      "cluster_unavailable"
    );
  });

  it("keeps hidden Ondo deposits unavailable even for an enabled organization", () => {
    const ondo = {
      ...strategy,
      ...earnStrategyParticipation("ondo"),
      provider: "ondo",
      sourceKind: "rwa" as const,
      hostCluster: "mainnet-beta" as const,
      depositSlippage: { quoteRequired: true as const, defaultToleranceBps: 50 },
      withdrawalSlippage: { quoteRequired: true as const, defaultToleranceBps: 50 },
    };
    const access = {
      ondo: { entitled: true, configured: true, enabled: true },
    };

    expect(SURFACED_VAULT_DIRECT_EARN_PROVIDERS).not.toContain("ondo");
    expect(earnVaultDepositAvailability(ondo, "production", access)).toBe("strategy_unavailable");
    expect(earnVaultDepositAvailability({ ...ondo, fundable: false }, "sandbox", access)).toBe(
      "cluster_unavailable"
    );
  });

  it.each([
    [{ entitled: false, configured: false, enabled: false }, "provider_not_entitled"],
    [{ entitled: true, configured: false, enabled: false }, "provider_not_configured"],
    [{ entitled: true, configured: true, enabled: false }, "provider_disabled"],
    [{ entitled: true, configured: true, enabled: true }, "available"],
  ] as const)("names the first provider check %o fails as %s", (entry, availability) => {
    expect(earnVaultDepositAvailability(strategy, "sandbox", { kamino: entry })).toBe(availability);
  });

  it("treats a provider the access read omits as unverified, not as off the plan", () => {
    expect(earnVaultDepositAvailability(strategy, "sandbox", {})).toBe("access_unavailable");
  });
});

describe("earnDepositsNotOnPlan", () => {
  const notEntitled = { entitled: false, configured: true, enabled: false };
  const entitled = { entitled: true, configured: true, enabled: true };
  const noneEntitled = Object.fromEntries(
    SURFACED_VAULT_DIRECT_EARN_PROVIDERS.map((provider) => [provider, notEntitled])
  );

  it("is true only when every offered vault provider is read as not entitled", () => {
    expect(earnDepositsNotOnPlan(noneEntitled)).toBe(true);
    for (const provider of SURFACED_VAULT_DIRECT_EARN_PROVIDERS) {
      expect(earnDepositsNotOnPlan({ ...noneEntitled, [provider]: entitled })).toBe(false);
    }
  });

  it("stays quiet when access is unread or a provider's entry is missing", () => {
    expect(earnDepositsNotOnPlan(null)).toBe(false);
    const [omitted, ...rest] = SURFACED_VAULT_DIRECT_EARN_PROVIDERS;
    expect(omitted).toBeDefined();
    expect(
      earnDepositsNotOnPlan(Object.fromEntries(rest.map((provider) => [provider, notEntitled])))
    ).toBe(false);
  });

  it("ignores an entitlement to a provider Earn does not offer deposits with", () => {
    expect(earnDepositsNotOnPlan({ ...noneEntitled, hastra: entitled })).toBe(true);
  });
});
