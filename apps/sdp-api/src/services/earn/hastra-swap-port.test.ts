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

import { createHastraSwapPort } from "./hastra-swap-port";

const env = {
  EARN_HASTRA_DEX_EXIT_ENABLED: "true",
  JUPITER_SWAP_API_KEY: "jup_test_key",
} as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createHastraSwapPort", () => {
  it("refuses the Jupiter seam by default without calling it", () => {
    expect(() => createHastraSwapPort({ JUPITER_SWAP_API_KEY: "jup_test_key" } as Env)).toThrow(
      "Hastra Jupiter exits are disabled"
    );
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.quote).not.toHaveBeenCalled();
  });

  it("refuses the Jupiter seam when the flag is on but its runtime key is absent", () => {
    expect(() => createHastraSwapPort({ EARN_HASTRA_DEX_EXIT_ENABLED: "true" } as Env)).toThrow(
      "configure EARN_HASTRA_DEX_EXIT_ENABLED=true with JUPITER_SWAP_API_KEY"
    );
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.quote).not.toHaveBeenCalled();
  });

  it("forwards the composed-exit payer and account ceiling through the API trust boundary", async () => {
    mocks.build.mockResolvedValue({
      instructions: [{ programAddress: "program", accounts: [], data: "AQ==" }],
      lookupTableAddresses: ["lookup"],
      sourceAmount: "10",
      quotedAmount: "9.99",
      minOutAmount: "9.95",
      minOutAtoms: "9950000",
      priceImpactPct: "0.0001",
      routeLabels: ["venue"],
      slippageBps: 40,
    });
    const port = createHastraSwapPort(env);

    const leg = await port.buildSwapLeg({
      cluster: "mainnet-beta",
      inputMint: "wylds",
      outputMint: "usdc",
      amount: "10",
      owner: "owner",
      payer: "payer",
      slippageBps: 40,
      maxAccounts: 24,
    });

    expect(mocks.build).toHaveBeenCalledWith(env, expect.any(Object), {
      inputMint: "wylds",
      outputMint: "usdc",
      sourceAmount: "10",
      owner: "owner",
      payer: "payer",
      slippageBps: 40,
      maxAccounts: 24,
    });
    expect(leg).toEqual({
      instructions: [{ programAddress: "program", accounts: [], data: "AQ==" }],
      lookupTableAddresses: ["lookup"],
      quotedAmount: "9.99",
      minOutAmount: "9.95",
      priceImpactPct: "0.0001",
      routeLabels: ["venue"],
    });
  });

  it("quotes only on mainnet and never calls Jupiter for devnet", async () => {
    const port = createHastraSwapPort(env);

    await expect(
      port.quoteSwap({
        cluster: "devnet",
        inputMint: "wylds",
        outputMint: "usdc",
        amount: "10",
      })
    ).rejects.toThrow("Hastra Jupiter exits are mainnet-only");
    expect(mocks.quote).not.toHaveBeenCalled();
  });
});
