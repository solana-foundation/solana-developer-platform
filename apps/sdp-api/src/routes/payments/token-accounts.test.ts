import { runInClusterScope } from "@sdp/rpc/scope";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { type Address, createNoopSigner } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getTransferCheckedInstructionDataDecoder,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import {
  installClusterRpcResponder,
  systemAccountInfoResult,
  tokenAccountsByOwnerResult,
} from "@/test/helpers/cluster-rpc";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import { respondMintAccounts, scaledUiAmountConfig } from "@/test/helpers/token-mints";
import {
  buildSplTransferInstructions,
  getSplTokenBalances,
  resolveSourceTokenAccountOrAta,
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
        buildSplTransferInstructions({
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

describe("resolveSourceTokenAccountOrAta (SOLA9-885)", () => {
  const rpc = installClusterRpcResponder();
  const owner = syntheticAddress(21);
  const mint = syntheticAddress(22);
  const paymentMint = {
    decimals: 6,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    toBaseUnits: () => 0n,
  };
  const accountOwnedBy = (programOwner: Address) => ({
    context: { slot: 1 },
    value: {
      data: ["", "base64"],
      executable: false,
      lamports: 2_039_280,
      owner: programOwner,
      rentEpoch: 0,
      space: 165,
    },
  });
  const resolve = () =>
    runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      resolveSourceTokenAccountOrAta(owner, mint, paymentMint)
    );

  it("finds the token account the mint's token program owns at the ATA address", async () => {
    rpc.answer("getAccountInfo", accountOwnedBy(TOKEN_2022_PROGRAM_ADDRESS));
    const [ata] = await findAssociatedTokenPda({
      owner,
      mint,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    await expect(resolve()).resolves.toEqual({ tokenAccount: ata, decimals: 6, exists: true });
  });

  it("treats no account and a system-owned dust account as no token account", async () => {
    rpc.answer("getAccountInfo", { context: { slot: 1 }, value: null });
    await expect(resolve()).resolves.toMatchObject({ exists: false });
    rpc.answer("getAccountInfo", systemAccountInfoResult(1, 1));
    await expect(resolve()).resolves.toMatchObject({ exists: false });
  });

  it("refuses an account another program owns at the ATA address", async () => {
    rpc.answer("getAccountInfo", accountOwnedBy(syntheticAddress(23)));
    await expect(resolve()).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
