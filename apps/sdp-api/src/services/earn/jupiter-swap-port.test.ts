import { describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import { createJupiterSwapPort, type JupiterSwapService } from "./jupiter-swap-port";

// SAFETY: the port only hands `env` to the injected Jupiter service, which ignores it here.
const env = {} as Env;

/** A Jupiter service whose build answers one fixed leg. */
function jupiterReturning() {
  return {
    fetchJupiterSwapLeg: vi.fn<JupiterSwapService["fetchJupiterSwapLeg"]>().mockResolvedValue({
      instructions: [],
      lookupTableAddresses: [],
      sourceAmount: "100",
      quotedAmount: "92.1",
      minOutAmount: "91.6",
      priceImpactPct: "0",
      routeLabels: ["venue"],
      slippageBps: 50,
    }),
    fetchJupiterSwapQuote: vi.fn<JupiterSwapService["fetchJupiterSwapQuote"]>(),
  };
}

describe("createJupiterSwapPort", () => {
  it("builds an owner-paid swap with Jupiter's default account ceiling", async () => {
    const jupiter = jupiterReturning();

    const leg = await createJupiterSwapPort(env, "Jupiter swaps", jupiter).buildSwapLeg({
      cluster: "mainnet-beta",
      inputMint: "usdc",
      outputMint: "usdy",
      amount: "100",
      owner: "owner",
      slippageBps: 50,
    });

    expect(jupiter.fetchJupiterSwapLeg).toHaveBeenCalledWith(env, expect.any(Object), {
      inputMint: "usdc",
      outputMint: "usdy",
      sourceAmount: "100",
      owner: "owner",
      payer: undefined,
      slippageBps: 50,
      maxAccounts: undefined,
    });
    expect(leg).toEqual({
      instructions: [],
      lookupTableAddresses: [],
      quotedAmount: "92.1",
      minOutAmount: "91.6",
      priceImpactPct: "0",
      routeLabels: ["venue"],
    });
  });

  it("names its caller when it refuses a devnet request, without calling Jupiter", async () => {
    const jupiter = jupiterReturning();

    await expect(
      createJupiterSwapPort(env, "Jupiter swaps", jupiter).buildSwapLeg({
        cluster: "devnet",
        inputMint: "usdc",
        outputMint: "usdy",
        amount: "1",
        owner: "owner",
        slippageBps: 50,
      })
    ).rejects.toThrow("Jupiter swaps are mainnet-only; refusing a devnet swap request");
    expect(jupiter.fetchJupiterSwapLeg).not.toHaveBeenCalled();
  });
});
