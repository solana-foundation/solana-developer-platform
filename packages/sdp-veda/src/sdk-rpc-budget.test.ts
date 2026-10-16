import { createHash } from "node:crypto";
import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VedaVaultDirectClient, type VedaVaultOperationRunner } from "./client";
import recorded from "./fixtures/devnet-position-read.json";
import { resetVedaReadCaches } from "./sdk";

/**
 * The RPC budget of a position read, pinned through the real
 * `@vedatech/svm-sdk`, this package's real transports and the registry's devnet
 * deployment, over Veda Test Vault accounts recorded from devnet
 * (`fixtures/devnet-position-read.json`). The values are the ones the
 * pre-cache read returned from the same bytes.
 *
 * Every request waits for one shared round that settles on the next macrotask,
 * so requests the code has in flight together always overlap, as they do on a
 * real network, and the round count is the sequential round-trip depth. Each
 * phase answers at one recorded slot; a live read that straddles a slot
 * boundary sends one more `getBlockTime` (devnet measured 6 warm for one
 * holder).
 */

const VAULT_PROGRAM = "ASN8Cz36kQSZf2ZrgUbRShaKUpN4CJoTGdv6C5uMsy3J";
const HOOK_PROGRAM = "BmTjMtZGcvx5XB7LwRaGq3x9hdHG1SziYikjP9BAgoE2";
const QUEUE_PROGRAM = "fh8uapqMe4GWhep9rt9qZ56Pxi9SYszkuDKXckYMQTT";
const VAULT = "3wbKP5UGLT7gAZBAsLjvPC1NbfnWKtT3Dq7cniMWkzfU";
const SHARE_MINT = "CdV7pjj6WANsdasKsBvdKAn7qJL7cQ2Q3CJMBEe13WAV";
const ASSET_DATA = "7wrwtBbfta8Sf95VqeVTii2dp6mBttdhRf1xY1ba1Ady";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const HOLDER_A = "FZM6FehZn9uq9vnJWkL1TBz1wqibJL7ESYRFaViCs1dy";
const HOLDER_B = "8fita6dq8PGtMNtHkDeans1hhg8XUREjv35sVCVnw99Q";
const SHARE_ACCOUNT = {
  [HOLDER_A]: "GLVe7ESJ12zKv1RSSSWqzg4QhCiP8aXr4Dh6j2yPkwxm",
  [HOLDER_B]: "6PwHYANUJ1g7GWr9ULW8Mnd3we56K9pRHyntnnr5cLyH",
};
const ALLOWED_USER = {
  [HOLDER_A]: "EuNr2hKomAGZUwADhBy7y2eD5AFjXWqnCoqp3hKsqQEc",
  [HOLDER_B]: "7iKQJhDraVdgCFiezkTygmZ5QNiQoQTccG1434o3GKrM",
};

const POSITION = {
  [HOLDER_A]: {
    providerReference: VAULT,
    owner: HOLDER_A,
    cluster: "devnet",
    shares: "1.499996",
    withdrawableShares: "1.499996",
    unlockTimestamp: null,
    tokenValue: "1.499996",
    tokenMint: USDC,
    shareMint: SHARE_MINT,
  },
  [HOLDER_B]: {
    providerReference: VAULT,
    owner: HOLDER_B,
    cluster: "devnet",
    shares: "8.99999",
    withdrawableShares: "8.99999",
    unlockTimestamp: null,
    tokenValue: "8.99999",
    tokenMint: USDC,
    shareMint: SHARE_MINT,
  },
};

type RecordedAccount = (typeof recorded.programAccounts)[number]["account"];
type RecordedSlot = (typeof recorded.slots)[number];
const ACCOUNTS: Readonly<Record<string, RecordedAccount>> = recorded.accounts;
const [COLD_SLOT, WARM_SLOT] = recorded.slots;

function asRpcAccount(account: RecordedAccount) {
  return {
    data: [account.data, "base64"],
    executable: account.executable,
    lamports: account.lamports,
    owner: account.owner,
    space: account.space,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A devnet stand-in that answers only what was recorded: any other method,
 * account, encoding or slot fails the read and is reported by `take()`.
 */
function recordedChain() {
  const sent: { method: string; params: unknown[] }[] = [];
  const unexpected: string[] = [];
  let current: RecordedSlot | undefined;
  let rounds = 0;
  let waiting: (() => void)[] = [];

  const nextRound = () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length > 1) return;
      setTimeout(() => {
        rounds += 1;
        const due = waiting;
        waiting = [];
        for (const settle of due) settle();
      }, 0);
    });

  const answer = (method: string, params: unknown[], at: RecordedSlot): unknown => {
    const config = record(params[1]);
    const context = { apiVersion: "4.3.0", slot: at.slot };
    if (method === "getMultipleAccounts" && config?.encoding === "base64") {
      const keys = Array.isArray(params[0]) ? params[0] : [];
      const value = keys.map((key) => {
        const account = typeof key === "string" ? ACCOUNTS[key] : undefined;
        if (!account) throw new Error(`unrecorded account ${String(key)}`);
        return asRpcAccount(account);
      });
      return { context, value };
    }
    if (method === "getBlockTime" && params[0] === at.slot) return at.blockTime;
    if (
      method === "getProgramAccounts" &&
      params[0] === VAULT_PROGRAM &&
      config?.encoding === "base64"
    ) {
      const value = recorded.programAccounts.map((row) => ({
        pubkey: row.pubkey,
        account: asRpcAccount(row.account),
      }));
      return config.withContext === true ? { context, value } : value;
    }
    throw new Error(`unrecorded request ${method} ${JSON.stringify(params)}`);
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const payload = record(JSON.parse(String(init?.body)));
      const method = typeof payload?.method === "string" ? payload.method : "(none)";
      const params = Array.isArray(payload?.params) ? payload.params : [];
      sent.push({ method, params });
      let result: unknown;
      try {
        if (!current) throw new Error("no recorded slot selected");
        result = answer(method, params, current);
      } catch (cause) {
        unexpected.push(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      }
      await nextRound();
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload?.id, result }), {
        headers: { "content-type": "application/json" },
      });
    })
  );

  return {
    at(slot: RecordedSlot | undefined) {
      current = slot;
    },
    /** What was sent since the last call: per method, in how many rounds, and what failed. */
    take() {
      const requests: Record<string, number> = {};
      const accountLists: string[] = [];
      for (const { method, params } of sent.splice(0)) {
        requests[method] = (requests[method] ?? 0) + 1;
        if (method === "getMultipleAccounts" && Array.isArray(params[0])) {
          accountLists.push(params[0].map(String).join(","));
        }
      }
      const depth = rounds;
      rounds = 0;
      return {
        requests,
        rounds: depth,
        accountLists: accountLists.sort(),
        unexpected: unexpected.splice(0),
      };
    },
  };
}

const runOperation: VedaVaultOperationRunner = (_label, operation) => operation(() => undefined);
const sandbox = { env: {}, environment: "sandbox" } as const;
let endpoint = 0;

function vedaClient() {
  endpoint += 1;
  const rpcUrl = `https://veda-budget-${endpoint}.invalid`;
  return new VedaVaultDirectClient(async () => rpcUrl, runOperation);
}

function readHolding(client: VedaVaultDirectClient, owner: string) {
  return client.readVaultPositions(sandbox, {
    owner: address(owner),
    providerReferences: [VAULT],
  });
}

const sorted = (...lists: string[][]) => lists.map((list) => list.join(",")).sort();

beforeEach(() => {
  resetVedaReadCaches();
  // WebCrypto finishes each address derivation's SHA-256 on the thread pool,
  // at a time no round boundary can predict. Hashing in process keeps every
  // step of every read on the microtask queue, so the rounds are exact.
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
    if (algorithm !== "SHA-256") throw new Error("unexpected digest algorithm");
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    return new Uint8Array(createHash("sha256").update(bytes).digest()).buffer;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Veda position read RPC budget (recorded devnet Test Vault)", () => {
  it("reads one holder in 10 requests cold and 5 warm", async () => {
    const chain = recordedChain();
    const client = vedaClient();
    const read = () => readHolding(client, HOLDER_A).catch((cause: unknown) => cause);

    chain.at(COLD_SLOT);
    const cold = await read();
    expect(chain.take()).toEqual({
      requests: { getMultipleAccounts: 8, getBlockTime: 1, getProgramAccounts: 1 },
      rounds: 6,
      accountLists: sorted(
        [VAULT_PROGRAM],
        [HOOK_PROGRAM],
        [QUEUE_PROGRAM],
        [VAULT],
        [SHARE_MINT],
        [SHARE_ACCOUNT[HOLDER_A], ALLOWED_USER[HOLDER_A]],
        [VAULT, ASSET_DATA],
        [VAULT, ASSET_DATA, SHARE_MINT, USDC]
      ),
      unexpected: [],
    });
    expect(cold).toEqual([POSITION[HOLDER_A]]);

    chain.at(WARM_SLOT);
    const warm = await read();
    expect(chain.take()).toEqual({
      requests: { getMultipleAccounts: 4, getBlockTime: 1 },
      rounds: 5,
      accountLists: sorted(
        [VAULT],
        [SHARE_ACCOUNT[HOLDER_A], ALLOWED_USER[HOLDER_A]],
        [VAULT, ASSET_DATA],
        [VAULT, ASSET_DATA, SHARE_MINT, USDC]
      ),
      unexpected: [],
    });
    expect(warm).toEqual([POSITION[HOLDER_A]]);
  });

  it("reads two concurrent holders in 11 requests cold and 6 warm", async () => {
    const chain = recordedChain();
    const client = vedaClient();
    const read = () =>
      Promise.all([readHolding(client, HOLDER_A), readHolding(client, HOLDER_B)]).catch(
        (cause: unknown) => cause
      );

    chain.at(COLD_SLOT);
    const cold = await read();
    expect(chain.take()).toEqual({
      requests: { getMultipleAccounts: 9, getBlockTime: 1, getProgramAccounts: 1 },
      rounds: 6,
      accountLists: sorted(
        [VAULT_PROGRAM],
        [HOOK_PROGRAM],
        [QUEUE_PROGRAM],
        [VAULT],
        [SHARE_MINT],
        [SHARE_ACCOUNT[HOLDER_A], ALLOWED_USER[HOLDER_A]],
        [SHARE_ACCOUNT[HOLDER_B], ALLOWED_USER[HOLDER_B]],
        [VAULT, ASSET_DATA],
        [VAULT, ASSET_DATA, SHARE_MINT, USDC]
      ),
      unexpected: [],
    });
    expect(cold).toEqual([[POSITION[HOLDER_A]], [POSITION[HOLDER_B]]]);

    chain.at(WARM_SLOT);
    const warm = await read();
    expect(chain.take()).toEqual({
      requests: { getMultipleAccounts: 5, getBlockTime: 1 },
      rounds: 5,
      accountLists: sorted(
        [VAULT],
        [SHARE_ACCOUNT[HOLDER_A], ALLOWED_USER[HOLDER_A]],
        [SHARE_ACCOUNT[HOLDER_B], ALLOWED_USER[HOLDER_B]],
        [VAULT, ASSET_DATA],
        [VAULT, ASSET_DATA, SHARE_MINT, USDC]
      ),
      unexpected: [],
    });
    expect(warm).toEqual([[POSITION[HOLDER_A]], [POSITION[HOLDER_B]]]);
  });
});
