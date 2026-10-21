import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import { address, getBase64Decoder } from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  type ExtensionArgs,
  extension,
  getMintEncoder,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { beforeEach, describe, expect, it } from "vitest";
import { clearMintFactsForTests, readMintFacts } from "@/services/mint-facts";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import {
  installClusterRpcResponder,
  type JsonRpcResult,
  type StubEncodedAccount,
} from "@/test/helpers/cluster-rpc";
import { tokenAccount, tokenMintAccount } from "@/test/helpers/subscription-accounts";

const MINT = address(TEST_SOLANA_ADDRESSES.mint);
const MINT_AUTHORITY = address(TEST_SOLANA_ADDRESSES.wallet1);
const HOOK_PROGRAM = address(TEST_SOLANA_ADDRESSES.wallet3);
const LEGACY_MINT = tokenMintAccount({ programAddress: TOKEN_PROGRAM_ADDRESS, decimals: 6 });

/**
 * A Token-2022 mint carrying `extensions`, encoded with the program's own layout.
 *
 * @param extensions - The mint's extensions.
 * @returns The account, owned by Token-2022, at 9 decimals.
 */
function token2022Mint(extensions: ExtensionArgs[]): StubEncodedAccount {
  return {
    owner: TOKEN_2022_PROGRAM_ADDRESS,
    data: new Uint8Array(
      getMintEncoder().encode({
        mintAuthority: MINT_AUTHORITY,
        supply: 1_000_000_000n,
        decimals: 9,
        isInitialized: true,
        freezeAuthority: null,
        extensions,
      })
    ),
  };
}

/**
 * A base64 `getAccountInfo` result for `account`.
 *
 * @param account - The account, or null when none is at the address.
 * @returns The JSON-RPC `result`.
 */
function accountInfoResult(account: StubEncodedAccount | null): JsonRpcResult {
  return {
    context: { slot: 1 },
    value:
      account === null
        ? null
        : {
            data: [getBase64Decoder().decode(account.data), "base64"],
            executable: false,
            lamports: 1_461_600,
            owner: account.owner,
            rentEpoch: 0,
            space: account.data.length,
          },
  };
}

describe("readMintFacts", () => {
  const rpc = installClusterRpcResponder();

  beforeEach(() => {
    clearMintFactsForTests();
  });

  function showAccount(account: StubEncodedAccount | null): void {
    rpc.respond("getAccountInfo", () => ({ result: accountInfoResult(account) }));
  }

  function readIn(environment: SdpEnvironment) {
    return runInClusterScope({ projectId: null, environment }, () => readMintFacts(MINT));
  }

  function mintReads() {
    return rpc.requests.filter((request) => request.method === "getAccountInfo");
  }

  it("reads a legacy mint once at confirmed and answers the next call from the cache", async () => {
    showAccount(LEGACY_MINT);

    const facts = await readIn("sandbox");
    const again = await readIn("sandbox");

    expect(facts).toEqual({
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      decimals: 6,
      hasTransferHook: false,
    });
    expect(again).toEqual(facts);
    expect(mintReads()).toEqual([
      {
        cluster: "devnet",
        method: "getAccountInfo",
        params: [MINT, { encoding: "base64", commitment: "confirmed" }],
      },
    ]);
  });

  it("reports a Token-2022 mint's transfer hook and keeps it", async () => {
    showAccount(
      token2022Mint([
        extension("TransferHook", { authority: MINT_AUTHORITY, programId: HOOK_PROGRAM }),
      ])
    );

    const facts = await readIn("sandbox");
    await readIn("sandbox");

    expect(facts).toEqual({
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      decimals: 9,
      hasTransferHook: true,
    });
    expect(mintReads()).toHaveLength(1);
  });

  it("reads a mint that can be closed again on every call", async () => {
    showAccount(
      token2022Mint([extension("MintCloseAuthority", { closeAuthority: MINT_AUTHORITY })])
    );

    const facts = await readIn("sandbox");
    const again = await readIn("sandbox");

    expect([facts, again]).toEqual([
      { tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, decimals: 9, hasTransferHook: false },
      { tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, decimals: 9, hasTransferHook: false },
    ]);
    expect(mintReads()).toHaveLength(2);
  });

  it.each([
    { refused: "no account", account: null },
    {
      refused: "a token account",
      account: tokenAccount({
        programAddress: TOKEN_PROGRAM_ADDRESS,
        mint: MINT,
        owner: MINT_AUTHORITY,
        delegate: null,
      }),
    },
    {
      refused: "an account no token program owns",
      account: { ...LEGACY_MINT, owner: SYSTEM_PROGRAM_ADDRESS },
    },
  ])("refuses $refused at the mint address with a 400 it does not keep", async ({ account }) => {
    showAccount(account);

    await expect(readIn("sandbox")).rejects.toMatchObject({
      code: "BAD_REQUEST",
      statusCode: 400,
    });
    await expect(readIn("sandbox")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mintReads()).toHaveLength(2);
  });

  it("reads the same mint once on each cluster", async () => {
    showAccount(LEGACY_MINT);

    await readIn("sandbox");
    await readIn("production");
    await readIn("sandbox");
    await readIn("production");

    expect(mintReads().map((request) => request.cluster)).toEqual(["devnet", "mainnet-beta"]);
  });
});
