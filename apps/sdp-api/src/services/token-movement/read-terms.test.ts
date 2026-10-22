import { runInClusterScope } from "@sdp/rpc/scope";
import { resolveAssetRequest, type TokenAsset } from "@sdp/solana/asset-ref";
import { NATIVE_TOKEN_TERMS } from "@sdp/solana/token-terms";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import {
  type Address,
  address,
  getAddressDecoder,
  getBase64Decoder,
  type ReadonlyUint8Array,
  unixTimestamp,
} from "@solana/kit";
import { getSysvarClockEncoder, SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import {
  AccountState,
  type ExtensionArgs,
  findAssociatedTokenPda,
  getMintEncoder,
  getTokenEncoder,
} from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type ClusterRpcRequest, installClusterRpcResponder } from "@/test/helpers/cluster-rpc";
import { readMintMovementAccounts, readTokenTerms } from "./read-terms";

const testAddress = (byte: number): Address =>
  getAddressDecoder().decode(new Uint8Array(32).fill(byte));

const AUTHORITY = testAddress(2);
const UNKNOWN_MINT = testAddress(3);
const SYSVAR_PROGRAM = "Sysvar1111111111111111111111111111111111111";
const CLOCK = { slot: 4_200n, unixTimestamp: unixTimestamp(1_800_000_000n), epoch: 900n };

function catalogueToken(symbol: string): TokenAsset {
  const asset = resolveAssetRequest(symbol, "devnet");
  if (asset.kind !== "token") {
    throw new Error(`${symbol} is not a catalogue token on devnet`);
  }
  return asset;
}

const pyusd = catalogueToken("PYUSD");
const usdc = catalogueToken("USDC");

/** One account in a base64 `getMultipleAccounts` answer. */
function encoded(owner: string, data: ReadonlyUint8Array) {
  return {
    data: [getBase64Decoder().decode(data), "base64"],
    executable: false,
    lamports: 1_461_600,
    owner,
    rentEpoch: 0,
    space: data.length,
  };
}

function mintData(extensions: ExtensionArgs[] | null) {
  return getMintEncoder().encode({
    mintAuthority: AUTHORITY,
    supply: 0n,
    decimals: 6,
    isInitialized: true,
    freezeAuthority: null,
    extensions,
  });
}

const CLOCK_ACCOUNT = encoded(
  SYSVAR_PROGRAM,
  getSysvarClockEncoder().encode({
    slot: CLOCK.slot,
    epochStartTimestamp: unixTimestamp(1_799_000_000n),
    epoch: CLOCK.epoch,
    leaderScheduleEpoch: CLOCK.epoch + 1n,
    unixTimestamp: CLOCK.unixTimestamp,
  })
);

const PYUSD_LIKE_MINT = encoded(
  SPL_TOKEN_PROGRAMS["token-2022"],
  mintData([
    {
      __kind: "TransferFeeConfig",
      transferFeeConfigAuthority: AUTHORITY,
      withdrawWithheldAuthority: AUTHORITY,
      withheldAmount: 0n,
      olderTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
      newerTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
    },
  ])
);

describe("readTokenTerms", () => {
  const rpc = installClusterRpcResponder();

  /** Answer every `getMultipleAccounts` with `accounts`, in request order. */
  function answerAccounts(accounts: readonly (ReturnType<typeof encoded> | null)[]) {
    rpc.respond("getMultipleAccounts", () => ({
      result: { context: { slot: Number(CLOCK.slot) }, value: [...accounts] },
    }));
  }

  const accountReads = (): ClusterRpcRequest[] =>
    rpc.requests.filter((request) => request.method !== "getGenesisHash");

  const read = (asset: Parameters<typeof readTokenTerms>[0]) =>
    runInClusterScope({ projectId: null, environment: "sandbox" }, () => readTokenTerms(asset));

  it("returns static terms for native SOL without any RPC request", async () => {
    await expect(read(resolveAssetRequest("SOL", "devnet"))).resolves.toBe(NATIVE_TOKEN_TERMS);
    expect(rpc.requests).toEqual([]);
  });

  it("reads the mint and the Clock in one getMultipleAccounts request", async () => {
    answerAccounts([PYUSD_LIKE_MINT, CLOCK_ACCOUNT]);

    const terms = await read(pyusd);

    expect(terms.asset).toEqual(pyusd);
    expect(terms.decimals).toBe(6);
    expect(terms.readAt).toEqual(CLOCK);
    expect(terms.transferFee?.newer).toEqual({ epoch: 0n, basisPoints: 0, maximumFee: 0n });
    expect(accountReads()).toEqual([
      {
        cluster: "devnet",
        method: "getMultipleAccounts",
        params: [
          [pyusd.mint, SYSVAR_CLOCK_ADDRESS],
          { encoding: "base64", commitment: "confirmed" },
        ],
      },
    ]);
  });

  it("learns an unread mint's program from the account owner", async () => {
    answerAccounts([encoded(SPL_TOKEN_PROGRAMS["spl-token"], mintData(null)), CLOCK_ACCOUNT]);

    const terms = await read({ kind: "mint", mint: UNKNOWN_MINT });

    expect(terms.asset).toEqual({ kind: "token", mint: UNKNOWN_MINT, program: "spl-token" });
  });

  it("reads again on every call, with no cache", async () => {
    answerAccounts([PYUSD_LIKE_MINT, CLOCK_ACCOUNT]);

    await read(pyusd);
    await read(pyusd);

    expect(accountReads()).toHaveLength(2);
  });

  it("refuses an address with no account", async () => {
    answerAccounts([null, CLOCK_ACCOUNT]);

    await expect(read(usdc)).rejects.toMatchObject({
      statusCode: 400,
      message: "Token mint account does not exist",
    });
  });

  it("refuses an account no supported token program owns", async () => {
    answerAccounts([encoded(SYSVAR_PROGRAM, mintData(null)), CLOCK_ACCOUNT]);

    await expect(read({ kind: "mint", mint: UNKNOWN_MINT })).rejects.toMatchObject({
      statusCode: 400,
      message: "Unsupported token program for mint",
    });
  });

  it("refuses a catalogue mint owned by another token program than declared", async () => {
    answerAccounts([encoded(SPL_TOKEN_PROGRAMS["token-2022"], mintData(null)), CLOCK_ACCOUNT]);

    await expect(read(usdc)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("refuses a token account at a mint address", async () => {
    const tokenAccount = getTokenEncoder().encode({
      mint: UNKNOWN_MINT,
      owner: AUTHORITY,
      amount: 1n,
      delegate: null,
      state: AccountState.Initialized,
      isNative: null,
      delegatedAmount: 0n,
      closeAuthority: null,
      extensions: null,
    });
    answerAccounts([encoded(SPL_TOKEN_PROGRAMS["spl-token"], tokenAccount), CLOCK_ACCOUNT]);

    await expect(read({ kind: "mint", mint: UNKNOWN_MINT })).rejects.toMatchObject({
      statusCode: 400,
      message: "Account is not a token mint",
    });
  });

  it("fails the read, not the request, when the node returns no Clock", async () => {
    answerAccounts([PYUSD_LIKE_MINT, null]);

    const failure = read(pyusd);

    await expect(failure).rejects.toThrow();
    await expect(failure).rejects.not.toMatchObject({ statusCode: 400 });
  });
});

/** A `getMultipleAccounts` request's addresses. */
const addressesParams = z.tuple([z.array(z.string())]).rest(z.unknown());

describe("readMintMovementAccounts", () => {
  const rpc = installClusterRpcResponder();
  const OWNERS = Array.from({ length: 120 }, (_, index) => testAddress(10 + (index % 120)));

  const ata = async (owner: Address, mint: Address, program: keyof typeof SPL_TOKEN_PROGRAMS) =>
    (
      await findAssociatedTokenPda({
        owner,
        mint,
        tokenProgram: address(SPL_TOKEN_PROGRAMS[program]),
      })
    )[0];

  /** Answers each `getMultipleAccounts` by address from `accounts`; absent ones are missing. */
  function answerByAddress(accounts: ReadonlyMap<string, ReturnType<typeof encoded>>) {
    rpc.respond("getMultipleAccounts", (request) => {
      const [addresses] = addressesParams.parse(request.params);
      return {
        result: {
          context: { slot: Number(CLOCK.slot) },
          value: addresses.map((requested) =>
            requested === SYSVAR_CLOCK_ADDRESS ? CLOCK_ACCOUNT : (accounts.get(requested) ?? null)
          ),
        },
      };
    });
  }

  const reads = () => rpc.requests.filter((request) => request.method === "getMultipleAccounts");
  const readSizes = () => reads().map((request) => addressesParams.parse(request.params)[0].length);

  const read = (asset: Parameters<typeof readMintMovementAccounts>[0], owners: Address[]) =>
    runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
      readMintMovementAccounts(asset, owners)
    );

  it("reads a destination's token account in the mint's request, and its memo rule", async () => {
    const owner = OWNERS[0];
    const destination = await ata(owner, pyusd.mint, "token-2022");
    answerByAddress(
      new Map([
        [pyusd.mint, PYUSD_LIKE_MINT],
        [
          destination,
          encoded(
            SPL_TOKEN_PROGRAMS["token-2022"],
            getTokenEncoder().encode({
              mint: pyusd.mint,
              owner,
              amount: 0n,
              delegate: null,
              state: AccountState.Initialized,
              isNative: null,
              delegatedAmount: 0n,
              closeAuthority: null,
              extensions: [
                { __kind: "ImmutableOwner" },
                { __kind: "MemoTransfer", requireIncomingTransferMemos: true },
              ],
            })
          ),
        ],
      ])
    );

    const { terms, destinations } = await read(pyusd, [owner]);

    expect(terms.asset).toEqual(pyusd);
    expect(destinations).toEqual([
      { owner, tokenAccount: destination, exists: true, requiresMemo: true, frozen: false },
    ]);
    expect(reads().map((request) => request.params[0])).toEqual([
      [pyusd.mint, SYSVAR_CLOCK_ADDRESS, destination],
    ]);
  });

  it("reads an uncatalogued mint's destinations under both programs and keeps its program's", async () => {
    const owner = OWNERS[1];
    answerByAddress(
      new Map([[UNKNOWN_MINT, encoded(SPL_TOKEN_PROGRAMS["spl-token"], mintData(null))]])
    );

    const { destinations } = await read({ kind: "mint", mint: UNKNOWN_MINT }, [owner]);

    expect(destinations).toEqual([
      {
        owner,
        tokenAccount: await ata(owner, UNKNOWN_MINT, "spl-token"),
        exists: false,
        requiresMemo: false,
        frozen: false,
      },
    ]);
    expect(readSizes()).toEqual([4]);
  });

  it("reads a large movement's accounts in concurrent pages of 100, each owner once", async () => {
    answerByAddress(
      new Map([[usdc.mint, encoded(SPL_TOKEN_PROGRAMS["spl-token"], mintData(null))]])
    );
    const owners = [...OWNERS, OWNERS[0]];

    const { destinations } = await read(usdc, owners);

    expect(destinations).toHaveLength(owners.length);
    expect(destinations.at(-1)).toEqual(destinations[0]);
    expect(readSizes()).toEqual([100, 22]);
  });
});
