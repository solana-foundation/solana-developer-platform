import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import {
  type Address,
  createSolanaRpcFromTransport,
  getAddressDecoder,
  getBase64Decoder,
  type ReadonlyUint8Array,
  type RpcTransport,
  unixTimestamp,
} from "@solana/kit";
import { getSysvarClockEncoder, SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import { type ExtensionArgs, getMintEncoder } from "@solana-program/token-2022";
import {
  MOSAIC_AMOUNT_REFUSALS,
  MosaicAmountError,
  mosaicAmountUnderLiveTerms,
  mosaicDecimalAmount,
} from "./mosaic-amount";
import { fetchTokenTerms } from "./read-token-terms";
import { parseTokenAmount } from "./token-amount";
import { TOKEN_TERMS_REFUSALS, TokenTermsError } from "./token-terms";

const testAddress = (byte: number): Address =>
  getAddressDecoder().decode(new Uint8Array(32).fill(byte));

const MINT = testAddress(1);
const AUTHORITY = testAddress(2);

function rpcAccount(owner: string, data: ReadonlyUint8Array) {
  return {
    data: [getBase64Decoder().decode(data), "base64"],
    executable: false,
    lamports: 1,
    owner,
    rentEpoch: 0,
    space: data.length,
  };
}

const CLOCK = rpcAccount(
  "Sysvar1111111111111111111111111111111111111",
  getSysvarClockEncoder().encode({
    slot: 900n,
    epochStartTimestamp: unixTimestamp(1_799_990_000n),
    epoch: 700n,
    leaderScheduleEpoch: 701n,
    unixTimestamp: unixTimestamp(1_800_000_000n),
  })
);

/** An RPC whose `getMultipleAccounts` answers the mint (or nothing) and the Clock; it counts reads. */
function stubChain(mint: { decimals: number; extensions: ExtensionArgs[] } | null) {
  const reads: string[][] = [];
  const transport: RpcTransport = async <TResponse>({ payload }: Parameters<RpcTransport>[0]) => {
    // SAFETY: kit sends a JSON-RPC request; getMultipleAccounts names its addresses first.
    const request = payload as { id: string; method: string; params: [string[], unknown] };
    assert.equal(request.method, "getMultipleAccounts");
    const [addresses] = request.params;
    reads.push(addresses);
    const value = addresses.map((at) => {
      if (at === SYSVAR_CLOCK_ADDRESS) return CLOCK;
      if (at !== MINT || mint === null) return null;
      return rpcAccount(
        SPL_TOKEN_PROGRAMS["token-2022"],
        getMintEncoder().encode({
          mintAuthority: AUTHORITY,
          supply: 1_000_000n,
          decimals: mint.decimals,
          isInitialized: true,
          freezeAuthority: AUTHORITY,
          extensions: mint.extensions,
        })
      );
    });
    // SAFETY: the transport returns the JSON-RPC response body kit asked for.
    return { jsonrpc: "2.0", id: request.id, result: { context: { slot: 1 }, value } } as TResponse;
  };
  return { rpc: createSolanaRpcFromTransport(transport), reads };
}

function refusal(reason: string) {
  return (cause: unknown) => cause instanceof MosaicAmountError && cause.reason === reason;
}

describe("mosaicDecimalAmount", () => {
  it("hands Mosaic the number its own conversion turns back into the exact base units", () => {
    for (const [value, decimals] of [
      ["1.5", 6],
      ["5.000001", 6],
      ["100", 0],
      ["123456789.123456", 6],
    ] as const) {
      assert.equal(mosaicDecimalAmount(parseTokenAmount(value, decimals)), Number(value));
    }
  });

  it("refuses an amount no number moves exactly, where Mosaic would move another", () => {
    for (const [value, decimals] of [
      // The nearest number prints as 9007199254.740992: one base unit more.
      ["9007199254.740991", 6],
      // JS prints 1e-7, which Mosaic's conversion cannot read.
      ["0.0000001", 9],
      // Mosaic converts at most 9 decimals.
      ["1", 12],
    ] as const) {
      assert.throws(
        () => mosaicDecimalAmount(parseTokenAmount(value, decimals)),
        refusal(MOSAIC_AMOUNT_REFUSALS.inexact),
        `${value} at ${decimals}`
      );
    }
  });
});

describe("mosaicAmountUnderLiveTerms", () => {
  it("reads the mint and the Clock in one request and returns the number", async () => {
    const { rpc, reads } = stubChain({ decimals: 6, extensions: [] });
    assert.equal(
      await mosaicAmountUnderLiveTerms(rpc, MINT, parseTokenAmount("2.5", 6), "issuance"),
      2.5
    );
    assert.deepEqual(reads, [[MINT, SYSVAR_CLOCK_ADDRESS]]);
  });

  it("refuses a paused mint, a hook a seize cannot pass, and a stale scale", async () => {
    const paused = stubChain({
      decimals: 6,
      extensions: [{ __kind: "PausableConfig", authority: AUTHORITY, paused: true }],
    });
    await assert.rejects(
      mosaicAmountUnderLiveTerms(paused.rpc, MINT, parseTokenAmount("1", 6), "issuance"),
      (cause: unknown) =>
        cause instanceof MosaicAmountError &&
        cause.reason === MOSAIC_AMOUNT_REFUSALS.unsupported &&
        cause.movementRefusal === "paused"
    );

    const hooked = stubChain({
      decimals: 6,
      extensions: [{ __kind: "TransferHook", authority: AUTHORITY, programId: testAddress(3) }],
    });
    assert.equal(
      await mosaicAmountUnderLiveTerms(hooked.rpc, MINT, parseTokenAmount("1", 6), "issuance"),
      1
    );
    await assert.rejects(
      mosaicAmountUnderLiveTerms(hooked.rpc, MINT, parseTokenAmount("1", 6), "issuance_seize"),
      (cause: unknown) =>
        cause instanceof MosaicAmountError && cause.movementRefusal === "transfer_hook"
    );

    const rescaled = stubChain({ decimals: 9, extensions: [] });
    await assert.rejects(
      mosaicAmountUnderLiveTerms(rescaled.rpc, MINT, parseTokenAmount("1", 6), "issuance"),
      refusal(MOSAIC_AMOUNT_REFUSALS.scaleMismatch)
    );
  });
});

describe("fetchTokenTerms", () => {
  it("refuses an address with no account", async () => {
    const { rpc } = stubChain(null);
    await assert.rejects(
      fetchTokenTerms(rpc, { kind: "mint", mint: MINT }),
      (cause: unknown) =>
        cause instanceof TokenTermsError && cause.reason === TOKEN_TERMS_REFUSALS.notMint
    );
  });
});
