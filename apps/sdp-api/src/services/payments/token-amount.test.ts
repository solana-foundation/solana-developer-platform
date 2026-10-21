import { runInClusterScope } from "@sdp/rpc/scope";
import { parseDecimalAmount } from "@sdp/solana/amount";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { address } from "@solana/kit";
import { SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  type ExtensionArgs,
  extension,
  uiAmountToAmountForInterestBearingMintWithoutSimulation,
} from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { installClusterRpcResponder } from "@/test/helpers/cluster-rpc";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import {
  type LegacyStubMint,
  respondMintAccounts,
  type StubMint,
  scaledUiAmountConfig,
} from "@/test/helpers/token-mints";
import {
  assertPaymentAmountFitsMint,
  loadPaymentAmountConverter,
  parseStaticPaymentAmount,
} from "./token-amount";

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

function inSandboxScope<TResult>(operation: () => TResult): TResult {
  return runInClusterScope({ projectId: null, environment: "sandbox" }, operation);
}

describe("loadPaymentAmountConverter", () => {
  const rpc = installClusterRpcResponder();

  function serveMint(mint: StubMint | LegacyStubMint): void {
    respondMintAccounts(rpc, {
      mints: new Map([[MINT, mint]]),
      clockUnixTimestamp: CLOCK_UNIX_TIMESTAMP,
    });
  }

  function accountInfoReads(): string[] {
    return rpc.requests
      .filter((request) => request.method === "getAccountInfo")
      .map((request) => z.string().parse(request.params[0]));
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

      const toBaseUnits = await inSandboxScope(() => loadPaymentAmountConverter(MINT));

      expect(toBaseUnits("12.345678")).toBe(parseDecimalAmount("12.345678", 6));
      expect(accountInfoReads()).toEqual([MINT]);
    }
  );

  it("converts a legacy SPL Token mint by its decimals, without reading the clock", async () => {
    serveMint({ tokenProgram: TOKEN_PROGRAM_ADDRESS, decimals: 9 });

    const toBaseUnits = await inSandboxScope(() => loadPaymentAmountConverter(MINT));

    expect(toBaseUnits("12.345678912")).toBe(parseDecimalAmount("12.345678912", 9));
    expect(accountInfoReads()).toEqual([MINT]);
  });

  it("converts a well-known mint declared on the scope's cluster by its catalogue decimals, reading nothing", async () => {
    const usdc = WELL_KNOWN_TOKENS.USDC.mints.devnet;

    const toBaseUnits = await inSandboxScope(() =>
      loadPaymentAmountConverter(address(usdc.address))
    );

    expect(toBaseUnits("12.345678")).toBe(parseDecimalAmount("12.345678", usdc.decimals));
    expect(rpc.requests).toEqual([]);
  });

  it("reads a well-known mint the scope's cluster does not declare from the chain", async () => {
    const usdsMainnetMint = address(WELL_KNOWN_TOKENS.USDS.mints["mainnet-beta"].address);
    respondMintAccounts(rpc, {
      mints: new Map([[usdsMainnetMint, { tokenProgram: TOKEN_PROGRAM_ADDRESS, decimals: 9 }]]),
      clockUnixTimestamp: CLOCK_UNIX_TIMESTAMP,
    });

    const toBaseUnits = await inSandboxScope(() => loadPaymentAmountConverter(usdsMainnetMint));

    expect(toBaseUnits("1")).toBe(parseDecimalAmount("1", 9));
    expect(accountInfoReads()).toEqual([usdsMainnetMint]);
  });

  it("divides by the current multiplier before the new one takes effect", async () => {
    serveMint({ decimals: 6, extensions: [SCALED_BY_TWO_UNTIL_LATER] });

    const toBaseUnits = await inSandboxScope(() => loadPaymentAmountConverter(MINT));

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

    const toBaseUnits = await inSandboxScope(() => loadPaymentAmountConverter(MINT));

    expect(toBaseUnits("10")).toBe(2_500_000n);
  });

  it("discounts an interest-bearing mint's accrued interest as of the cluster clock", async () => {
    serveMint({ decimals: 6, extensions: [INTEREST_BEARING_CONFIG] });

    const toBaseUnits = await inSandboxScope(() => loadPaymentAmountConverter(MINT));

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
    { label: "plain", extensions: null },
    { label: "scaled UI amount", extensions: [SCALED_BY_TWO_UNTIL_LATER] },
    { label: "interest-bearing", extensions: [INTEREST_BEARING_CONFIG] },
  ])("answers an amount finer than a $label mint's decimals with 400", async ({ extensions }) => {
    serveMint({ decimals: 6, extensions });

    const toBaseUnits = await inSandboxScope(() => loadPaymentAmountConverter(MINT));

    expect(() => toBaseUnits("1.0000001")).toThrow(
      expect.objectContaining({ code: "BAD_REQUEST", statusCode: 400 })
    );
  });

  it("answers 400 for a mint with no account", async () => {
    respondMintAccounts(rpc, { mints: new Map(), clockUnixTimestamp: CLOCK_UNIX_TIMESTAMP });

    await expect(inSandboxScope(() => loadPaymentAmountConverter(MINT))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      statusCode: 400,
      message: "Token mint account does not exist",
    });
  });
});

describe("parseStaticPaymentAmount", () => {
  const rpc = installClusterRpcResponder();

  function serveMint(mint: StubMint): void {
    respondMintAccounts(rpc, {
      mints: new Map([[MINT, mint]]),
      clockUnixTimestamp: CLOCK_UNIX_TIMESTAMP,
    });
  }

  it("converts a plain mint's amount to base units by its decimals", async () => {
    serveMint({ decimals: 9, extensions: null });

    await expect(inSandboxScope(() => parseStaticPaymentAmount("1.5", MINT))).resolves.toBe(
      1_500_000_000n
    );
  });

  it.each([
    { label: "scaled UI amount", extensions: [SCALED_BY_TWO_UNTIL_LATER] },
    { label: "interest-bearing", extensions: [INTEREST_BEARING_CONFIG] },
  ])("refuses a $label mint with 400", async ({ extensions }) => {
    serveMint({ decimals: 6, extensions });

    await expect(inSandboxScope(() => parseStaticPaymentAmount("1", MINT))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      statusCode: 400,
      message: "Recurring payments do not support interest-bearing or scaled UI amount tokens",
    });
  });
});

describe("assertPaymentAmountFitsMint", () => {
  const rpc = installClusterRpcResponder();
  const usdcDevnetMint = address(WELL_KNOWN_TOKENS.USDC.mints.devnet.address);

  it("refuses an amount finer than a well-known mint's catalogue decimals with 400, reading nothing", async () => {
    await expect(
      inSandboxScope(() => assertPaymentAmountFitsMint("1.0000001", usdcDevnetMint))
    ).rejects.toMatchObject({ code: "BAD_REQUEST", statusCode: 400 });
    expect(rpc.requests).toEqual([]);
  });

  it("accepts an amount at the mint's decimals", async () => {
    await expect(
      inSandboxScope(() => assertPaymentAmountFitsMint("1.000001", usdcDevnetMint))
    ).resolves.toBeUndefined();
  });
});
