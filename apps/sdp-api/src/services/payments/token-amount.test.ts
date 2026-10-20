import { createClusterRpc } from "@sdp/rpc/factory";
import { runInClusterScope } from "@sdp/rpc/scope";
import type { SolanaRpc } from "@sdp/rpc/solana";
import { AmountError, parseDecimalAmount } from "@sdp/solana/amount";
import { SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import {
  type ExtensionArgs,
  extension,
  uiAmountToAmountForInterestBearingMintWithoutSimulation,
} from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { installClusterRpcResponder } from "@/test/helpers/cluster-rpc";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import {
  respondMintAccounts,
  type StubMint,
  scaledUiAmountConfig,
} from "@/test/helpers/token-mints";
import { loadPaymentAmountConverter, readStaticAmountMintDecimals } from "./token-amount";

const MINT = syntheticAddress(1);
const CLOCK_UNIX_TIMESTAMP = 1_750_000_000n;
const ONE_YEAR_SECONDS = 31_536_000n;
const INTEREST_INITIALIZED_AT = CLOCK_UNIX_TIMESTAMP - 2n * ONE_YEAR_SECONDS;
const INTEREST_RATE_UPDATED_AT = CLOCK_UNIX_TIMESTAMP - ONE_YEAR_SECONDS;
const PRE_UPDATE_AVERAGE_RATE_BPS = 300;
const CURRENT_RATE_BPS = 500;

const INTEREST_BEARING_CONFIG: ExtensionArgs = extension("InterestBearingConfig", {
  rateAuthority: syntheticAddress(2),
  initializationTimestamp: INTEREST_INITIALIZED_AT,
  preUpdateAverageRate: PRE_UPDATE_AVERAGE_RATE_BPS,
  lastUpdateTimestamp: INTEREST_RATE_UPDATED_AT,
  currentRate: CURRENT_RATE_BPS,
});

const SCALED_BY_TWO_UNTIL_LATER: ExtensionArgs = scaledUiAmountConfig({
  multiplier: 2,
  newMultiplier: 4,
  newMultiplierEffectiveTimestamp: CLOCK_UNIX_TIMESTAMP + ONE_YEAR_SECONDS,
});

function sandboxRpc(): SolanaRpc {
  return runInClusterScope({ projectId: null, environment: "sandbox" }, () => createClusterRpc());
}

describe("loadPaymentAmountConverter", () => {
  const rpc = installClusterRpcResponder();

  function serveMint(mint: StubMint): void {
    respondMintAccounts(rpc, {
      mints: new Map([[MINT, mint]]),
      clockUnixTimestamp: CLOCK_UNIX_TIMESTAMP,
    });
  }

  function accountInfoReads(): unknown[] {
    return rpc.requests
      .filter((request) => request.method === "getAccountInfo")
      .map((request) => request.params[0]);
  }

  it.each([
    { label: "no extensions", extensions: null },
    {
      label: "only extensions that leave UI amounts alone",
      extensions: [extension("PermanentDelegate", { delegate: syntheticAddress(3) })],
    },
  ])(
    "converts a Token-2022 mint with $label by its decimals, without reading the clock",
    async ({ extensions }) => {
      serveMint({ decimals: 6, extensions });

      const toBaseUnits = await loadPaymentAmountConverter(sandboxRpc(), MINT);

      expect(toBaseUnits("12.345678")).toBe(parseDecimalAmount("12.345678", 6));
      expect(accountInfoReads()).toEqual([MINT]);
    }
  );

  it("divides by the current multiplier before the new one takes effect", async () => {
    serveMint({ decimals: 6, extensions: [SCALED_BY_TWO_UNTIL_LATER] });

    const toBaseUnits = await loadPaymentAmountConverter(sandboxRpc(), MINT);

    expect(toBaseUnits("10")).toBe(5_000_000n);
    expect(accountInfoReads()).toEqual([MINT, SYSVAR_CLOCK_ADDRESS]);
  });

  it("divides by the new multiplier from its effective timestamp on", async () => {
    serveMint({
      decimals: 6,
      extensions: [
        scaledUiAmountConfig({
          multiplier: 2,
          newMultiplier: 4,
          newMultiplierEffectiveTimestamp: CLOCK_UNIX_TIMESTAMP,
        }),
      ],
    });

    const toBaseUnits = await loadPaymentAmountConverter(sandboxRpc(), MINT);

    expect(toBaseUnits("10")).toBe(2_500_000n);
  });

  it("discounts an interest-bearing mint's accrued interest as of the cluster clock", async () => {
    serveMint({ decimals: 6, extensions: [INTEREST_BEARING_CONFIG] });

    const toBaseUnits = await loadPaymentAmountConverter(sandboxRpc(), MINT);

    const baseUnits = toBaseUnits("100");
    expect(baseUnits).toBeLessThan(parseDecimalAmount("100", 6));
    expect(baseUnits).toBe(
      uiAmountToAmountForInterestBearingMintWithoutSimulation(
        "100",
        6,
        Number(CLOCK_UNIX_TIMESTAMP),
        Number(INTEREST_RATE_UPDATED_AT),
        Number(INTEREST_INITIALIZED_AT),
        PRE_UPDATE_AVERAGE_RATE_BPS,
        CURRENT_RATE_BPS
      )
    );
  });

  it.each([
    { label: "scaled UI amount", extensions: [SCALED_BY_TWO_UNTIL_LATER] },
    { label: "interest-bearing", extensions: [INTEREST_BEARING_CONFIG] },
  ])(
    "refuses a $label amount finer than the mint's decimals as a plain mint does",
    async ({ extensions }) => {
      serveMint({ decimals: 6, extensions });

      const toBaseUnits = await loadPaymentAmountConverter(sandboxRpc(), MINT);

      expect(() => toBaseUnits("1.0000001")).toThrow(
        new AmountError("Amount has too many decimal places")
      );
    }
  );

  it("answers 400 for a mint with no account", async () => {
    respondMintAccounts(rpc, { mints: new Map(), clockUnixTimestamp: CLOCK_UNIX_TIMESTAMP });

    await expect(loadPaymentAmountConverter(sandboxRpc(), MINT)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      statusCode: 400,
      message: "Token mint account does not exist",
    });
  });
});

describe("readStaticAmountMintDecimals", () => {
  const rpc = installClusterRpcResponder();

  function serveMint(mint: StubMint): void {
    respondMintAccounts(rpc, {
      mints: new Map([[MINT, mint]]),
      clockUnixTimestamp: CLOCK_UNIX_TIMESTAMP,
    });
  }

  it("returns a plain mint's decimals", async () => {
    serveMint({ decimals: 9, extensions: null });

    await expect(readStaticAmountMintDecimals(sandboxRpc(), MINT)).resolves.toBe(9);
  });

  it.each([
    { label: "scaled UI amount", extensions: [SCALED_BY_TWO_UNTIL_LATER] },
    { label: "interest-bearing", extensions: [INTEREST_BEARING_CONFIG] },
  ])("refuses a $label mint with 400", async ({ extensions }) => {
    serveMint({ decimals: 6, extensions });

    await expect(readStaticAmountMintDecimals(sandboxRpc(), MINT)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      statusCode: 400,
      message: "Recurring payments do not support interest-bearing or scaled UI amount tokens",
    });
  });
});
