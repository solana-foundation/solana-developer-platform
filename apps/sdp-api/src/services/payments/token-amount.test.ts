import { runInClusterScope } from "@sdp/rpc/scope";
import { parseDecimalAmount } from "@sdp/solana/amount";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { address, getBase64Decoder, none } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { type ExtensionArgs, extension, getMintEncoder } from "@solana-program/token-2022";
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

  it.each([
    { label: "scaled UI amount", extensions: [SCALED_BY_TWO_UNTIL_LATER] },
    { label: "interest-bearing", extensions: [INTEREST_BEARING_CONFIG] },
    { label: "non-transferable", extensions: [extension("NonTransferable", {})] },
  ])(
    "rejects a $label mint before reading the clock or converting amounts",
    async ({ extensions }) => {
      serveMint({ decimals: 6, extensions });
      await expect(inSandboxScope(() => loadPaymentAmountConverter(MINT))).rejects.toMatchObject({
        code: "BAD_REQUEST",
        statusCode: 400,
      });
      expect(accountInfoReads()).toEqual([MINT]);
    }
  );

  it("keeps raw amounts above 2^53 exact and accepts the full u64 range", async () => {
    serveMint({ decimals: 6, extensions: null });
    const convert = await inSandboxScope(() => loadPaymentAmountConverter(MINT));
    expect(convert("9007199254.740993")).toBe(9007199254740993n);
    expect(convert("18446744073709.551615")).toBe(18446744073709551615n);
  });

  it.each(["1.0000001", "18446744073709.551616"])(
    "rejects %s with 400 instead of rounding or overflowing",
    async (amount) => {
      serveMint({ decimals: 6, extensions: null });
      const convert = await inSandboxScope(() => loadPaymentAmountConverter(MINT));
      expect(() => convert(amount)).toThrow(
        expect.objectContaining({ code: "BAD_REQUEST", statusCode: 400 })
      );
    }
  );

  it.each(["wrong owner", "uninitialized", "malformed"])(
    "rejects a %s mint account",
    async (kind) => {
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
      });
    }
  );

  it("answers 400 for a mint with no account", async () => {
    respondMintAccounts(rpc, { mints: new Map(), clockUnixTimestamp: CLOCK_UNIX_TIMESTAMP });

    await expect(inSandboxScope(() => loadPaymentAmountConverter(MINT))).rejects.toMatchObject({
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

    await expect(inSandboxScope(() => readStaticAmountMintDecimals(MINT))).resolves.toBe(9);
  });

  it.each([
    { label: "scaled UI amount", extensions: [SCALED_BY_TWO_UNTIL_LATER] },
    { label: "interest-bearing", extensions: [INTEREST_BEARING_CONFIG] },
  ])("refuses a $label mint with 400", async ({ extensions }) => {
    serveMint({ decimals: 6, extensions });

    await expect(inSandboxScope(() => readStaticAmountMintDecimals(MINT))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      statusCode: 400,
    });
  });
});
