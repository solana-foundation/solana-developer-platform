import { createServer, type Server } from "node:http";
import { createRpc, type SolanaRpc } from "@sdp/rpc/solana";
import { type CustodyWalletTokenBalance, SPL_TOKEN_PROGRAMS } from "@sdp/types";
import { address, getAddressDecoder } from "@solana/kit";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SOL_MINT } from "@/routes/payments/token-accounts";
import {
  clearWalletBalanceCache,
  readWalletBalances,
  type WalletBalanceTarget,
} from "./wallet-balances";

const SCOPE = "org_test:proj_test";
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** A distinct, valid address per index. */
function ownerAddress(index: number): string {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, index);
  return getAddressDecoder().decode(bytes);
}

function wallet(index: number): WalletBalanceTarget {
  return { id: `cwlt_${index}`, walletId: `provider_${index}`, publicKey: ownerAddress(index) };
}

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * An RPC whose answers the test releases, so it can see which reads start before
 * any of them finish.
 */
function heldRpc() {
  const balanceReads: Array<{ address: string } & Pending<{ value: bigint }>> = [];
  const tokenReads: Array<{ owner: string; programId: string } & Pending<{ value: unknown[] }>> =
    [];
  const rpc = {
    getBalance: (asked: string) => ({
      send: () =>
        new Promise((resolve, reject) => balanceReads.push({ address: asked, resolve, reject })),
    }),
    getTokenAccountsByOwner: (owner: string, { programId }: { programId: string }) => ({
      send: () =>
        new Promise((resolve, reject) => tokenReads.push({ owner, programId, resolve, reject })),
    }),
  } as unknown as SolanaRpc;
  return { rpc, balanceReads, tokenReads };
}

/** Answers every token-program read with no token accounts. */
function answerTokenReadsEmpty(tokenReads: ReturnType<typeof heldRpc>["tokenReads"]) {
  for (const read of tokenReads) read.resolve({ value: [] });
}

function usdcAccount(amount: string) {
  return {
    pubkey: "TokenAccount111",
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
});

describe("readWalletBalances", () => {
  it("reads SOL for every missed wallet from its own address-bound call, both token programs side by side", async () => {
    const { rpc, balanceReads, tokenReads } = heldRpc();
    const wallets = [wallet(1), wallet(2), wallet(3)];

    const result = readWalletBalances(rpc, SCOPE, wallets, "req_test");
    await flush();

    expect(new Set(balanceReads.map((read) => read.address))).toEqual(
      new Set([ownerAddress(1), ownerAddress(2), ownerAddress(3)])
    );
    // Both programs are asked for every wallet before any answer arrives.
    expect(tokenReads).toHaveLength(6);
    expect(
      tokenReads.filter((read) => read.owner === ownerAddress(1)).map((read) => read.programId)
    ).toEqual([SPL_TOKEN_PROGRAMS["spl-token"], SPL_TOKEN_PROGRAMS["token-2022"]]);

    for (const read of balanceReads) {
      read.resolve({
        value:
          read.address === ownerAddress(1)
            ? 1_500_000_000n
            : read.address === ownerAddress(3)
              ? 1n
              : 0n,
      });
    }
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
    expect(balances.get("cwlt_2")?.[0]).toMatchObject({ amount: "0" });
    expect(balances.get("cwlt_3")?.[0]).toMatchObject({ amount: "1" });
  });

  it("reads every wallet independently, so a failed read leaves out only its own wallet", async () => {
    const { rpc, balanceReads, tokenReads } = heldRpc();
    const wallets = Array.from({ length: 101 }, (_, index) => wallet(index));

    const result = readWalletBalances(rpc, SCOPE, wallets, "req_test");
    await flush();

    expect(balanceReads).toHaveLength(101);
    for (const read of balanceReads) {
      if (read.address === ownerAddress(57)) {
        read.reject(new Error("rpc unavailable"));
      } else {
        read.resolve({ value: 7n });
      }
    }
    answerTokenReadsEmpty(tokenReads);

    const balances = await result;
    expect(balances.size).toBe(100);
    expect(balances.has("cwlt_57")).toBe(false);
  });

  it("shares one read between two callers asking at the same time", async () => {
    const { rpc, balanceReads, tokenReads } = heldRpc();

    const first = readWalletBalances(rpc, SCOPE, [wallet(1)], "req_first");
    const second = readWalletBalances(rpc, SCOPE, [wallet(1)], "req_second");
    await flush();

    expect(balanceReads).toHaveLength(1);
    expect(tokenReads).toHaveLength(2);
    balanceReads[0]?.resolve({ value: 5n });
    answerTokenReadsEmpty(tokenReads);

    const [firstBalances, secondBalances] = await Promise.all([first, second]);
    expect(secondBalances.get("cwlt_1")).toBe(firstBalances.get("cwlt_1"));
  });

  it("leaves a failed wallet out instead of zero, and reads it again next time", async () => {
    const { rpc, balanceReads, tokenReads } = heldRpc();

    const failed = readWalletBalances(rpc, SCOPE, [wallet(1)], "req_failed");
    await flush();
    balanceReads[0]?.reject(new Error("rpc unavailable"));
    answerTokenReadsEmpty(tokenReads);
    expect((await failed).has("cwlt_1")).toBe(false);

    const retried = readWalletBalances(rpc, SCOPE, [wallet(1)], "req_retry");
    await flush();
    // Neither the cache nor the finished read kept the failure.
    expect(balanceReads).toHaveLength(2);
    balanceReads[1]?.resolve({ value: 9n });
    answerTokenReadsEmpty(tokenReads.slice(2));

    expect((await retried).get("cwlt_1")?.[0]).toMatchObject({ amount: "9" });
  });

  it("leaves out a wallet whose public key is not an address, without reading it", async () => {
    const { rpc, balanceReads, tokenReads } = heldRpc();
    const unreadable = { id: "cwlt_bad", walletId: "provider_bad", publicKey: "not-an-address" };

    const result = readWalletBalances(rpc, SCOPE, [unreadable, wallet(1)], "req_test");
    await flush();
    expect(balanceReads.map((read) => read.address)).toEqual([ownerAddress(1)]);
    balanceReads[0]?.resolve({ value: 2n });
    answerTokenReadsEmpty(tokenReads);

    const balances = await result;
    expect(balances.has("cwlt_bad")).toBe(false);
    expect(balances.get("cwlt_1")?.[0]).toMatchObject({ amount: "2" });
  });

  it("leaves a wallet out when only its token read failed", async () => {
    const { rpc, balanceReads, tokenReads } = heldRpc();

    const result = readWalletBalances(rpc, SCOPE, [wallet(1)], "req_test");
    await flush();
    balanceReads[0]?.resolve({ value: 9n });
    tokenReads[0]?.resolve({ value: [] });
    tokenReads[1]?.reject(new Error("rpc unavailable"));

    expect((await result).has("cwlt_1")).toBe(false);
  });

  it("serves a success from the cache until it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { rpc, balanceReads, tokenReads } = heldRpc();

    const first = readWalletBalances(rpc, SCOPE, [wallet(1)], "req_first");
    await flush();
    balanceReads[0]?.resolve({ value: 3n });
    answerTokenReadsEmpty(tokenReads);
    await first;

    await readWalletBalances(rpc, SCOPE, [wallet(1)], "req_cached");
    expect(balanceReads).toHaveLength(1);

    vi.advanceTimersByTime(10_000);
    void readWalletBalances(rpc, SCOPE, [wallet(1)], "req_expired");
    await flush();
    expect(balanceReads).toHaveLength(2);
  });

  it("does not cache a read that finished after the cache was cleared", async () => {
    const { rpc, balanceReads, tokenReads } = heldRpc();

    const stale = readWalletBalances(rpc, SCOPE, [wallet(1)], "req_stale");
    await flush();
    clearWalletBalanceCache();
    balanceReads[0]?.resolve({ value: 3n });
    answerTokenReadsEmpty(tokenReads);
    await stale;

    void readWalletBalances(rpc, SCOPE, [wallet(1)], "req_after_clear");
    await flush();
    expect(balanceReads).toHaveLength(2);
  });
});

/**
 * Regression (APE-780 / SOLA9-491) against the real Solana HTTP client: a
 * same-length `getMultipleAccounts` response whose entries are permuted must
 * never be attributed to the requested wallets. The flow reads one address per
 * call, so each answer is bound to the only address it could have been asked
 * about and no positional batch is issued at all.
 */
describe("wallet balance attribution", () => {
  const WALLET_A = address("11111111111111111111111111111111");
  const WALLET_B = address("So11111111111111111111111111111111111111112");
  const TRUE_LAMPORTS: Record<string, number> = {
    [WALLET_A]: 1_000_000_000,
    [WALLET_B]: 2_000_000_000,
  };

  let server: Server;
  let rpcUrl: string;
  let getBalanceCalls: string[];
  let multipleAccountsCalls: number;

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const rpcRequest = JSON.parse(body) as {
        id: number;
        method: string;
        params: unknown[];
      };

      let result: unknown;
      if (rpcRequest.method === "getBalance") {
        // One address per call: the answer affects only the wallet asked about.
        const [asked] = rpcRequest.params as [string];
        getBalanceCalls.push(asked);
        result = { context: { slot: 1 }, value: TRUE_LAMPORTS[asked] };
      } else if (rpcRequest.method === "getTokenAccountsByOwner") {
        result = { context: { slot: 1 }, value: [] };
      } else if (rpcRequest.method === "getMultipleAccounts") {
        // The reported attack payload: a same-length answer whose entries are
        // permuted relative to the request.
        multipleAccountsCalls += 1;
        const [asked] = rpcRequest.params as [string[]];
        result = {
          context: { slot: 1 },
          value: [...asked].reverse().map((entryAddress) => ({
            lamports: TRUE_LAMPORTS[entryAddress],
            owner: "11111111111111111111111111111111",
            executable: false,
            rentEpoch: 0,
            data: ["", "base64"],
          })),
        };
      } else {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: `unexpected method ${rpcRequest.method}` }));
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: rpcRequest.id, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const bound = server.address();
    if (!bound || typeof bound === "string") throw new Error("RPC test server did not bind");
    rpcUrl = `http://127.0.0.1:${bound.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  beforeEach(() => {
    getBalanceCalls = [];
    multipleAccountsCalls = 0;
  });

  it("keeps each wallet's SOL bound to its own address instead of a positional batch", async () => {
    const rpc = createRpc({ SOLANA_RPC_URL: rpcUrl }, { requestTimeoutMs: 2_000 });
    const wallets = [
      { id: "wallet-a", walletId: "provider-a", publicKey: WALLET_A },
      { id: "wallet-b", walletId: "provider-b", publicKey: WALLET_B },
    ];

    const first = await readWalletBalances(rpc, "org:project", wallets, "req_attribution");
    const second = await readWalletBalances(rpc, "org:project", wallets, "req_attribution_cached");

    const solAmount = (balances: Map<string, CustodyWalletTokenBalance[]>, id: string) =>
      balances.get(id)?.find((balance) => balance.token === "SOL")?.amount;
    // Each wallet is answered with its own balance, never its neighbor's.
    expect(solAmount(first, "wallet-a")).toBe("1000000000");
    expect(solAmount(first, "wallet-b")).toBe("2000000000");
    // The cached answer keeps the same binding.
    expect(solAmount(second, "wallet-a")).toBe("1000000000");
    expect(solAmount(second, "wallet-b")).toBe("2000000000");
    // No positional batch was issued, so a permuted answer cannot enter the
    // cache under any wallet's key.
    expect(multipleAccountsCalls).toBe(0);
    expect(new Set(getBalanceCalls)).toEqual(new Set([WALLET_A, WALLET_B]));
  });
});
