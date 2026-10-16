import type { CustodyWalletTokenBalance } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { buildTokenSymbolsByMint } from "./home-token-symbols";
import { resolveTransferTokenLabel } from "./payments/payments-overview.utils";

const ISSUED_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function balance(overrides: Partial<CustodyWalletTokenBalance>): CustodyWalletTokenBalance {
  return {
    token: "USDC",
    mint: "mint-usdc",
    amount: "1000000",
    uiAmount: "1",
    decimals: 6,
    ...overrides,
  };
}

describe("buildTokenSymbolsByMint", () => {
  it("keeps an issued symbol for a mint the organization no longer holds", () => {
    // The regression: with balances as the only source the mint fell through to
    // shortenAddress, which is truthy, so it won over the symbol the row already had.
    const rows = [{ token: "ATD", tokenMint: ISSUED_MINT }];
    const symbols = buildTokenSymbolsByMint(rows, []);

    expect(resolveTransferTokenLabel(ISSUED_MINT, symbols)).toBe("ATD");
    expect(resolveTransferTokenLabel(ISSUED_MINT, {})).not.toBe("ATD");
  });

  it("prefers the balance symbol when both know the mint", () => {
    const rows = [{ token: "STALE", tokenMint: "mint-usdc" }];
    const symbols = buildTokenSymbolsByMint(rows, [balance({ token: "USDC" })]);

    expect(symbols["mint-usdc"]).toBe("USDC");
  });

  it("ignores rows that name nothing", () => {
    const symbols = buildTokenSymbolsByMint(
      [
        { token: "—", tokenMint: ISSUED_MINT },
        { token: "SOL", tokenMint: null },
        { token: ISSUED_MINT, tokenMint: ISSUED_MINT },
      ],
      []
    );

    expect(symbols).toEqual({});
  });
});
