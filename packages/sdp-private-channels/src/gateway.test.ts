import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { getChannelTokenBalance } from "./gateway";

// Devnet USDC (classic Token program) + a real devnet account as the owner.
const USDC = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const OWNER = address("7C1Pu8mbHaDDTFnGH8YTqemNDofqXP3XEotzSo6TbwHz");

/** Minimal fake of the Kit RPC surface the gateway helper touches. */
function fakeRpc(overrides: {
  accountInfo: unknown;
  tokenBalance?: {
    amount: string;
    decimals: number;
    uiAmount: number | null;
    uiAmountString: string;
  };
}) {
  return {
    getAccountInfo: () => ({ send: async () => ({ value: overrides.accountInfo }) }),
    getTokenAccountBalance: () => ({ send: async () => ({ value: overrides.tokenBalance }) }),
    // biome-ignore lint/suspicious/noExplicitAny: hand-rolled test double for the Kit RPC.
  } as any;
}

describe("getChannelTokenBalance", () => {
  it("derives the classic-Token ATA deterministically", async () => {
    const a = await getChannelTokenBalance(fakeRpc({ accountInfo: null }), OWNER, USDC);
    const b = await getChannelTokenBalance(fakeRpc({ accountInfo: null }), OWNER, USDC);
    expect(a.tokenAccount).toBe(b.tokenAccount);
    expect(a.tokenAccount).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("returns balance null when the channel token account does not exist", async () => {
    const result = await getChannelTokenBalance(fakeRpc({ accountInfo: null }), OWNER, USDC);
    expect(result.balance).toBeNull();
  });

  it("maps the gateway token balance when the account exists", async () => {
    const result = await getChannelTokenBalance(
      fakeRpc({
        accountInfo: { lamports: 2039280n },
        tokenBalance: { amount: "1500000", decimals: 6, uiAmount: 1.5, uiAmountString: "1.5" },
      }),
      OWNER,
      USDC
    );
    expect(result.balance).toEqual({ amount: "1500000", decimals: 6, uiAmountString: "1.5" });
  });
});
