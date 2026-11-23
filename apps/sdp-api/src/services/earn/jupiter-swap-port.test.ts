import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";

const mocks = vi.hoisted(() => ({
  build: vi.fn(),
  quote: vi.fn(),
}));

vi.mock("./jupiter-swap.service", () => ({
  fetchJupiterSwapLeg: mocks.build,
  fetchJupiterSwapQuote: mocks.quote,
}));

import { createJupiterSwapPort } from "./jupiter-swap-port";

const env = { JUPITER_SWAP_API_KEY: "jup_test_key" } as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createJupiterSwapPort", () => {
  it("builds an owner-paid swap with Jupiter's default account ceiling", async () => {
    mocks.build.mockResolvedValue({
      instructions: [],
      lookupTableAddresses: [],
      sourceAmount: "100",
      quotedAmount: "92.1",
      minOutAmount: "91.6",
      priceImpactPct: "0",
      routeLabels: ["venue"],
      slippageBps: 50,
    });

    const leg = await createJupiterSwapPort(env, "Jupiter swaps").buildSwapLeg({
      cluster: "mainnet-beta",
      inputMint: "usdc",
      outputMint: "usdy",
      amount: "100",
      owner: "owner",
      slippageBps: 50,
    });

    const [, , request] = mocks.build.mock.calls[0] ?? [];
    expect(request).toMatchObject({ owner: "owner", sourceAmount: "100", slippageBps: 50 });
    expect(request?.payer).toBeUndefined();
    expect(request?.maxAccounts).toBeUndefined();
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
    await expect(
      createJupiterSwapPort(env, "Jupiter swaps").buildSwapLeg({
        cluster: "devnet",
        inputMint: "usdc",
        outputMint: "usdy",
        amount: "1",
        owner: "owner",
        slippageBps: 50,
      })
    ).rejects.toThrow("Jupiter swaps are mainnet-only; refusing a devnet swap request");
    expect(mocks.build).not.toHaveBeenCalled();
  });
});
