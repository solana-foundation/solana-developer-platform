import { runInClusterScope } from "@sdp/rpc/scope";
import { SOL_MINT, SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import { type Address, getAddressDecoder } from "@solana/kit";
import { SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import type { ExtensionArgs } from "@solana-program/token-2022";
import { beforeEach, describe, expect, it } from "vitest";
import { installClusterRpcResponder } from "@/test/helpers/cluster-rpc";
import {
  answerMovementAccounts,
  encodedRpcAccount,
  mintRpcAccount,
  TEST_CLOCK,
} from "@/test/helpers/token-movement";
import {
  clearBalanceTermsCacheForTests,
  type HeldTokenBalance,
  nativeSolHolding,
  sumHoldings,
  withDisplayAmount,
  withDisplayAmounts,
} from "./balance-display";

const testAddress = (byte: number): Address =>
  getAddressDecoder().decode(new Uint8Array(32).fill(byte));

const AUTHORITY = testAddress(2);
const CLASSIC_MINT = testAddress(3);
const SCALED_MINT = testAddress(4);
const INTEREST_MINT = testAddress(5);
const PLAIN_2022_MINT = testAddress(6);
const UNREADABLE_MINT = testAddress(7);
const READ_AT = new Date(Number(TEST_CLOCK.unixTimestamp) * 1000).toISOString();

function holding(mint: string, amount: string, program: HeldTokenBalance["program"]) {
  return { token: mint, mint, amount, decimals: 6, program } satisfies HeldTokenBalance;
}

const scaledExtension: ExtensionArgs = {
  __kind: "ScaledUiAmountConfig",
  authority: AUTHORITY,
  multiplier: 2,
  newMultiplierEffectiveTimestamp: 0n,
  newMultiplier: 2,
};

/** 5% a year for 365 days before the Clock read; the program's year is 365.24 days. */
const interestExtension: ExtensionArgs = {
  __kind: "InterestBearingConfig",
  rateAuthority: AUTHORITY,
  initializationTimestamp: TEST_CLOCK.unixTimestamp - 31_536_000n,
  preUpdateAverageRate: 500,
  lastUpdateTimestamp: TEST_CLOCK.unixTimestamp - 31_536_000n,
  currentRate: 500,
};

/** A balance read with no deadline and no slot floor. */
const NO_READ_BOUNDS = { abortSignal: undefined, minContextSlot: undefined } as const;

describe("balance display", () => {
  const rpc = installClusterRpcResponder();

  const termsReads = () => rpc.requests.filter(({ method }) => method === "getMultipleAccounts");

  beforeEach(() => {
    clearBalanceTermsCacheForTests();
  });

  function inScope<T>(operation: () => Promise<T>): Promise<T> {
    return runInClusterScope({ projectId: null, environment: "sandbox" }, operation);
  }

  function answerMints() {
    answerMovementAccounts(
      rpc,
      new Map([
        [SCALED_MINT, mintRpcAccount("token-2022", { decimals: 6, extensions: [scaledExtension] })],
        [
          INTEREST_MINT,
          mintRpcAccount("token-2022", { decimals: 6, extensions: [interestExtension] }),
        ],
        [PLAIN_2022_MINT, mintRpcAccount("token-2022", { decimals: 6, extensions: null })],
        // Not a mint: the bytes do not decode.
        [UNREADABLE_MINT, encodedRpcAccount(SPL_TOKEN_PROGRAMS["token-2022"], new Uint8Array(90))],
      ])
    );
  }

  it("shows native SOL and classic mints as their token amount, with no read", async () => {
    const displayed = await inScope(() =>
      withDisplayAmount(
        [nativeSolHolding(1_500_000_000n), holding(CLASSIC_MINT, "2500000", "spl-token")],
        NO_READ_BOUNDS
      )
    );

    expect(displayed).toEqual([
      {
        token: "SOL",
        mint: SOL_MINT,
        amount: "1500000000",
        tokenAmount: "1.5",
        displayAmount: "1.5",
        displayAsOf: null,
        displayRule: "plain",
        decimals: 9,
      },
      {
        token: CLASSIC_MINT,
        mint: CLASSIC_MINT,
        amount: "2500000",
        tokenAmount: "2.5",
        displayAmount: "2.5",
        displayAsOf: null,
        displayRule: "plain",
        decimals: 6,
      },
    ]);
    expect(termsReads()).toEqual([]);
  });

  it("reads every wallet's Token-2022 mints once and shows each under its rule", async () => {
    answerMints();

    const displayed = await inScope(() =>
      withDisplayAmounts(
        new Map([
          ["wallet_a", [holding(SCALED_MINT, "1500000", "token-2022")]],
          [
            "wallet_b",
            [
              holding(SCALED_MINT, "250000", "token-2022"),
              holding(INTEREST_MINT, "1000000", "token-2022"),
              holding(PLAIN_2022_MINT, "3000000", "token-2022"),
            ],
          ],
        ]),
        NO_READ_BOUNDS
      )
    );

    expect(displayed.get("wallet_a")).toEqual([
      expect.objectContaining({
        tokenAmount: "1.5",
        displayAmount: "3",
        displayAsOf: READ_AT,
        displayRule: "scaled",
      }),
    ]);
    expect(displayed.get("wallet_b")).toEqual([
      expect.objectContaining({ tokenAmount: "0.25", displayAmount: "0.5", displayRule: "scaled" }),
      // e^(0.05 × 365 ÷ 365.24), in the program's f64 steps.
      expect.objectContaining({
        tokenAmount: "1",
        displayAmount: "1.051237",
        displayAsOf: READ_AT,
        displayRule: "interest",
      }),
      expect.objectContaining({
        tokenAmount: "3",
        displayAmount: "3",
        displayAsOf: null,
        displayRule: "plain",
      }),
    ]);
    // RPC budget: one request for the Clock and every distinct Token-2022 mint.
    expect(termsReads()).toHaveLength(1);
    expect(termsReads()[0]?.params[0]).toEqual([
      SYSVAR_CLOCK_ADDRESS,
      SCALED_MINT,
      INTEREST_MINT,
      PLAIN_2022_MINT,
    ]);
  });

  it("leaves out a holding whose mint terms cannot be read, and keeps the others", async () => {
    answerMints();

    const displayed = await inScope(() =>
      withDisplayAmount(
        [
          holding(UNREADABLE_MINT, "1000000", "token-2022"),
          holding(SCALED_MINT, "1000000", "token-2022"),
        ],
        NO_READ_BOUNDS
      )
    );

    expect(displayed.map(({ mint }) => mint)).toEqual([SCALED_MINT]);
  });

  it("reads the terms at or after the slot the holdings were read at", async () => {
    answerMints();

    await inScope(() =>
      withDisplayAmount([holding(SCALED_MINT, "1000000", "token-2022")], {
        abortSignal: undefined,
        minContextSlot: 4_242n,
      })
    );

    expect(termsReads()).toHaveLength(1);
    expect(termsReads()[0]?.params[1]).toMatchObject({ minContextSlot: 4_242 });
  });

  // RPC budget: the home page reads the wallet list and the aggregate together, over holdings
  // cached for 10 seconds, and each read the same terms again.
  it("shares one terms read between unbounded reads, and reads a bounded one live", async () => {
    answerMints();
    const scaled = [holding(SCALED_MINT, "1000000", "token-2022")];

    await inScope(() =>
      Promise.all([
        withDisplayAmount(scaled, NO_READ_BOUNDS),
        withDisplayAmount(scaled, NO_READ_BOUNDS),
      ])
    );
    await inScope(() => withDisplayAmount(scaled, NO_READ_BOUNDS));
    expect(termsReads()).toHaveLength(1);

    await inScope(() =>
      withDisplayAmount(scaled, { abortSignal: undefined, minContextSlot: 4_242n })
    );
    expect(termsReads()).toHaveLength(2);
  });

  it("fails when the terms read itself fails, and keeps no failure", async () => {
    rpc.respond("getMultipleAccounts", () => ({
      error: { code: -32_005, message: "Node is unhealthy" },
    }));
    const scaled = [holding(SCALED_MINT, "1000000", "token-2022")];

    await expect(inScope(() => withDisplayAmount(scaled, NO_READ_BOUNDS))).rejects.toThrow(
      "Node is unhealthy"
    );

    answerMints();
    await expect(inScope(() => withDisplayAmount(scaled, NO_READ_BOUNDS))).resolves.toEqual([
      expect.objectContaining({ displayAmount: "2", displayRule: "scaled" }),
    ]);
    expect(termsReads()).toHaveLength(2);
  });
});

describe("sumHoldings", () => {
  // Kept apart, native and wrapped SOL were two aggregate entries with one mint, which the
  // dashboard keys and sums by mint.
  it("sums each mint's base units across wallets, native SOL and wrapped SOL as one", () => {
    const wrappedSol = { ...holding(SOL_MINT, "5", "spl-token"), token: "wSOL", decimals: 9 };

    expect(
      sumHoldings([
        [nativeSolHolding(1_000_000_000n), holding(SCALED_MINT, "18446744073709551", "token-2022")],
        [nativeSolHolding(2n), wrappedSol, holding(SCALED_MINT, "1", "token-2022")],
      ])
    ).toEqual([
      { token: "SOL", mint: SOL_MINT, amount: "1000000007", decimals: 9, program: null },
      holding(SCALED_MINT, "18446744073709552", "token-2022"),
    ]);
  });
});
