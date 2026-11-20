import { createRpc } from "@sdp/rpc/solana";
import { SOL_MINT, SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { getAddressDecoder } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type JsonRpcResult, parseJsonRpcRequest } from "@/test/helpers/cluster-rpc";
import { required } from "@/test/helpers/required";
import {
  clearWalletBalanceCache,
  readWalletBalances,
  type WalletBalanceTarget,
} from "./wallet-balances";

const SCOPE = "org_test:proj_test";
const USDC_MINT = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;

/** A distinct, valid address per index. */
function ownerAddress(index: number): string {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, index);
  return getAddressDecoder().decode(bytes);
}

function wallet(index: number): WalletBalanceTarget {
  return { id: `cwlt_${index}`, walletId: `provider_${index}`, publicKey: ownerAddress(index) };
}

const RPC_URL = "https://wallet-balances.rpc.test";

/** A read the test answers with `value`, or fails, once it has seen every read start. */
interface HeldRead {
  resolve: (answer: { value: readonly JsonRpcResult[] }) => void;
  reject: (reason: Error) => void;
}

const multipleAccountsParamsSchema = z.tuple([z.array(z.string())], z.unknown());
const tokenAccountsByOwnerParamsSchema = z.tuple(
  [z.string(), z.object({ programId: z.string() })],
  z.unknown()
);

/**
 * A real RPC client over a stubbed endpoint whose answers the test releases, so it can see
 * which reads start before any of them finish.
 */
function heldRpc() {
  const accountReads: Array<{ addresses: string[] } & HeldRead> = [];
  const tokenReads: Array<{ owner: string; programId: string } & HeldRead> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(
      async (_input, init) =>
        new Promise<Response>((settle, fail) => {
          const { id, method, params } = parseJsonRpcRequest(init);
          const held: HeldRead = {
            resolve: ({ value }) =>
              settle(
                Response.json({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value } })
              ),
            reject: fail,
          };
          switch (method) {
            case "getMultipleAccounts": {
              const [addresses] = multipleAccountsParamsSchema.parse(params);
              accountReads.push({ addresses, ...held });
              return;
            }
            case "getTokenAccountsByOwner": {
              const [owner, { programId }] = tokenAccountsByOwnerParamsSchema.parse(params);
              tokenReads.push({ owner, programId, ...held });
              return;
            }
            default:
              fail(new Error(`Unexpected RPC method ${method}`));
          }
        })
    )
  );
  return { rpc: createRpc(RPC_URL), accountReads, tokenReads };
}

/** Answers every token-program read with no token accounts. */
function answerTokenReadsEmpty(tokenReads: ReturnType<typeof heldRpc>["tokenReads"]) {
  for (const read of tokenReads) read.resolve({ value: [] });
}

function usdcAccount(amount: string) {
  return {
    pubkey: ownerAddress(1_000),
    account: {
      data: {
        parsed: {
          info: {
            mint: USDC_MINT,
            tokenAmount: { amount, decimals: 6, uiAmountString: "1.5" },
          },
        },
      },
    },
  };
}

/** Lets every already-settled promise run its handlers. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  clearWalletBalanceCache();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("readWalletBalances", () => {
  it("reads SOL for every missed wallet in one call and both token programs side by side", async () => {
    const { rpc, accountReads, tokenReads } = heldRpc();
    const wallets = [wallet(1), wallet(2), wallet(3)];

    const result = readWalletBalances(rpc, SCOPE, wallets, "req_test");
    await flush();

    expect(accountReads).toHaveLength(1);
    expect(required(accountReads[0]).addresses).toEqual([
      ownerAddress(1),
      ownerAddress(2),
      ownerAddress(3),
    ]);
    // Both programs are asked for every wallet before any answer arrives.
    expect(tokenReads).toHaveLength(6);
    expect(
      tokenReads.filter((read) => read.owner === ownerAddress(1)).map((read) => read.programId)
    ).toEqual([SPL_TOKEN_PROGRAMS["spl-token"], SPL_TOKEN_PROGRAMS["token-2022"]]);

    required(accountReads[0]).resolve({
      value: [{ lamports: 1_500_000_000 }, null, { lamports: 1 }],
    });
    for (const read of tokenReads) {
      const holdsUsdc =
        read.owner === ownerAddress(1) && read.programId === SPL_TOKEN_PROGRAMS["spl-token"];
      read.resolve({ value: holdsUsdc ? [usdcAccount("1500000")] : [] });
    }

    const balances = await result;
    expect(balances.get("cwlt_1")).toEqual([
      { token: "SOL", mint: SOL_MINT, amount: "1500000000", uiAmount: "1.5", decimals: 9 },
      // Unlabeled by the organization; the well-known symbol still applies.
      { token: "USDC", mint: USDC_MINT, amount: "1500000", uiAmount: "1.5", decimals: 6 },
    ]);
    // No account is an unfunded wallet: a real zero, not a failure.
    expect(balances.get("cwlt_2")).toEqual([
      { token: "SOL", mint: SOL_MINT, amount: "0", uiAmount: "0", decimals: 9 },
    ]);
    expect(balances.get("cwlt_3")).toEqual([
      { token: "SOL", mint: SOL_MINT, amount: "1", uiAmount: "0.000000001", decimals: 9 },
    ]);
  });

  it("chunks at the RPC limit, and a failed chunk leaves out only its own wallets", async () => {
    const { rpc, accountReads, tokenReads } = heldRpc();
    const wallets = Array.from({ length: 101 }, (_, index) => wallet(index));

    const result = readWalletBalances(rpc, SCOPE, wallets, "req_test");
    await flush();

    expect(accountReads.map((read) => read.addresses.length)).toEqual([100, 1]);
    required(accountReads[0]).resolve({
      value: Array.from({ length: 100 }, () => ({ lamports: 7 })),
    });
    required(accountReads[1]).reject(new Error("rpc unavailable"));
    answerTokenReadsEmpty(tokenReads);

    const balances = await result;
    expect(balances.size).toBe(100);
    expect(balances.has("cwlt_100")).toBe(false);
  });

  it("shares one read between two callers asking at the same time", async () => {
    const { rpc, accountReads, tokenReads } = heldRpc();

    const first = readWalletBalances(rpc, SCOPE, [wallet(1)], "req_first");
    const second = readWalletBalances(rpc, SCOPE, [wallet(1)], "req_second");
    await flush();

    expect(accountReads).toHaveLength(1);
    expect(tokenReads).toHaveLength(2);
    required(accountReads[0]).resolve({ value: [{ lamports: 5 }] });
    answerTokenReadsEmpty(tokenReads);

    const [firstBalances, secondBalances] = await Promise.all([first, second]);
    expect(secondBalances.get("cwlt_1")).toBe(firstBalances.get("cwlt_1"));
  });

  it("leaves a failed wallet out instead of zero, and reads it again next time", async () => {
    const { rpc, accountReads, tokenReads } = heldRpc();

    const failed = readWalletBalances(rpc, SCOPE, [wallet(1)], "req_failed");
    await flush();
    required(accountReads[0]).reject(new Error("rpc unavailable"));
    answerTokenReadsEmpty(tokenReads);
    expect((await failed).has("cwlt_1")).toBe(false);

    const retried = readWalletBalances(rpc, SCOPE, [wallet(1)], "req_retry");
    await flush();
    // Neither the cache nor the finished read kept the failure.
    expect(accountReads).toHaveLength(2);
    required(accountReads[1]).resolve({ value: [{ lamports: 9 }] });
    answerTokenReadsEmpty(tokenReads.slice(2));

    expect((await retried).get("cwlt_1")).toEqual([
      { token: "SOL", mint: SOL_MINT, amount: "9", uiAmount: "0.000000009", decimals: 9 },
    ]);
  });

  it("leaves out a wallet whose public key is not an address, without reading it", async () => {
    const { rpc, accountReads, tokenReads } = heldRpc();
    const unreadable = { id: "cwlt_bad", walletId: "provider_bad", publicKey: "not-an-address" };

    const result = readWalletBalances(rpc, SCOPE, [unreadable, wallet(1)], "req_test");
    await flush();
    expect(required(accountReads[0]).addresses).toEqual([ownerAddress(1)]);
    required(accountReads[0]).resolve({ value: [{ lamports: 2 }] });
    answerTokenReadsEmpty(tokenReads);

    const balances = await result;
    expect(balances.has("cwlt_bad")).toBe(false);
    expect(balances.get("cwlt_1")).toEqual([
      { token: "SOL", mint: SOL_MINT, amount: "2", uiAmount: "0.000000002", decimals: 9 },
    ]);
  });

  it("leaves a wallet out when only its token read failed", async () => {
    const { rpc, accountReads, tokenReads } = heldRpc();

    const result = readWalletBalances(rpc, SCOPE, [wallet(1)], "req_test");
    await flush();
    required(accountReads[0]).resolve({ value: [{ lamports: 9 }] });
    required(tokenReads[0]).resolve({ value: [] });
    required(tokenReads[1]).reject(new Error("rpc unavailable"));

    expect((await result).has("cwlt_1")).toBe(false);
  });

  it("serves a success from the cache until it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { rpc, accountReads, tokenReads } = heldRpc();

    const first = readWalletBalances(rpc, SCOPE, [wallet(1)], "req_first");
    await flush();
    required(accountReads[0]).resolve({ value: [{ lamports: 3 }] });
    answerTokenReadsEmpty(tokenReads);
    await first;

    await readWalletBalances(rpc, SCOPE, [wallet(1)], "req_cached");
    expect(accountReads).toHaveLength(1);

    vi.advanceTimersByTime(10_000);
    void readWalletBalances(rpc, SCOPE, [wallet(1)], "req_expired");
    await flush();
    expect(accountReads).toHaveLength(2);
  });

  it("does not cache a read that finished after the cache was cleared", async () => {
    const { rpc, accountReads, tokenReads } = heldRpc();

    const stale = readWalletBalances(rpc, SCOPE, [wallet(1)], "req_stale");
    await flush();
    clearWalletBalanceCache();
    required(accountReads[0]).resolve({ value: [{ lamports: 3 }] });
    answerTokenReadsEmpty(tokenReads);
    await stale;

    void readWalletBalances(rpc, SCOPE, [wallet(1)], "req_after_clear");
    await flush();
    expect(accountReads).toHaveLength(2);
  });
});
