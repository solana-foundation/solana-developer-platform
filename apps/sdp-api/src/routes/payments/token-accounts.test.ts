import { createClusterRpc } from "@sdp/rpc/factory";
import { runInClusterScope } from "@sdp/rpc/scope";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { type Address, createNoopSigner } from "@solana/kit";
import {
  getTransferCheckedInstructionDataDecoder,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { installClusterRpcResponder, tokenAccountsByOwnerResult } from "@/test/helpers/cluster-rpc";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import { respondMintAccounts, scaledUiAmountConfig } from "@/test/helpers/token-mints";
import {
  buildSplTransferInstructions,
  getSplTokenBalances,
  resolveTokenLabel,
  withIssuedTokenLabels,
} from "./token-accounts";

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
});

describe("buildSplTransferInstructions", () => {
  const rpc = installClusterRpcResponder();

  it.each([false, true])(
    "builds exact amounts or rejects scaled mints (scaled=%s)",
    async (scaled) => {
      const mint = syntheticAddress(11);
      respondMintAccounts(rpc, {
        mints: new Map([
          [
            mint,
            {
              decimals: 6,
              extensions: scaled
                ? [
                    scaledUiAmountConfig({
                      multiplier: 2,
                      newMultiplier: 4,
                      newMultiplierEffectiveTimestamp: 1_800_000_000n,
                    }),
                  ]
                : null,
            },
          ],
        ]),
        clockUnixTimestamp: 1_750_000_000n,
      });
      rpc.answer(
        "getTokenAccountsByOwner",
        tokenAccountsByOwnerResult(1, [
          {
            pubkey: syntheticAddress(12),
            mint,
            amount: "20000000",
            decimals: 9,
            uiAmountString: "40",
            state: "initialized",
          },
        ])
      );

      const result = runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
        buildSplTransferInstructions(createClusterRpc(), {
          authority: createNoopSigner(syntheticAddress(13)),
          destination: syntheticAddress(14),
          mint,
          amount: "9007199254.740993",
          ataRentPayer: syntheticAddress(15),
        })
      );

      if (scaled) {
        await expect(result).rejects.toMatchObject({ code: "BAD_REQUEST", statusCode: 400 });
        return;
      }
      const { transferInstruction } = await result;
      expect(rpc.requests.filter((request) => request.method === "getAccountInfo")).toHaveLength(1);
      expect(transferInstruction.programAddress).toBe(TOKEN_2022_PROGRAM_ADDRESS);
      expect(
        getTransferCheckedInstructionDataDecoder().decode(transferInstruction.data)
      ).toMatchObject({ amount: 9007199254740993n, decimals: 6 });
    }
  );
});
