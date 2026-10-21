import { runInClusterScope } from "@sdp/rpc/scope";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { type Address, address, createNoopSigner, unixTimestamp } from "@solana/kit";
import { getSysvarClockEncoder, SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import {
  extension,
  getTransferCheckedInstruction,
  type MintArgs,
} from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import {
  installClusterRpcResponder,
  mintAccountInfoResult,
  ownedAccountInfoResult,
} from "@/test/helpers/cluster-rpc";
import { syntheticAddress, syntheticWireTransaction } from "@/test/helpers/parsed-transactions";
import {
  buildSplTransferInstructions,
  getSplTokenBalances,
  readSignedTokenTransfer,
  readTransferMint,
  resolveTokenLabel,
  resolveTransferTerms,
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

const TEST_MINT = syntheticAddress(10);
const TEST_AUTHORITY = createNoopSigner(syntheticAddress(11));
const TEST_CLOCK_TIMESTAMP = 1_800_000_000n;

function scaledUiAmount(newMultiplierEffectiveTimestamp: bigint, multiplier: number) {
  return extension("ScaledUiAmountConfig", {
    authority: syntheticAddress(12),
    multiplier,
    newMultiplierEffectiveTimestamp,
    newMultiplier: 4,
  });
}

const TRANSFER_FEE_CONFIG = extension("TransferFeeConfig", {
  transferFeeConfigAuthority: syntheticAddress(13),
  withdrawWithheldAuthority: syntheticAddress(14),
  withheldAmount: 0n,
  olderTransferFee: { epoch: 0n, maximumFee: 1_000_000n, transferFeeBasisPoints: 1 },
  newerTransferFee: { epoch: 10n, maximumFee: 1_000n, transferFeeBasisPoints: 50 },
});

describe("Token-2022 transfer terms", () => {
  const rpc = installClusterRpcResponder();

  function serveChain(
    tokenProgram: string,
    extensions: MintArgs["extensions"],
    clockEpoch: bigint
  ): void {
    const clock = getSysvarClockEncoder().encode({
      slot: 1n,
      epochStartTimestamp: unixTimestamp(TEST_CLOCK_TIMESTAMP),
      epoch: clockEpoch,
      leaderScheduleEpoch: clockEpoch,
      unixTimestamp: unixTimestamp(TEST_CLOCK_TIMESTAMP),
    });
    rpc.respond("getAccountInfo", (request) => ({
      result:
        request.params[0] === SYSVAR_CLOCK_ADDRESS
          ? ownedAccountInfoResult(1, "Sysvar1111111111111111111111111111111111111", clock)
          : mintAccountInfoResult(1, tokenProgram, { decimals: 6, extensions }),
    }));
  }

  function inSandbox<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    return runInClusterScope({ projectId: null, environment: "sandbox" }, operation);
  }

  function termsFor(amount: string) {
    return inSandbox(async () =>
      resolveTransferTerms(await readTransferMint(TEST_MINT), amount, 6)
    );
  }

  function buildTransfer(tokenProgram: string, amount: string) {
    return inSandbox(() =>
      buildSplTransferInstructions({
        authority: TEST_AUTHORITY,
        destination: syntheticAddress(15),
        mint: TEST_MINT,
        amount,
        ataRentPayer: syntheticAddress(16),
        source: {
          tokenAccount: syntheticAddress(17),
          decimals: 6,
          amount: 10_000_000n,
          frozen: false,
          tokenProgram: address(tokenProgram),
        },
      })
    );
  }

  function clockReads(): number {
    return rpc.requests.filter((request) => request.params[0] === SYSVAR_CLOCK_ADDRESS).length;
  }

  it.each([SPL_TOKEN_PROGRAMS["spl-token"], SPL_TOKEN_PROGRAMS["token-2022"]])(
    "parses a %s mint without extensions exactly, stating no fee, without reading the Clock",
    async (tokenProgram) => {
      serveChain(tokenProgram, null, 0n);

      expect(await termsFor("1.5")).toEqual({ baseUnits: 1_500_000n, transferFee: null });
      expect(clockReads()).toBe(0);
    }
  );

  it.each([
    { effectiveAt: TEST_CLOCK_TIMESTAMP + 1n, multiplier: 2, amount: "1", baseUnits: 500_000n },
    { effectiveAt: TEST_CLOCK_TIMESTAMP, multiplier: 2, amount: "1", baseUnits: 250_000n },
    {
      effectiveAt: TEST_CLOCK_TIMESTAMP + 1n,
      multiplier: 1.5,
      amount: "10",
      baseUnits: 6_666_667n,
    },
  ])(
    "divides $amount by the multiplier in effect at the Clock, rounded up: $baseUnits",
    async ({ effectiveAt, multiplier, amount, baseUnits }) => {
      serveChain(SPL_TOKEN_PROGRAMS["token-2022"], [scaledUiAmount(effectiveAt, multiplier)], 0n);

      expect(await termsFor(amount)).toEqual({ baseUnits, transferFee: null });
      expect(clockReads()).toBe(1);
    }
  );

  it.each([
    { epoch: 9n, amount: "1", transferFee: 100n },
    { epoch: 9n, amount: "0.0005", transferFee: 1n },
    { epoch: 10n, amount: "1", transferFee: 1_000n },
  ])(
    "states the fee of epoch $epoch on $amount, rounded up and capped: $transferFee",
    async ({ epoch, amount, transferFee }) => {
      serveChain(SPL_TOKEN_PROGRAMS["token-2022"], [TRANSFER_FEE_CONFIG], epoch);

      expect((await termsFor(amount)).transferFee).toBe(transferFee);
    }
  );

  it("refuses a Token-2022 account that is not a mint", async () => {
    rpc.respond("getAccountInfo", () => ({
      result: ownedAccountInfoResult(1, SPL_TOKEN_PROGRAMS["token-2022"], new Uint8Array(10)),
    }));

    await expect(termsFor("1")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Token mint account is not a mint",
    });
  });

  it.each([
    {
      tokenProgram: SPL_TOKEN_PROGRAMS["token-2022"],
      extensions: [TRANSFER_FEE_CONFIG],
      signed: { amount: 1_000_000n, decimals: 6, fee: 100n },
    },
    {
      tokenProgram: SPL_TOKEN_PROGRAMS["token-2022"],
      extensions: null,
      signed: { amount: 1_000_000n, decimals: 6, fee: null },
    },
    { tokenProgram: SPL_TOKEN_PROGRAMS["spl-token"], extensions: null, signed: null },
  ])(
    "reads back the Token-2022 transfer the builder signed on a $tokenProgram mint",
    async ({ tokenProgram, extensions, signed }) => {
      serveChain(tokenProgram, extensions, 9n);
      const { createDestinationAtaInstruction, transferInstruction } = await buildTransfer(
        tokenProgram,
        "1"
      );

      expect(
        readSignedTokenTransfer(
          syntheticWireTransaction(TEST_AUTHORITY.address, [
            createDestinationAtaInstruction,
            transferInstruction,
          ])
        )
      ).toEqual(signed);
    }
  );

  it("reads no transfer from a transaction carrying several Token-2022 transfers", () => {
    const toRecipient = (index: number) =>
      getTransferCheckedInstruction({
        source: syntheticAddress(17),
        mint: TEST_MINT,
        destination: syntheticAddress(index),
        authority: TEST_AUTHORITY,
        amount: 5_000_000n,
        decimals: 6,
      });

    expect(
      readSignedTokenTransfer(
        syntheticWireTransaction(TEST_AUTHORITY.address, [toRecipient(18), toRecipient(19)])
      )
    ).toBeNull();
  });
});
