import { createHash } from "node:crypto";
import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VedaVaultDirectClient, type VedaVaultOperationRunner } from "./client";
import positionRead from "./fixtures/devnet-position-read.json";
import queuedWithdrawal from "./fixtures/devnet-queued-withdrawal.json";
import { resetVedaReadCaches } from "./sdk";

/**
 * The RPC budget of the Veda paths, pinned through the real
 * `@vedatech/svm-sdk`, this package's real transports and the registry's devnet
 * deployment, over Veda Test Vault accounts recorded from devnet
 * (`fixtures/devnet-*.json`). The values are the ones the pre-change code
 * returned from the same bytes.
 *
 * Every request waits for one shared round that settles on the next macrotask,
 * so requests the code has in flight together always overlap, as they do on a
 * real network, and the round count is the sequential round-trip depth. Each
 * phase answers at its own recorded slot, so no phase reuses another's block
 * time; a live read that straddles a slot boundary sends one more
 * `getBlockTime` (devnet measured 6 warm for one holder).
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

interface RecordedAccount {
  data: string;
  executable: boolean;
  lamports: number;
  owner: string;
  space: number;
}

interface RecordedSlot {
  slot: number;
  blockTime: number;
}

/** What a devnet recording holds. A `null` account was recorded as absent. */
interface Recording {
  slots: readonly RecordedSlot[];
  accounts: Readonly<Record<string, RecordedAccount | null>>;
  programAccounts: readonly { pubkey: string; account: RecordedAccount }[];
  /** `getAccountInfo(mint, { encoding: "jsonParsed" })` values. */
  parsedMints?: Readonly<Record<string, unknown>>;
  /** `getMinimumBalanceForRentExemption` answers, by byte size. */
  rent?: Readonly<Record<string, number>>;
}

const POSITION_READ: Recording = positionRead;
const QUEUED_WITHDRAWAL: Recording = queuedWithdrawal;

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
function recordedChain(recording: Recording) {
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
        if (typeof key !== "string" || !(key in recording.accounts)) {
          throw new Error(`unrecorded account ${String(key)}`);
        }
        const account = recording.accounts[key];
        return account ? asRpcAccount(account) : null;
      });
      return { context, value };
    }
    if (method === "getBlockTime" && params[0] === at.slot) return at.blockTime;
    if (
      method === "getProgramAccounts" &&
      params[0] === VAULT_PROGRAM &&
      config?.encoding === "base64"
    ) {
      const value = recording.programAccounts.map((row) => ({
        pubkey: row.pubkey,
        account: asRpcAccount(row.account),
      }));
      return config.withContext === true ? { context, value } : value;
    }
    const parsedMint =
      typeof params[0] === "string" ? recording.parsedMints?.[params[0]] : undefined;
    if (method === "getAccountInfo" && config?.encoding === "jsonParsed" && parsedMint) {
      return { context, value: parsedMint };
    }
    const rent = recording.rent?.[String(params[0])];
    if (method === "getMinimumBalanceForRentExemption" && rent !== undefined) return rent;
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
  const [COLD_SLOT, WARM_SLOT] = POSITION_READ.slots;

  it("reads one holder in 10 requests cold and 5 warm", async () => {
    const chain = recordedChain(POSITION_READ);
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
    const chain = recordedChain(POSITION_READ);
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

/** SHA-256 of a value's JSON, for pinning a whole plan without inlining every byte. */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

describe("Veda queued-withdrawal RPC budget (recorded devnet Test Vault)", () => {
  const QUEUE_STATE = "7XbSKzG8Kf1qsprNV1XE9YHNNpSV7jZBWLx1n4B6tSDf";
  const WITHDRAW_ASSET = "FJ7Wonf13SNc5jiVWbBB1Crgfd4GGx7Ak7J9NL2fsksP";
  const QUEUE_SHARES = "CoaoRNSGrezz2KYEUGLxcRPHhAkY7ra9CT9EHLCDPaBz";
  const QUEUE_PERMISSION = "5EvvuQymABMMxxSbEimEKcBsqcZ9rGXjCdfXGbre2xQk";
  const EXTRA_ACCOUNT_METAS = "5FenToYPfPJ9xdkJJXaFdp1jGp8P27p48rmUoR8AMGAJ";
  const HOOK_CONFIG = "J8PyJijc6W6rF94SgbSUd7yn5oM8oHx2BwwhMXu9SLAb";
  // A holder with an earlier request, so its withdraw state exists, and one
  // asking for the first time (its withdraw state recorded absent).
  const REPEAT_OWNER = "2t7Scap8zCvrxseYej4aMubNjhvoGZL1wXxspj4VdLuL";
  const FIRST_OWNER = HOLDER_A;
  const HOLDER_ACCOUNTS = {
    [REPEAT_OWNER]: [
      "2DRVGchuf54ZZJqCvVuoLcEomWgw4YqnpfjXurbUtByK",
      "8P3ZTs85xQ8nHenRzKxtzUcPH75hGAQMPya8AHvArPmy",
      "sCUwGq8TjUWuFjC5fCKVLwBPLKaBG8B1xL4xZAX1Pkw",
    ],
    [FIRST_OWNER]: [
      SHARE_ACCOUNT[HOLDER_A],
      ALLOWED_USER[HOLDER_A],
      "9FxKFPfYigegcqPzaUJTCFHWGEVaF1weZrgn7bXoZ4PN",
    ],
  };
  // The repeat owner's open request.
  const REQUEST = "9uEMcP3nLqFmmA7SA8wwGuJCzJkQQRq85fdmhfGz7qAN";
  // Any valid address: a sponsored build names the rent payer, it never reads it.
  const SPONSOR = HOLDER_B;
  const TERMS = { shares: "0.000001", discountBps: 0, deadlineSeconds: 60 };

  const QUOTE_ACCOUNTS = [VAULT, ASSET_DATA, SHARE_MINT, USDC, QUEUE_STATE, WITHDRAW_ASSET];
  const ESCROW_ACCOUNTS = [
    HOOK_PROGRAM,
    EXTRA_ACCOUNT_METAS,
    HOOK_CONFIG,
    QUEUE_SHARES,
    QUEUE_PERMISSION,
  ];

  const OPTIONS = {
    instant: true,
    providerOrder: false,
    queued: true,
    withdrawAuthority: "11111111111111111111111111111111",
    queueState: QUEUE_STATE,
    parRedemption: null,
    queueAsset: {
      assetMint: USDC,
      allowWithdrawals: true,
      secondsToMaturity: 3600,
      minimumSecondsToDeadline: 60,
      maximumSecondsToDeadline: 7_776_000,
      minimumDiscountBps: 0,
      maximumDiscountBps: 100,
      minimumShares: "0.000001",
      shareDecimals: 6,
    },
  };
  // Both phases answer at a slot whose block time is 1793041747.
  const QUOTE = {
    assetMint: USDC,
    shares: "0.000001",
    shareDecimals: 6,
    assets: "0.000001",
    assetDecimals: 6,
    discountBps: 0,
    maturityTimestamp: "1793045347",
    deadlineTimestamp: "1793045407",
    blockingIssues: [],
  };

  it("reads withdrawal options in 8 requests cold and 2 warm", async () => {
    const chain = recordedChain(QUEUED_WITHDRAWAL);
    const client = vedaClient();
    const read = () =>
      client
        .getWithdrawalOptions(sandbox, { providerReference: VAULT })
        .catch((cause: unknown) => cause);

    chain.at(QUEUED_WITHDRAWAL.slots[0]);
    const cold = await read();
    expect(chain.take()).toEqual({
      requests: { getMultipleAccounts: 6, getBlockTime: 1, getProgramAccounts: 1 },
      rounds: 5,
      accountLists: sorted(
        [VAULT_PROGRAM],
        [HOOK_PROGRAM],
        [QUEUE_PROGRAM],
        [VAULT],
        [SHARE_MINT],
        [VAULT, QUEUE_STATE, WITHDRAW_ASSET]
      ),
      unexpected: [],
    });
    expect(cold).toEqual(OPTIONS);

    chain.at(QUEUED_WITHDRAWAL.slots[1]);
    const warm = await read();
    expect(chain.take()).toEqual({
      requests: { getMultipleAccounts: 1, getBlockTime: 1 },
      rounds: 2,
      accountLists: sorted([VAULT, QUEUE_STATE, WITHDRAW_ASSET]),
      unexpected: [],
    });
    expect(warm).toEqual(OPTIONS);
  });

  it("quotes and builds a queued request from one read of its accounts", async () => {
    const chain = recordedChain(QUEUED_WITHDRAWAL);
    const client = vedaClient();
    const slots = QUEUED_WITHDRAWAL.slots;
    const settle = <T>(call: Promise<T>) => call.catch((cause: unknown) => cause);

    // The shared client and the vault's static facts, as the options read leaves them.
    chain.at(slots[0]);
    await client.getWithdrawalOptions(sandbox, { providerReference: VAULT });
    chain.take();

    // The first quote also reads the asset mint's decimals, once per cache window.
    chain.at(slots[1]);
    const first = await settle(
      client.quoteQueuedWithdrawal(sandbox, { providerReference: VAULT, ...TERMS })
    );
    expect(chain.take()).toEqual({
      requests: { getMultipleAccounts: 1, getAccountInfo: 1, getBlockTime: 1 },
      rounds: 2,
      accountLists: sorted(QUOTE_ACCOUNTS),
      unexpected: [],
    });
    expect(first).toEqual(QUOTE);

    chain.at(slots[2]);
    const quote = await settle(
      client.quoteQueuedWithdrawal(sandbox, { providerReference: VAULT, ...TERMS })
    );
    expect(chain.take()).toEqual({
      requests: { getMultipleAccounts: 1, getBlockTime: 1 },
      rounds: 2,
      accountLists: sorted(QUOTE_ACCOUNTS),
      unexpected: [],
    });
    expect(quote).toEqual(QUOTE);

    chain.at(slots[3]);
    const repeat = await settle(
      client.buildQueuedWithdrawalRequest(sandbox, {
        providerReference: VAULT,
        owner: REPEAT_OWNER,
        ...TERMS,
      })
    );
    expect(chain.take()).toEqual({
      requests: { getMultipleAccounts: 1, getBlockTime: 1 },
      rounds: 2,
      accountLists: sorted([
        ...QUOTE_ACCOUNTS,
        ...ESCROW_ACCOUNTS,
        ...HOLDER_ACCOUNTS[REPEAT_OWNER],
      ]),
      unexpected: [],
    });
    expect(repeat).toMatchObject({
      requestAddress: "3vjsA8o11v7CdjUb9ETqjHCFXw4V2PAMN8YxJA7FJfBu",
      accepted: { shares: "0.000001" },
      expectedRequest: {
        assetMint: USDC,
        shares: "0.000001",
        assets: "0.000001",
        discountBps: 0,
        maturityTimestamp: "1793045348",
        deadlineTimestamp: "1793045408",
      },
    });
    expect(digest(repeat)).toBe("f0abf874f3e5c1fb0bc664815c4dda74aa72cafafbdbc2eca3a8273ce9e37a7a");

    // A first request also creates the holder's withdraw state; a sponsored
    // one reads both rent minima live.
    chain.at(slots[4]);
    const sponsored = await settle(
      client.buildQueuedWithdrawalRequest(sandbox, {
        providerReference: VAULT,
        owner: FIRST_OWNER,
        rentPayer: SPONSOR,
        ...TERMS,
      })
    );
    expect(chain.take()).toEqual({
      requests: {
        getMultipleAccounts: 1,
        getBlockTime: 1,
        getMinimumBalanceForRentExemption: 2,
      },
      rounds: 3,
      accountLists: sorted([
        ...QUOTE_ACCOUNTS,
        ...ESCROW_ACCOUNTS,
        ...HOLDER_ACCOUNTS[FIRST_OWNER],
      ]),
      unexpected: [],
    });
    expect(sponsored).toMatchObject({
      requestAddress: "EYWsvqtwRSaH5C5HjNHBxC4KxmUtYmspS35PcxcvSNn3",
      accepted: { shares: "0.000001" },
    });
    expect(digest(sponsored)).toBe(
      "bcd7e783f04ef7fa0c6b505ba93a205f392c10cc2c6fd57d5a875cd0979729d2"
    );
  });

  it("reads a durable request at finality in 9 requests cold and 2 warm", async () => {
    const chain = recordedChain(QUEUED_WITHDRAWAL);
    const client = vedaClient();
    const read = () =>
      client
        .readQueuedWithdrawalRequest(sandbox, { providerReference: VAULT, requestAddress: REQUEST })
        .catch((cause: unknown) => cause);
    const lookup = {
      requestAddress: REQUEST,
      status: "pending",
      request: {
        requestAddress: REQUEST,
        providerReference: VAULT,
        owner: REPEAT_OWNER,
        nonce: "0",
        assetMint: USDC,
        shares: "1",
        assets: "1",
        creationTimestamp: "1793039336",
        maturityTimestamp: "1793042936",
        deadlineTimestamp: "1793042996",
        status: "pending",
      },
    };

    chain.at(QUEUED_WITHDRAWAL.slots[5]);
    const cold = await read();
    expect(chain.take()).toEqual({
      requests: {
        getMultipleAccounts: 6,
        getBlockTime: 1,
        getProgramAccounts: 1,
        getAccountInfo: 1,
      },
      rounds: 5,
      accountLists: sorted(
        [VAULT_PROGRAM],
        [HOOK_PROGRAM],
        [QUEUE_PROGRAM],
        [VAULT],
        [SHARE_MINT],
        [REQUEST, VAULT]
      ),
      unexpected: [],
    });
    expect(cold).toEqual(lookup);

    chain.at(QUEUED_WITHDRAWAL.slots[6]);
    const warm = await read();
    expect(chain.take()).toEqual({
      requests: { getMultipleAccounts: 1, getBlockTime: 1 },
      rounds: 2,
      accountLists: sorted([REQUEST, VAULT]),
      unexpected: [],
    });
    expect(warm).toEqual(lookup);
  });
});
