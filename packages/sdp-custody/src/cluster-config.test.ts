import { describe, expect, it } from "vitest";
import { custodyClusterConfig } from "./cluster-config";
import { inClusterScope } from "./test/cluster-scope";

describe("custodyClusterConfig", () => {
  it("refuses to answer outside a cluster scope", () => {
    expect(() => custodyClusterConfig()).toThrow(
      expect.objectContaining({ code: "CLUSTER_SCOPE_MISSING" })
    );
  });

  // Pinned on purpose: each provider's host, asset and network is chosen by the
  // request's cluster, and a swapped or typoed row sends provider calls to the
  // wrong environment (a wrong `network` string typically only fails on the
  // provider's side). Changing what a cluster points at must show up in review
  // as an edit to this table.
  it("answers with the declared table for each cluster", () => {
    expect(inClusterScope("devnet", () => custodyClusterConfig())).toEqual({
      fireblocks: { origin: "https://sandbox-api.fireblocks.io", nativeAsset: "SOL_TEST" },
      privy: { origin: "https://api.privy.io/v1" },
      coinbase_cdp: { origin: "https://api.cdp.coinbase.com/platform", network: "solana-devnet" },
      para: { origin: "https://api.beta.getpara.com" },
      turnkey: { origin: "https://api.turnkey.com" },
      dfns: { origin: "https://api.dfns.io", network: "SolanaDevnet" },
      ibm_haven: { origin: "https://api.digitalassets.ibm.com", network: "SolanaDevnet" },
      anchorage: { origin: "https://api.anchorage.com", network: "solana-devnet" },
      utila: { origin: "https://api.utila.io", network: "networks/solana-devnet" },
    });

    expect(inClusterScope("mainnet-beta", () => custodyClusterConfig())).toEqual({
      fireblocks: { origin: "https://api.fireblocks.io", nativeAsset: "SOL" },
      privy: { origin: "https://api.privy.io/v1" },
      coinbase_cdp: { origin: "https://api.cdp.coinbase.com/platform", network: "solana" },
      para: { origin: "https://api.beta.getpara.com" },
      turnkey: { origin: "https://api.turnkey.com" },
      dfns: { origin: "https://api.dfns.io", network: "Solana" },
      ibm_haven: { origin: "https://api.digitalassets.ibm.com", network: "Solana" },
      anchorage: { origin: "https://api.anchorage.com", network: "solana" },
      utila: { origin: "https://api.utila.io", network: "networks/solana-mainnet" },
    });
  });
});
