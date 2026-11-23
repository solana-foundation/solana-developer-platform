import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { address, getBase64Decoder, none } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { type ExtensionArgs, extension, getMintEncoder } from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { inSandboxScope, installClusterRpcResponder } from "@/test/helpers/cluster-rpc";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import {
  type LegacyStubMint,
  respondMintAccounts,
  type StubMint,
  scaledUiAmountConfig,
} from "@/test/helpers/token-mints";
import {
  loadPaymentAmountConverter,
  loadPaymentMint,
  loadPaymentMintFacts,
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
    "admits a Token-2022 mint with $label and converts by its decimals in one mint read",
    async ({ extensions }) => {
      serveMint({ decimals: 6, extensions });

      const toBaseUnits = await inSandboxScope(() => loadPaymentAmountConverter(MINT));

      expect(toBaseUnits("12.345678")).toBe(12_345_678n);
      expect(accountInfoReads()).toEqual([MINT]);
    }
  );

  it("converts a legacy SPL Token mint by its decimals in one mint read", async () => {
    serveMint({ tokenProgram: TOKEN_PROGRAM_ADDRESS, decimals: 9 });

    const toBaseUnits = await inSandboxScope(() => loadPaymentAmountConverter(MINT));

    expect(toBaseUnits("12.345678912")).toBe(12_345_678_912n);
    expect(accountInfoReads()).toEqual([MINT]);
  });

  it("converts a well-known mint declared on the scope's cluster by its catalogue decimals, reading nothing", async () => {
    const usdc = WELL_KNOWN_TOKENS.USDC.mints.devnet;

    const toBaseUnits = await inSandboxScope(() =>
      loadPaymentAmountConverter(address(usdc.address))
    );

    expect(toBaseUnits("12.345678")).toBe(12_345_678n);
    expect(rpc.requests).toEqual([]);
  });

  it("reads a well-known mint the scope's cluster does not declare from the chain", async () => {
    const usdsMainnetMint = address(WELL_KNOWN_TOKENS.USDS.mints["mainnet-beta"].address);
    respondMintAccounts(rpc, {
      mints: new Map([[usdsMainnetMint, { tokenProgram: TOKEN_PROGRAM_ADDRESS, decimals: 9 }]]),
      clockUnixTimestamp: CLOCK_UNIX_TIMESTAMP,
    });

    const toBaseUnits = await inSandboxScope(() => loadPaymentAmountConverter(usdsMainnetMint));

    expect(toBaseUnits("1")).toBe(1_000_000_000n);
    expect(accountInfoReads()).toEqual([usdsMainnetMint]);
  });

  it.each([
    { kind: "ScaledUiAmountConfig", extensions: [SCALED_BY_TWO_UNTIL_LATER] },
    { kind: "InterestBearingConfig", extensions: [INTEREST_BEARING_CONFIG] },
    { kind: "NonTransferable", extensions: [extension("NonTransferable", {})] },
  ])("refuses a new payment in a $kind mint with 400", async ({ kind, extensions }) => {
    serveMint({ decimals: 6, extensions });
    await expect(inSandboxScope(() => loadPaymentAmountConverter(MINT))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      statusCode: 400,
      message: `Payments do not support the ${kind} mint extension`,
    });
    expect(accountInfoReads()).toEqual([MINT]);
  });

  it("reads a refused mint's facts for recovery while still refusing a new payment in it", async () => {
    serveMint({ decimals: 6, extensions: [INTEREST_BEARING_CONFIG] });
    await inSandboxScope(async () => {
      expect((await loadPaymentMintFacts(MINT)).toBaseUnits("1.5")).toBe(1_500_000n);
      await expect(loadPaymentMint(MINT)).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Payments do not support the InterestBearingConfig mint extension",
      });
    });
    expect(accountInfoReads()).toEqual([MINT]);
  });

  it("answers 400 for an amount it cannot convert exactly, without rounding", async () => {
    serveMint({ decimals: 6, extensions: null });
    const convert = await inSandboxScope(() => loadPaymentAmountConverter(MINT));
    expect(() => convert("1.0000001")).toThrow(
      expect.objectContaining({
        code: "BAD_REQUEST",
        statusCode: 400,
        message: "Amount has too many decimal places",
      })
    );
  });

  it.each([
    { kind: "wrong owner", message: "Unsupported token program for mint" },
    { kind: "uninitialized", message: "Token mint is not initialized" },
    { kind: "malformed", message: "Token mint account data is invalid" },
  ])("rejects a $kind mint account", async ({ kind, message }) => {
    const data =
      kind === "malformed"
        ? new Uint8Array(3)
        : getMintEncoder().encode({
            mintAuthority: none(),
            supply: 0n,
            decimals: 6,
            isInitialized: kind !== "uninitialized",
            freezeAuthority: none(),
            extensions: none(),
          });
    rpc.answer("getAccountInfo", {
      context: { slot: 1 },
      value: {
        data: [getBase64Decoder().decode(data), "base64"],
        executable: false,
        lamports: 1,
        owner: kind === "wrong owner" ? syntheticAddress(99) : TOKEN_PROGRAM_ADDRESS,
        rentEpoch: 0,
        space: data.length,
      },
    });
    await expect(inSandboxScope(() => loadPaymentAmountConverter(MINT))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      statusCode: 400,
      message,
    });
  });

  it("shares the mint read between concurrent admission and execution in one scope", async () => {
    serveMint({ decimals: 6, extensions: null });
    await inSandboxScope(async () => {
      const [parsed, mint] = await Promise.all([
        parseStaticPaymentAmount("1.5", MINT),
        loadPaymentMint(MINT),
      ]);
      expect(parsed).toBe(1500000n);
      expect(mint.toBaseUnits("1.5")).toBe(1500000n);
    });
    expect(accountInfoReads()).toEqual([MINT]);
  });

  it("does not remember failed lookups or reuse facts across scopes", async () => {
    respondMintAccounts(rpc, { mints: new Map(), clockUnixTimestamp: CLOCK_UNIX_TIMESTAMP });
    await inSandboxScope(async () => {
      await expect(loadPaymentMint(MINT)).rejects.toMatchObject({ statusCode: 400 });
      serveMint({ decimals: 6, extensions: null });
      expect((await loadPaymentMint(MINT)).decimals).toBe(6);
    });
    serveMint({ decimals: 9, extensions: null });
    expect((await inSandboxScope(() => loadPaymentMint(MINT))).decimals).toBe(9);
    expect(accountInfoReads()).toEqual([MINT, MINT, MINT]);
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
