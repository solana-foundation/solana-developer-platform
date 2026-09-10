import * as solanaRpc from "@sdp/rpc/solana";
import { address, createNoopSigner } from "@solana/kit";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { scopeEnvToCluster } from "@/lib/cluster-env";
import * as sponsorshipService from "@/services/sponsorship.service";
import type { Env } from "@/types/env";
import { createToken2022Service } from "./factory";

const signer = createNoopSigner(address("8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ"));
const deploymentEnv = {
  SOLANA_NETWORK: "devnet",
  SOLANA_RPC_URL: "https://devnet.example.invalid",
  SOLANA_MAINNET_RPC_URL: "https://mainnet.example.invalid",
  KORA_RPC_URL: "https://kora.example.invalid",
} as Env;

vi.spyOn(solanaRpc, "createRpc").mockReturnValue({} as ReturnType<typeof solanaRpc.createRpc>);

describe("createToken2022Service with a cluster-scoped env", () => {
  afterEach(() => vi.clearAllMocks());
  afterAll(() => vi.restoreAllMocks());

  it("attaches Kora on devnet", () => {
    const sponsorship = vi
      .spyOn(sponsorshipService, "createUnscopedSponsorshipFeePayment")
      .mockReturnValue(
        {} as ReturnType<typeof sponsorshipService.createUnscopedSponsorshipFeePayment>
      );

    createToken2022Service(scopeEnvToCluster(deploymentEnv, "devnet"), signer);

    expect(sponsorship).toHaveBeenCalledOnce();
  });

  it("leaves mainnet wallet-paid", () => {
    const sponsorship = vi
      .spyOn(sponsorshipService, "createUnscopedSponsorshipFeePayment")
      .mockReturnValue(
        {} as ReturnType<typeof sponsorshipService.createUnscopedSponsorshipFeePayment>
      );

    createToken2022Service(scopeEnvToCluster(deploymentEnv, "mainnet-beta"), signer);

    expect(sponsorship).not.toHaveBeenCalled();
  });
});
