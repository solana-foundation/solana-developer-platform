import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { withMinimumRpcSlot } from "@sdp/rpc/read-context";
import { address, getAddressEncoder, none } from "@solana/kit";
import { AccountState, getTokenEncoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KaminoVaultDirectClient } from "./client";
import { readKaminoPositions } from "./sdk";

/**
 * Position reads, quotes and builds against account bytes recorded from
 * Kamino's devnet vault 7319Gu... on 2026-10-02, plus one synthetic farm user
 * state encoded with farms-sdk's own codec. The kvault global config is encoded
 * with klend-sdk's own `KVaultGlobalConfig` codec from devnet's values (the
 * bytes equal the recorded account), share accounts with
 * `@solana-program/token`'s codec, and the lookup table is devnet's
 * `jsonParsed` answer. The real klend-sdk decodes every batched account, so
 * these pin both the request shape and the exact values.
 */

const SLOT = 506689453n;
const VAULT = "7319GuA3DwpJV1SHKKbyLp9MZwiopfc9rUKqZqWJua7J";
const RESERVE = "HRwMj8uuoGVWCanKzKvpTWN5ZvXjtjKGxcFbn2qTPKMW";
const GLOBAL_CONFIG = "eJp1RgQNVp3peArmzPkoCFy6jsa17D5Lr9psVteCkwb";
const LOOKUP_TABLE = "HiBBDZUYDi4bQMMESksJSBV8ohZBTP97imVL1suWy5z8";
const TOKEN_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SHARE_MINT = "F74v5TQDeAQB2rmS1dm6YTzPvaJ9pemd8aYVXaF9pcJs";
const FARM_USER_STATE_A = "6xcA9dELqpRee2ArAuYswmL8o6VXWVVBX277D2cvTiCj";
const FARM_USER_STATE_B = "5613k9NeKqSzCB1FfHxtZ8eHQFiBwMG19tpPTAmtA6F4";
const HOLDER_A = address("FZM6FehZn9uq9vnJWkL1TBz1wqibJL7ESYRFaViCs1dy");
const HOLDER_B = address("8fita6dq8PGtMNtHkDeans1hhg8XUREjv35sVCVnw99Q");
const SHARE_ATA_A = "VpGvYiutrcX4MYrh5jWvip4dUU1NpoPMyZqQhcWWg9p";
/** Each holder's share ATA and its balance on devnet. */
const SHARE_ACCOUNTS: Record<string, { pubkey: string; amount: string }> = {
  [HOLDER_A]: { pubkey: SHARE_ATA_A, amount: "1000000" },
  [HOLDER_B]: { pubkey: "9GsofDN8Sq6AKY52itPgA9fStCLVZEhFBWdZdWkZ7Wj4", amount: "9500000" },
};
/** A share account HOLDER_A holds off the ATA, so a large exit consolidates. */
const AUX_SHARE_ACCOUNT = "Vote111111111111111111111111111111111111111";
/** Byte range of `VaultState.vaultLookupTable`; zeroed, the vault has no table. */
const VAULT_LOOKUP_TABLE_BYTES = [58568, 58600] as const;
/** Byte range of `VaultState.vaultFarm`; zeroed, it reads as the default key. */
const VAULT_FARM_BYTES = [58600, 58632] as const;
/** A second vault: VAULT's bytes allocating to RESERVE_2, a byte copy of RESERVE. */
const VAULT_2 = "Config1111111111111111111111111111111111111";
const RESERVE_2 = "Stake11111111111111111111111111111111111111";

const recorded = {
  [VAULT]: {
    owner: "devkRngFnfp4gBc5a3LsadgbQKdPo8MSZ4prFiNSVmY",
    lamports: 436252800,
    gz: "H4sIAAAAAAACA+3RXUjTARTG4b/4kcIiQyTN0ozCj1ILjelSEpxJRtoapWYqloo2dKGLlKFd1DJSB2qRBVkuxIQJpkURrAxildtCRQtNUdPQNMuRWeDMLkrwouiqu99zczjw8p6LM/7sUOPxnuk620jagqeyWC81zM4ZdBFmV2N9aEile44sXhTY5ubhqLVM3apRnTdcXWeICU86tnq9Vjy1xhhXpJno1Vf1h5UvCr/slm5vr/ZNskpqo+zC/IPst2X8sNjp3loflDg5DwvBTU6/cw7ah7vcAh5vtfm9nG95P5O8asc566Oykj6/qXcVw15f7jgNzY++yW6o7TeN7n01XaLfcE8zk5EqrpZUftWULQnN3dXlRw52JceWjZU2nb1y46OlMeVyok/43cGLfTL5Ua+u5TsTWqP9yvkvF8xPTq5YT33Kjfxjbs47Kz+/8HpL6WTqtfT0gnDJ8/n9GweMperNCS5m78LFMUvFeIOoc7JK86LDduLzzdtVEpPapMhNMAZ0itsjvbKWi1wbeycFQVgSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8D/IVdmZilzl6aLsTYfl0pi/5r7HJebt81FvkWV6FtdERav3OA+6PD0w6Dit2tnanXJ/bZBDV4JiIFpT4e/+rbPHu1be0ax7nRHb6ltw5oPLpQJVXfBQ3so+20jagqeyWC81zM4ZdBFmV2N9aEile44sXhTY5ubhyGcAAAAAABCEn/wmRL5Y9AAA",
  },
  [RESERVE]: {
    owner: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
    lamports: 60913920,
    gz: "H4sIAAAAAAACA9P+dOaU1HfrekYGCMiKN5YD0SB+3fn9WUFPQvU6pmVsFjr/8KyVGEda8LloVzvZJuXZJvc/X5BYdIWBQmDtorN5omL4R6vJtowmGrrM2vH/zjIuuv1xeyUbx30GveUhn+N76/arTAo+3cT9YmvB+tTOBZoOS06sZKlfUFtySXVvguMiOwOpgwbVjmEL2ndnrahabrvMdAeX69LJ1RsVqlmfVS36yYfN3rBPfhNbH/znh/Eb+rZngWg2HO6MYJmtbvxllQADnQDb3W8Pr6cunHzz9EO3c68r18hsaX0bH20+0arna2vdf4aVDKNgFIyCUTAKRsEoGAVkAj/m5fnfHetnXdrz6P1X16Ljf+bO9uEMEXvB2lT1u3+t2RNY+ymOfX1XYUT9RvVUgakpaVwPaxMfllaFLTZjviof0zXrQNZoSI6CUTAKRsEoGAWjYKiBqPgTDF8YueB8CSL0fGFkYHCQh9AaygwMF9gZGATUKcMpMMMFll55AaI7grJKGBgYQoNdnCnx3xYo/QFKcx98d+NCycfD5ld8xLxPadzwOSe9sstho4xw1Byw/H80QEg9Ifl9k2c1c35NYZeo/2+wJmRjpmf3y/m5fdJ/nVwyeK58v/ho0CcQaHyoPWH/CAqP0RxDXZAyGgSjYBSMglEwCkbBKBgFo2AUYAAA8C7jZ7AhAAA=",
  },
  [FARM_USER_STATE_A]: {
    owner: "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr",
    lamports: 7294080,
    gz: "H4sIAAAAAAACA/PYGPrTZ/muOnYGCNBlueCXfcuhtVtD9PupS3KTgw+sXHQt3nWDYl75S86uvJIbPq8jzWwku37r3jvA6r2E66f5VRf3WcXfU7+Z+X13eMYwCqgEGmbHVB225M9jZSRL+z8oTTC+lkpkjQb24AMAH6E5ppgDAAA=",
  },
  // Devnet's values (its admin, zero withdrawal penalties) through klend-sdk's
  // KVaultGlobalConfig codec: byte-identical to the recorded account.
  [GLOBAL_CONFIG]: {
    owner: "devkRngFnfp4gBc5a3LsadgbQKdPo8MSZ4prFiNSVmY",
    lamports: 8073600,
    gz: "H4sIAAAAAAACA5vKMefUgj8bbgYZGJ3Ve/xtSoC2Q8/qy7lZ71XmnNr34M30jqy/Vx4vy3clJM8wCkbBKBiyAABhMAOuCAQAAA==",
  },
} as const;

/**
 * The vault's lookup table as devnet answers a `jsonParsed` read, which is the
 * only form kit's table loader decodes. klend-sdk's own address-lookup-table
 * codec encodes these fields to the recorded 664 bytes.
 */
const LOOKUP_TABLE_PARSED = {
  data: {
    parsed: {
      info: {
        addresses: [
          "J28Aw5VEMxz4Qa8tzBKEvq926CrFgSsEDKdTjVoGMdrC",
          "7319GuA3DwpJV1SHKKbyLp9MZwiopfc9rUKqZqWJua7J",
          "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          "AcT1PWFRwqKvaqjpoVdhoL7jRkUWx2SzrWip3vNPGbCi",
          "F74v5TQDeAQB2rmS1dm6YTzPvaJ9pemd8aYVXaF9pcJs",
          "SysvarRent111111111111111111111111111111111",
          "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
          "Sysvar1nstructions1111111111111111111111111",
          "42jc1hiPp48orPVYrpLj3fM8HqZ2zXwSCuA9m3XquD2j",
          "5AnzjL3J8FKpQuC1VN7ABRwrFTjdsuaoWEyxYz68rZFb",
          "HRwMj8uuoGVWCanKzKvpTWN5ZvXjtjKGxcFbn2qTPKMW",
          "GLFLMdujh7ugivsFGxiTxwRfAwrBxqEL5M7FB6wyrxn6",
          "6aaNTBEmwdN19AAdTwbNrWyUo6iEyiLguxCTePEzSqoH",
          "6icVFmuKEsH5dzDwTSrxzrnJ14N27gDKRc2XAxPtB4ep",
          "7UkBn61VcWhvKpzzX1v82yXVRgorUPD4Ukos8jk5b7Ro",
          "6FY2rwh5wWrtSveAG9t9ANc2YsrChNasVSEpMQubJcXd",
          "7L481bd3UQgqHbcMDHsKmZvSWvqQx1stvyNcnxbRz8ss",
          "7Aoc3MHQkYSB5y3g3ipyFKWF2TBsYdvqNWHbQ2btWXJt",
        ],
        authority: "J28Aw5VEMxz4Qa8tzBKEvq926CrFgSsEDKdTjVoGMdrC",
        deactivationSlot: "18446744073709551615",
        lastExtendedSlot: "455311025",
        lastExtendedSlotStartIndex: 11,
      },
      type: "lookupTable",
    },
    program: "address-lookup-table",
    space: 664,
  },
  executable: false,
  lamports: 5512320,
  owner: "AddressLookupTab1e1111111111111111111111111",
  rentEpoch: 0,
  space: 664,
};

interface Sent {
  method: string;
  params: unknown[];
  /** The sequential round trip this request rode, from 1. */
  round: number;
  /** Why the chain refused it: a method, account or encoding it does not model. */
  refused?: string;
}

interface ShareAccount {
  pubkey: string;
  owner: string;
  amount: string;
}

/** The config object a JSON-RPC read carries after its first parameter. */
type RpcConfig = Record<string, unknown> | undefined;

const addressBytes = (key: string) => Buffer.from(getAddressEncoder().encode(address(key)));

/** `data` with its one reference to `from` pointed at `to`. */
function repointed(data: Buffer, from: string, to: string): Buffer {
  const at = data.indexOf(addressBytes(from));
  if (at < 0 || data.indexOf(addressBytes(from), at + 1) >= 0) {
    throw new Error(`expected exactly one reference to ${from}`);
  }
  const patched = Buffer.from(data);
  addressBytes(to).copy(patched, at);
  return patched;
}

/** A 165-byte Token-program share account, as `getTokenAccountsByOwner` lists it. */
function shareAccountBytes({ owner, amount }: ShareAccount): Buffer {
  return Buffer.from(
    getTokenEncoder().encode({
      mint: address(SHARE_MINT),
      owner: address(owner),
      amount: BigInt(amount),
      delegate: none(),
      state: AccountState.Initialized,
      isNative: none(),
      delegatedAmount: 0n,
      closeAuthority: none(),
    })
  );
}

/**
 * The recorded devnet chain. Every request waits for one shared round that
 * settles on a later macrotask, so requests in flight together overlap as on a
 * real network and the last round is the sequential round-trip depth. A method,
 * account or encoding it does not model is refused, and the refusal is kept on
 * the request.
 */
function chain(options: {
  withoutVaultFarm?: boolean;
  withoutLookupTable?: boolean;
  secondVault?: boolean;
  missing?: string[];
  shareAccounts?: ShareAccount[];
  fail?: (request: Sent) => boolean;
}) {
  const sent: Sent[] = [];
  const accounts = new Map<string, { owner: string; lamports: number; data: Buffer } | null>([
    [FARM_USER_STATE_B, null],
    ...(options.missing ?? []).map((key) => [key, null] as const),
  ]);
  for (const [key, account] of Object.entries(recorded)) {
    accounts.set(key, { ...account, data: gunzipSync(Buffer.from(account.gz, "base64")) });
  }
  const shareAccounts: ShareAccount[] = [
    ...Object.entries(SHARE_ACCOUNTS).map(([owner, holding]) => ({ owner, ...holding })),
    ...(options.shareAccounts ?? []),
  ];
  for (const shareAccount of shareAccounts) {
    accounts.set(shareAccount.pubkey, {
      owner: TOKEN_PROGRAM_ADDRESS,
      lamports: 1488440,
      data: shareAccountBytes(shareAccount),
    });
  }
  const vault = accounts.get(VAULT);
  if (options.withoutVaultFarm && vault) vault.data.fill(0, ...VAULT_FARM_BYTES);
  if (options.withoutLookupTable && vault) vault.data.fill(0, ...VAULT_LOOKUP_TABLE_BYTES);
  const reserve = accounts.get(RESERVE);
  if (options.secondVault && vault && reserve) {
    accounts.set(VAULT_2, { ...vault, data: repointed(vault.data, RESERVE, RESERVE_2) });
    accounts.set(RESERVE_2, { ...reserve, data: Buffer.from(reserve.data) });
  }

  let rounds = 0;
  let waiting: Array<() => void> = [];
  const nextRound = () =>
    new Promise<void>((settle) => {
      waiting.push(settle);
      if (waiting.length > 1) return;
      setTimeout(() => {
        rounds += 1;
        const due = waiting;
        waiting = [];
        for (const release of due) release();
      }, 0);
    });

  const rpcAccount = (key: unknown, encoding: unknown) => {
    if (key === LOOKUP_TABLE) {
      if (encoding !== "jsonParsed") throw new Error(`lookup table read as ${String(encoding)}`);
      return LOOKUP_TABLE_PARSED;
    }
    const account = accounts.get(String(key));
    if (account === undefined) throw new Error(`unexpected account ${String(key)}`);
    if (account === null) return null;
    // Program accounts without an RPC parser come back as base64 either way; a
    // parsed token account is not modelled.
    const parsedByRpc = account.owner === TOKEN_PROGRAM_ADDRESS;
    if (encoding !== "base64" && (encoding !== "jsonParsed" || parsedByRpc)) {
      throw new Error(`account ${String(key)} read as ${String(encoding)}`);
    }
    return {
      data: [account.data.toString("base64"), "base64"],
      executable: false,
      lamports: account.lamports,
      owner: account.owner,
      rentEpoch: 0,
      space: account.data.length,
    };
  };

  const answer = ({ method, params }: Sent): unknown => {
    const [first, second, third] = params as [unknown, RpcConfig?, RpcConfig?];
    const context = { slot: Number(SLOT) };
    switch (method) {
      case "getSlot":
        return Number(SLOT);
      case "getAccountInfo":
        return { context, value: rpcAccount(first, second?.encoding) };
      case "getMultipleAccounts":
        return {
          context,
          value: (Array.isArray(first) ? first : []).map((key) =>
            rpcAccount(key, second?.encoding)
          ),
        };
      case "getTokenAccountsByOwner":
        if (second?.mint !== SHARE_MINT || third?.encoding !== "jsonParsed") {
          throw new Error(`unexpected share-account query ${JSON.stringify(params)}`);
        }
        return {
          context,
          value: shareAccounts
            .filter((shareAccount) => shareAccount.owner === first)
            .map(({ pubkey, amount }) => ({
              pubkey,
              account: { data: { parsed: { info: { tokenAmount: { amount } } } } },
            })),
        };
      default:
        throw new Error(`unexpected method ${method}`);
    }
  };

  const fetchStub = vi.fn(async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as { id: string; method: string; params?: unknown[] };
    const entry: Sent = { method: request.method, params: request.params ?? [], round: rounds + 1 };
    sent.push(entry);
    await nextRound();
    if (options.fail?.(entry)) return new Response("Too Many Requests", { status: 429 });
    let result: unknown;
    try {
      result = answer(entry);
    } catch (cause) {
      entry.refused = cause instanceof Error ? cause.message : String(cause);
      throw cause;
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchStub);
  return sent;
}

let endpoint = 0;
const runtime = () => {
  endpoint += 1;
  return { cluster: "devnet" as const, rpcUrl: `https://batched-${endpoint}.invalid` };
};
const accountsOf = (request: Sent | undefined) => request?.params[0] as string[] | undefined;

const ctx = { env: {}, environment: "sandbox" as const };
const client = (rpcUrl: string) =>
  new KaminoVaultDirectClient(
    async () => rpcUrl,
    (_label, operation) => operation(() => undefined)
  );
const methodCounts = (sent: Sent[]) =>
  Object.fromEntries(
    [...new Set(sent.map((request) => request.method))].map((method) => [
      method,
      sent.filter((request) => request.method === method).length,
    ])
  );

/** One request as `r<round> <method> <accounts> <encoding>`. */
function readOf({ method, params, round }: Sent): string {
  const [first, second, third] = params as [unknown, RpcConfig?, RpcConfig?];
  switch (method) {
    case "getAccountInfo":
    case "getMultipleAccounts":
      return `r${round} ${method} ${String(first)} ${String(second?.encoding)}`;
    case "getTokenAccountsByOwner":
      return `r${round} ${method} ${String(first)} ${String(second?.mint)} ${String(third?.encoding)}`;
    default:
      return `r${round} ${method}`;
  }
}

/**
 * What an operation sent: requests per method, sequential round trips, every
 * read, and anything the chain refused. `requests` is exact, so any other
 * method (a send, a simulation, a blockhash read) fails the assertion.
 */
function budget(sent: Sent[]) {
  return {
    requests: methodCounts(sent),
    rounds: Math.max(0, ...sent.map((request) => request.round)),
    reads: sent.map(readOf).sort(),
    refused: sent.flatMap((request) => (request.refused === undefined ? [] : [request.refused])),
  };
}

beforeEach(() => {
  // WebCrypto finishes each address derivation's SHA-256 on the thread pool, at
  // a time no round boundary can predict. Hashing in process keeps every step on
  // the microtask queue, so a round is exactly one round trip.
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

describe("readKaminoPositions over batched accounts", () => {
  it("reads a staked farm-vault holding in three requests", async () => {
    const sent = chain({});
    const [result] = await readKaminoPositions(runtime(), {
      vaults: [VAULT],
      owner: HOLDER_A,
      slot: SLOT,
    });

    expect(result).toEqual({
      status: "fulfilled",
      value: expect.objectContaining({
        shares: "2.234567891",
        withdrawableShares: "1",
        tokenValue: "2.234567",
      }),
    });
    expect(sent.map((request) => request.method)).toEqual([
      "getMultipleAccounts",
      "getMultipleAccounts",
      "getTokenAccountsByOwner",
    ]);
    expect(accountsOf(sent[0])).toEqual([VAULT]);
    expect(accountsOf(sent[1])).toEqual([FARM_USER_STATE_A, RESERVE].sort());
  });

  it("reads no farm state for a vault without farms", async () => {
    const sent = chain({ withoutVaultFarm: true });
    const [result] = await readKaminoPositions(runtime(), {
      vaults: [VAULT],
      owner: HOLDER_A,
      slot: SLOT,
    });

    expect(result).toEqual({
      status: "fulfilled",
      value: expect.objectContaining({ shares: "1", withdrawableShares: "1", tokenValue: "1" }),
    });
    expect(accountsOf(sent[1])).toEqual([RESERVE]);
  });

  it("keeps the share count when the reserve batch fails", async () => {
    const sent = chain({
      fail: (request) =>
        request.method === "getMultipleAccounts" &&
        (request.params[0] as string[]).includes(RESERVE),
    });
    const [result] = await readKaminoPositions(runtime(), {
      vaults: [VAULT],
      owner: HOLDER_A,
      slot: SLOT,
    });

    expect(result?.status).toBe("fulfilled");
    expect(result?.status === "fulfilled" ? result.value : undefined).toMatchObject({
      shares: "2.234567891",
      withdrawableShares: "1",
    });
    expect(result?.status === "fulfilled" ? result.value.tokenValue : "read").toBeUndefined();
    // After the union fails: the farm user state alone, and the vault's reserves on their own.
    expect(sent).toHaveLength(5);
    expect(sent.slice(3).map(accountsOf)).toEqual(
      expect.arrayContaining([[FARM_USER_STATE_A], [RESERVE]])
    );
  });

  it("re-reads reserves per vault, so one failed reserve read blanks only its vault", async () => {
    const sent = chain({
      secondVault: true,
      fail: (request) =>
        request.method === "getMultipleAccounts" &&
        (request.params[0] as string[]).includes(RESERVE_2),
    });
    const [first, second] = await readKaminoPositions(runtime(), {
      vaults: [VAULT, VAULT_2],
      owner: HOLDER_A,
      slot: SLOT,
    });

    expect(first).toMatchObject({
      status: "fulfilled",
      value: { vault: VAULT, shares: "2.234567891", tokenValue: "2.234567" },
    });
    expect(second).toMatchObject({
      status: "fulfilled",
      value: { vault: VAULT_2, shares: "2.234567891", withdrawableShares: "1" },
    });
    expect(second?.status === "fulfilled" ? second.value.tokenValue : "read").toBeUndefined();
    const batches = sent
      .filter((request) => request.method === "getMultipleAccounts")
      .map(accountsOf);
    expect(batches.slice(0, 2)).toEqual([
      [VAULT, VAULT_2].sort(),
      [FARM_USER_STATE_A, RESERVE, RESERVE_2].sort(),
    ]);
    expect(batches.slice(2)).toHaveLength(3);
    expect(batches.slice(2)).toEqual(
      expect.arrayContaining([[FARM_USER_STATE_A], [RESERVE], [RESERVE_2]])
    );
  });

  it("shares the vault read between owners read together", async () => {
    const sent = chain({});
    const shared = runtime();
    const [first, second] = await Promise.all([
      readKaminoPositions(shared, { vaults: [VAULT], owner: HOLDER_A, slot: SLOT }),
      readKaminoPositions(shared, { vaults: [VAULT], owner: HOLDER_B, slot: SLOT }),
    ]);

    expect(first?.[0]).toMatchObject({ status: "fulfilled", value: { shares: "2.234567891" } });
    expect(second?.[0]).toMatchObject({ status: "fulfilled", value: { shares: "9.5" } });
    expect(sent.filter((request) => accountsOf(request)?.includes(VAULT))).toHaveLength(1);
    expect(sent).toHaveLength(5);
  });

  it("never shares a minimum-slot read with an unscoped one", async () => {
    const sent = chain({});
    const shared = runtime();
    await Promise.all([
      withMinimumRpcSlot(Number(SLOT), () =>
        readKaminoPositions(shared, { vaults: [VAULT], owner: HOLDER_A, slot: SLOT })
      ),
      readKaminoPositions(shared, { vaults: [VAULT], owner: HOLDER_B, slot: SLOT }),
    ]);

    const vaultReads = sent.filter((request) => accountsOf(request)?.includes(VAULT));
    expect(
      vaultReads.map((request) => (request.params[1] as { minContextSlot?: number }).minContextSlot)
    ).toEqual(expect.arrayContaining([Number(SLOT), undefined]));
    expect(vaultReads).toHaveLength(2);
  });

  it("settles each requested vault on its own, duplicates included", async () => {
    const missing = "So11111111111111111111111111111111111111112";
    chain({ missing: [missing] });
    const results = await readKaminoPositions(runtime(), {
      vaults: [missing, VAULT, missing],
      owner: HOLDER_A,
      slot: SLOT,
    });

    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled", "rejected"]);
    expect(results[0]).toMatchObject({ reason: { code: "VAULT_UNREADABLE" } });
    expect(results[2]).toBe(results[0]);
  });
});

describe("KaminoVaultDirectClient position read request counts", () => {
  it("reads one holding in four requests over three rounds", async () => {
    const sent = chain({});
    const { rpcUrl } = runtime();

    await expect(
      client(rpcUrl).readVaultPositions(ctx, { owner: HOLDER_A, providerReferences: [VAULT] })
    ).resolves.toEqual([
      expect.objectContaining({
        providerReference: VAULT,
        shares: "2.234567891",
        tokenValue: "2.234567",
      }),
    ]);
    expect(sent.map((request) => request.method)).toEqual([
      "getSlot",
      "getMultipleAccounts",
      "getMultipleAccounts",
      "getTokenAccountsByOwner",
    ]);
    expect(budget(sent).rounds).toBe(3);
  });

  it("reads two owners hydrated together in six requests over three rounds", async () => {
    const sent = chain({});
    const { rpcUrl } = runtime();

    const [first, second] = await Promise.all(
      [HOLDER_A, HOLDER_B].map((owner) =>
        client(rpcUrl).readVaultPositions(ctx, { owner, providerReferences: [VAULT] })
      )
    );

    expect(first).toEqual([expect.objectContaining({ owner: HOLDER_A, shares: "2.234567891" })]);
    expect(second).toEqual([expect.objectContaining({ owner: HOLDER_B, shares: "9.5" })]);
    expect(sent).toHaveLength(6);
    expect(methodCounts(sent)).toEqual({
      getSlot: 1,
      getMultipleAccounts: 3,
      getTokenAccountsByOwner: 2,
    });
    expect(budget(sent).rounds).toBe(3);
  });
});

describe("KaminoVaultDirectClient quote and build request counts", () => {
  /** Settles `operation`, so a test checks what it sent before what it returned. */
  const settled = async <T>(operation: Promise<T>) => (await Promise.allSettled([operation]))[0];

  it("quotes a deposit in three requests over three rounds", async () => {
    const sent = chain({});
    const { rpcUrl } = runtime();

    const quote = await settled(
      client(rpcUrl).quoteVaultDeposit(ctx, { providerReference: VAULT, amount: "1" })
    );

    expect(budget(sent)).toEqual({
      requests: { getSlot: 1, getAccountInfo: 1, getMultipleAccounts: 1 },
      rounds: 3,
      reads: [
        "r1 getSlot",
        `r2 getAccountInfo ${VAULT} base64`,
        `r3 getMultipleAccounts ${RESERVE} base64`,
      ],
      refused: [],
    });
    expect(quote).toEqual({
      status: "fulfilled",
      value: { sharesOut: "1", shareDecimals: 6, blockingIssues: [] },
    });
  });

  it("quotes a withdrawal in three requests, the global config riding the reserve batch", async () => {
    const sent = chain({});
    const { rpcUrl } = runtime();

    const quote = await settled(
      client(rpcUrl).quoteVaultWithdrawal(ctx, { providerReference: VAULT, shares: "0.5" })
    );

    expect(budget(sent)).toEqual({
      requests: { getSlot: 1, getAccountInfo: 1, getMultipleAccounts: 1 },
      rounds: 3,
      reads: [
        "r1 getSlot",
        `r2 getAccountInfo ${VAULT} base64`,
        `r3 getMultipleAccounts ${[GLOBAL_CONFIG, RESERVE].sort()} base64`,
      ],
      refused: [],
    });
    expect(quote).toEqual({
      status: "fulfilled",
      value: { assetsOut: "0.5", assetDecimals: 6, blockingIssues: [] },
    });
  });

  it("builds a deposit in two requests, the share ATA riding the reserve batch", async () => {
    const sent = chain({});
    const { rpcUrl } = runtime();

    const plan = await settled(
      client(rpcUrl).buildVaultDeposit(ctx, {
        providerReference: VAULT,
        owner: HOLDER_A,
        amount: "1.5",
      })
    );

    expect(budget(sent)).toEqual({
      requests: { getAccountInfo: 1, getMultipleAccounts: 1 },
      rounds: 2,
      reads: [
        `r1 getAccountInfo ${VAULT} base64`,
        `r2 getMultipleAccounts ${[RESERVE, SHARE_ATA_A].sort()} base64`,
      ],
      refused: [],
    });
    expect(plan).toMatchObject({
      status: "fulfilled",
      value: {
        cluster: "devnet",
        lookupTables: [],
        assetIdentity: { depositTokenMint: TOKEN_MINT, shareMint: SHARE_MINT },
        accepted: { amount: "1.5" },
        createsShareAccount: false,
      },
    });
  });

  /** Every withdrawal build: the slot, the vault, then the share accounts beside one batch. */
  const withdrawalBudget = (batch: string[]) => ({
    requests: {
      getSlot: 1,
      getAccountInfo: 1,
      getMultipleAccounts: 1,
      getTokenAccountsByOwner: 1,
    },
    rounds: 3,
    reads: [
      "r1 getSlot",
      `r2 getAccountInfo ${VAULT} base64`,
      `r3 getMultipleAccounts ${batch.sort()} jsonParsed`,
      `r3 getTokenAccountsByOwner ${HOLDER_A} ${SHARE_MINT} jsonParsed`,
    ],
    refused: [],
  });

  it("builds a withdrawal from the share ATA in four requests over three rounds", async () => {
    const sent = chain({});
    const { rpcUrl } = runtime();

    const plan = await settled(
      client(rpcUrl).buildVaultWithdrawal(ctx, {
        providerReference: VAULT,
        owner: HOLDER_A,
        shares: "0.4",
      })
    );

    expect(budget(sent)).toEqual(withdrawalBudget([GLOBAL_CONFIG, LOOKUP_TABLE, RESERVE]));
    expect(plan).toMatchObject({
      status: "fulfilled",
      value: {
        cluster: "devnet",
        lookupTables: [LOOKUP_TABLE],
        accepted: { shares: "0.4" },
        createsShareAccount: false,
      },
    });
  });

  it("consolidates a second share account within the same four requests", async () => {
    const sent = chain({
      shareAccounts: [{ pubkey: AUX_SHARE_ACCOUNT, owner: HOLDER_A, amount: "2000001" }],
    });
    const { rpcUrl } = runtime();

    const plan = await settled(
      client(rpcUrl).buildVaultWithdrawal(ctx, {
        providerReference: VAULT,
        owner: HOLDER_A,
        shares: "2.5",
      })
    );

    expect(budget(sent)).toEqual(withdrawalBudget([GLOBAL_CONFIG, LOOKUP_TABLE, RESERVE]));
    expect(plan).toMatchObject({
      status: "fulfilled",
      value: {
        lookupTables: [LOOKUP_TABLE],
        accepted: { shares: "2.5" },
        createsShareAccount: false,
      },
    });
    // transferChecked(source, mint, destination, authority) into the ATA.
    const instructions = plan?.status === "fulfilled" ? plan.value.instructions : [];
    expect(
      instructions
        .filter(
          (instruction) =>
            instruction.programAddress === TOKEN_PROGRAM_ADDRESS &&
            instruction.accounts[0]?.address === AUX_SHARE_ACCOUNT
        )
        .map((instruction) => instruction.accounts.map((account) => account.address))
    ).toEqual([[AUX_SHARE_ACCOUNT, SHARE_MINT, SHARE_ATA_A, HOLDER_A]]);
  });

  it("builds a withdrawal from a vault without a lookup table in four requests", async () => {
    const sent = chain({ withoutLookupTable: true });
    const { rpcUrl } = runtime();

    const plan = await settled(
      client(rpcUrl).buildVaultWithdrawal(ctx, {
        providerReference: VAULT,
        owner: HOLDER_A,
        shares: "0.4",
      })
    );

    expect(budget(sent)).toEqual(withdrawalBudget([GLOBAL_CONFIG, RESERVE]));
    expect(plan).toMatchObject({
      status: "fulfilled",
      value: { lookupTables: [], accepted: { shares: "0.4" }, createsShareAccount: false },
    });
  });
});
