import { supportsPortfolioWallets, supportsVaultDirect } from "@sdp/earn/capabilities";
import { describe, expect, it } from "vitest";
import { assertNotPortfolioProvider, KaminoVaultDirectClient } from "./client";

const client = new KaminoVaultDirectClient(() => "https://example.invalid");

describe("KaminoVaultDirectClient capabilities", () => {
  it("reports the vault-direct capability", () => {
    expect(supportsVaultDirect(client)).toBe(true);
  });

  /**
   * THE INVARIANT THAT PROTECTS CUSTOMER FUNDS.
   *
   * The portfolio capability means "SDP can give you an address to send
   * stablecoins to". Kamino has no such address — its vault is a program
   * account, and tokens sent there are DESTROYED. If this client ever answered
   * yes to both, a portfolio route could render that account as a deposit
   * target. The two capabilities must stay mutually exclusive.
   */
  it("NEVER reports the portfolio-wallet capability", () => {
    expect(supportsPortfolioWallets(client)).toBe(false);
    expect(() => assertNotPortfolioProvider(client)).not.toThrow();
  });

  it("still catalogues — the execution client is a superset, not a replacement", () => {
    expect(client.provider).toBe("kamino");
    expect(client.declaredSupport.sourceKinds).toEqual(["defi"]);
    expect(typeof client.listStrategies).toBe("function");
  });

  it("refuses to build when no RPC endpoint is configured for the cluster", async () => {
    const unconfigured = new KaminoVaultDirectClient(() => "  ");
    await expect(
      unconfigured.buildVaultDeposit(
        { env: {}, environment: "sandbox" },
        {
          providerReference: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
          owner: "11111111111111111111111111111112",
          amount: "1",
        }
      )
      // Fails before any network call, the same fail-closed rule @sdp/earn
      // applies to a missing credential.
    ).rejects.toThrow(/No Solana RPC endpoint configured for devnet/);
  });

  it("maps the SDP environment to the right cluster", async () => {
    const seen: string[] = [];
    const probe = new KaminoVaultDirectClient((cluster) => {
      seen.push(cluster);
      return "";
    });
    for (const environment of ["sandbox", "production"] as const) {
      await probe
        .buildVaultDeposit(
          { env: {}, environment },
          {
            providerReference: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
            owner: "11111111111111111111111111111112",
            amount: "1",
          }
        )
        .catch(() => undefined);
    }
    // sandbox -> devnet, production -> mainnet-beta, via CLUSTER_BY_SDP_ENVIRONMENT
    // rather than a second copy of that mapping.
    expect(seen).toEqual(["devnet", "mainnet-beta"]);
  });
});
