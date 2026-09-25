import type { SolanaRpc } from "@sdp/rpc/solana";
import { SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKENS } from "@sdp/types";
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { attachUsdValuesToBalances } from "@/services/helius-das.service";
import { env } from "@/test/helpers/env";
import { getSplTokenBalances, resolveTokenLabel, withIssuedTokenLabels } from "./token-accounts";

const OWNER = "7YH7xGm2qRzJw9h7Xc3mK1sV6pN8dF4tL2aB5cD9eE1" as Address;
const USDC_DEVNET = WELL_KNOWN_TOKENS.USDC.mints.devnet.address as Address;
const USDC_DECIMALS = WELL_KNOWN_TOKENS.USDC.mints.devnet.decimals;

interface ParsedTokenAccount {
  pubkey: string;
  account: {
    data: {
      parsed: {
        info: {
          mint: Address;
          tokenAmount: {
            amount: string;
            decimals: number;
            uiAmount: number;
            uiAmountString: string;
          };
        };
      };
    };
  };
}

function tokenAccount(
  pubkey: string,
  amount: string,
  uiAmountString: string,
  decimals: number,
  mint: Address
): ParsedTokenAccount {
  return {
    pubkey,
    account: {
      data: {
        parsed: {
          info: {
            mint,
            tokenAmount: {
              amount,
              decimals,
              uiAmount: Number(uiAmountString),
              uiAmountString,
            },
          },
        },
      },
    },
  };
}

function rpcWithAccounts(
  splTokenAccounts: ParsedTokenAccount[],
  token2022Accounts: ParsedTokenAccount[]
): SolanaRpc {
  return {
    getTokenAccountsByOwner: (_owner: Address, { programId }: { programId: string }) => ({
      send: async () => ({
        value:
          programId === SPL_TOKEN_PROGRAMS["spl-token"]
            ? splTokenAccounts
            : programId === SPL_TOKEN_PROGRAMS["token-2022"]
              ? token2022Accounts
              : [],
      }),
    }),
  } as unknown as SolanaRpc;
}

describe("resolveTokenLabel", () => {
  it("uses the issued token symbol for a known mint", () => {
    const mint = "HZWQBKZW8HXMN6BF2YFZNRHT3C2IXXZPKCFU7UBEDKTR";
    const labels = new Map([[mint, "MINT"]]);

    expect(resolveTokenLabel(mint, labels)).toBe("MINT");
  });

  it("falls back to the well-known token symbol", () => {
    expect(resolveTokenLabel(WELL_KNOWN_TOKENS.USDC.mints.devnet.address)).toBe("USDC");
  });

  it("falls back to the mint address when no symbol is known", () => {
    const mint = "UnknownMint1111111111111111111111111111111111";

    expect(resolveTokenLabel(mint)).toBe(mint);
  });
});

describe("withIssuedTokenLabels", () => {
  it("renames only the balances whose mint the organization issued", () => {
    const issued = "IssuedMint111111111111111111111111111111111";
    const usdc = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;
    const balances = [
      { token: issued, mint: issued, amount: "1" },
      { token: "USDC", mint: usdc, amount: "2" },
    ];

    expect(withIssuedTokenLabels(balances, new Map([[issued, " ISS "]]))).toEqual([
      { token: "ISS", mint: issued, amount: "1" },
      { token: "USDC", mint: usdc, amount: "2" },
    ]);
  });
});

describe("getSplTokenBalances", () => {
  it("asks both token programs before either answers", async () => {
    const asked: string[] = [];
    const answers: Array<() => void> = [];
    const rpc = {
      getTokenAccountsByOwner: (_owner: Address, { programId }: { programId: string }) => ({
        send: () =>
          new Promise((resolve) => {
            asked.push(programId);
            answers.push(() => resolve({ value: [] }));
          }),
      }),
    } as unknown as SolanaRpc;

    const balances = getSplTokenBalances(rpc, "Owner111" as Address);
    await Promise.resolve();

    expect(asked).toEqual([SPL_TOKEN_PROGRAMS["spl-token"], SPL_TOKEN_PROGRAMS["token-2022"]]);
    for (const answer of answers) answer();
    await expect(balances).resolves.toEqual([]);
  });

  it("keeps a single account's UI amount consistent with its raw amount", async () => {
    const balances = await getSplTokenBalances(
      rpcWithAccounts(
        [tokenAccount("acc-1", "1234567", "1.234567", USDC_DECIMALS, USDC_DEVNET)],
        []
      ),
      OWNER
    );

    expect(balances).toEqual([
      { token: "USDC", mint: USDC_DEVNET, amount: "1234567", uiAmount: "1.234567", decimals: 6 },
    ]);
  });

  it("skips zero-balance accounts", async () => {
    const balances = await getSplTokenBalances(
      rpcWithAccounts(
        [
          tokenAccount("acc-1", "0", "0", USDC_DECIMALS, USDC_DEVNET),
          tokenAccount("acc-2", "1234567", "1.234567", USDC_DECIMALS, USDC_DEVNET),
        ],
        []
      ),
      OWNER
    );

    expect(balances).toEqual([
      { token: "USDC", mint: USDC_DEVNET, amount: "1234567", uiAmount: "1.234567", decimals: 6 },
    ]);
  });

  it("sums same-mint accounts by raw units and recomputes the UI amount from the total", async () => {
    const balances = await getSplTokenBalances(
      rpcWithAccounts(
        [
          tokenAccount("acc-1", "1000000", "1", USDC_DECIMALS, USDC_DEVNET),
          tokenAccount("acc-2", "999000000", "999", USDC_DECIMALS, USDC_DEVNET),
        ],
        []
      ),
      OWNER
    );

    expect(balances).toEqual([
      { token: "USDC", mint: USDC_DEVNET, amount: "1000000000", uiAmount: "1000", decimals: 6 },
    ]);
  });

  it("aggregates the same mint across both token programs with a consistent UI amount", async () => {
    const balances = await getSplTokenBalances(
      rpcWithAccounts(
        [tokenAccount("spl-acc", "500000", "0.5", USDC_DECIMALS, USDC_DEVNET)],
        [tokenAccount("token-2022-acc", "1500000", "1.5", USDC_DECIMALS, USDC_DEVNET)]
      ),
      OWNER
    );

    expect(balances).toEqual([
      { token: "USDC", mint: USDC_DEVNET, amount: "2000000", uiAmount: "2", decimals: 6 },
    ]);
  });
});

describe("getSplTokenBalances USD enrichment", () => {
  it("prices the summed raw balance, not the first account's stale UI amount", async () => {
    const balances = await getSplTokenBalances(
      rpcWithAccounts(
        [
          tokenAccount("acc-1", "1000000", "1", USDC_DECIMALS, USDC_DEVNET),
          tokenAccount("acc-2", "999000000", "999", USDC_DECIMALS, USDC_DEVNET),
        ],
        []
      ),
      OWNER
    );

    const [enriched] = await attachUsdValuesToBalances(env, balances);
    expect(enriched?.usdPrice).toBe(1);
    expect(enriched?.usdValue).toBe(1000);
  });
});
