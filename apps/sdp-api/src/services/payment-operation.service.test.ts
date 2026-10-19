import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import { type SolanaCluster, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { describe, expect, it } from "vitest";
import { normalizePaymentToken, rampTransferTokenMint } from "@/services/payment-operation.service";

const USDC_MINT_BY_ENVIRONMENT = [
  ["production", WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address],
  ["sandbox", WELL_KNOWN_TOKENS.USDC.mints.devnet.address],
] as const satisfies readonly (readonly [SdpEnvironment, string])[];

describe("normalizePaymentToken", () => {
  it.each(USDC_MINT_BY_ENVIRONMENT)(
    "resolves USDC to its mint on the %s scope's cluster",
    (environment, mint) => {
      expect(
        runInClusterScope({ projectId: null, environment }, () => normalizePaymentToken("USDC"))
      ).toBe(mint);
    }
  );

  it("refuses a well-known symbol the scope's cluster has no mint for", () => {
    expect(() =>
      runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
        normalizePaymentToken("USDT")
      )
    ).toThrow("USDT is not available on devnet");
  });

  it.each([
    [
      "sandbox",
      "devnet",
      WELL_KNOWN_TOKENS.USDC.mints.devnet.address,
      WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address,
    ],
    [
      "production",
      "mainnet-beta",
      WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address,
      WELL_KNOWN_TOKENS.USDC.mints.devnet.address,
    ],
  ] as const satisfies readonly (readonly [SdpEnvironment, SolanaCluster, string, string])[])(
    "keeps the %s scope's USDC mint address and refuses the other cluster's",
    (environment, cluster, ownMint, foreignMint) => {
      const normalizeInScope = (token: string) =>
        runInClusterScope({ projectId: null, environment }, () => normalizePaymentToken(token));

      expect(normalizeInScope(ownMint)).toBe(ownMint);
      expect(() => normalizeInScope(foreignMint)).toThrow(
        `USDC mint ${foreignMint} is not available on ${cluster}`
      );
    }
  );
});

describe("rampTransferTokenMint", () => {
  it.each(USDC_MINT_BY_ENVIRONMENT)(
    "records the USDC rail as its mint on the %s scope's cluster",
    (environment, mint) => {
      expect(
        runInClusterScope({ projectId: null, environment }, () =>
          rampTransferTokenMint("usdc.solana")
        )
      ).toBe(mint);
    }
  );
});
