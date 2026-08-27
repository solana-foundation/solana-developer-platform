import type { EarnStrategy } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { earnVaultDepositAvailability } from "./earn-surfacing";

const strategy: EarnStrategy = {
  id: "earn_strategy_live",
  provider: "kamino",
  providerReference: "Kvault11111111111111111111111111111111111",
  name: "Kamino USDC Vault",
  sourceKind: "defi",
  depositMints: ["So11111111111111111111111111111111111111112"],
  apyType: "variable",
  liquidityTerm: "instant",
  status: "active",
  hostCluster: "devnet",
  fundable: true,
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
    expect(
      earnVaultDepositAvailability(strategy, "production", {
        kamino: { entitled: true, configured: true, enabled: true },
      })
    ).toBe("environment_unavailable");
    expect(earnVaultDepositAvailability(strategy, "sandbox", null)).toBe("access_unavailable");
    expect(
      earnVaultDepositAvailability(strategy, "sandbox", {
        kamino: { entitled: false, configured: true, enabled: false },
      })
    ).toBe("provider_unavailable");
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
});
