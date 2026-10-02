import {
  getDepositContext,
  getLendingProgram,
  getLendingTokenDetails,
  getOrCreateATAInstruction,
  getWithdrawContext,
} from "@jup-ag/lend/earn";
import { JUPITER_LEND_EARN_PROGRAM_IDS, JUPITER_LEND_USDT } from "@sdp/types/jupiter-lend-programs";
import {
  type AccountInfo,
  Connection,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { JupiterLendVaultDirectClient } from "./client";
import { jupiterLendConnection } from "./rpc";

/**
 * Pins what the client assumes about the REAL `@jup-ag/lend` SDK, against an
 * in-process chain: the lending lookup the PDA shim answers, the mint fields
 * the SDK reads, the share ATA it derives, and the instructions it builds.
 */

const RPC = "https://rpc.coupling.invalid";
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const LENDING_PROGRAM = new PublicKey(JUPITER_LEND_EARN_PROGRAM_IDS["mainnet-beta"]);
const LIQUIDITY_PROGRAM = new PublicKey("jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC");
const REWARDS_PROGRAM = new PublicKey("jup7TthsMgcR9Y3L277b8Eo9uboVSmu1utkuXHNUKar");
const USDT = new PublicKey(JUPITER_LEND_USDT.assetMint);
const JLUSDT = new PublicKey(JUPITER_LEND_USDT.shareMint);
const LENDING_DISCRIMINATOR = "PiDuNSLmEPr";
const FIXED_MS = Date.UTC(2026, 9, 2, 12, 0, 0);
const NOW_S = Math.floor(FIXED_MS / 1000);
const holder = new PublicKey("11111111111111111111111111111112");
const newcomer = new PublicKey("11111111111111111111111111111113");
const others = [
  new PublicKey("11111111111111111111111111111114"),
  new PublicKey("11111111111111111111111111111115"),
];
const runtime = { environment: "production" as const, env: {} };

const pda = (seeds: Buffer[], program: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];
const ata = (owner: PublicKey, mint: PublicKey) =>
  pda([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM);
const LENDING = pda([Buffer.from("lending"), USDT.toBuffer(), JLUSDT.toBuffer()], LENDING_PROGRAM);
const RESERVE = pda([Buffer.from("reserve"), USDT.toBuffer()], LIQUIDITY_PROGRAM);
const REWARDS = pda([Buffer.from("lending_rewards_rate_model"), USDT.toBuffer()], REWARDS_PROGRAM);

const plain = new Connection(RPC, {
  commitment: "confirmed",
  fetch: (input, init) => fetch(input, init),
});
const chain = new Map<string, { owner: PublicKey; data: Buffer }>();
let requests: Array<{ method: string; params: unknown[] }> = [];
let catalogueRequests = 0;
/** Replaces the chain's answer to one JSON-RPC request. */
let inject: ((method: string, params: unknown[]) => Response | undefined) | undefined;

function mint(supply: bigint): Buffer {
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(supply, 36);
  data.writeUInt8(6, 44);
  data.writeUInt8(1, 45);
  return data;
}

function tokenAccount(mintKey: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const data = Buffer.alloc(165);
  mintKey.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data.writeUInt8(1, 108);
  return data;
}

function memcmpBytes(bytes: string): Buffer {
  return bytes === LENDING_DISCRIMINATOR
    ? Buffer.from([135, 199, 82, 16, 249, 131, 182, 241])
    : new PublicKey(bytes).toBuffer();
}

function accountJson(account: { owner: PublicKey; data: Buffer }) {
  return {
    data: [account.data.toString("base64"), "base64"],
    executable: false,
    lamports: 2_039_280,
    owner: account.owner.toBase58(),
    rentEpoch: 0,
    space: account.data.length,
  };
}

function rpcResult(method: string, params: unknown[]): unknown {
  const context = { slot: 370_000_000 };
  const address = String(params[0]);
  if (method === "getAccountInfo") {
    const account = chain.get(address);
    return { context, value: account ? accountJson(account) : null };
  }
  if (method === "getTokenSupply") {
    const account = chain.get(address);
    const amount = account?.data.readBigUInt64LE(36) ?? 0n;
    return {
      context,
      value: { amount: amount.toString(), decimals: 6, uiAmount: 0, uiAmountString: "0" },
    };
  }
  if (method === "getProgramAccounts") {
    const filters = (params[1] as { filters: Array<{ memcmp: { offset: number; bytes: string } }> })
      .filters;
    return [...chain.entries()]
      .filter(
        ([, account]) =>
          account.owner.toBase58() === address &&
          filters.every(({ memcmp }) => {
            const bytes = memcmpBytes(memcmp.bytes);
            return account.data.subarray(memcmp.offset, memcmp.offset + bytes.length).equals(bytes);
          })
      )
      .map(([pubkey, account]) => ({ pubkey, account: accountJson(account) }));
  }
  throw new Error(`coupling chain: ${method} is not modelled`);
}

beforeAll(async () => {
  const coder = getLendingProgram({ connection: plain, market: "main" }).coder.accounts;
  chain.set(USDT.toBase58(), { owner: TOKEN_PROGRAM, data: mint(2_000_000_000_000_000n) });
  chain.set(JLUSDT.toBase58(), { owner: TOKEN_PROGRAM, data: mint(48_123_456_789_012n) });
  chain.set(LENDING.toBase58(), {
    owner: LENDING_PROGRAM,
    data: await coder.encode("lending", {
      mint: USDT,
      fTokenMint: JLUSDT,
      lendingId: 4,
      decimals: 6,
      rewardsRateModel: REWARDS,
      liquidityExchangePrice: new BN("1200000000000"),
      tokenExchangePrice: new BN("1051854000000"),
      lastUpdateTimestamp: new BN(NOW_S - 3600),
      tokenReservesLiquidity: RESERVE,
      supplyPositionOnLiquidity: RESERVE,
      bump: 254,
    }),
  });
  chain.set(RESERVE.toBase58(), {
    owner: LIQUIDITY_PROGRAM,
    data: await coder.encode("tokenReserve", {
      mint: USDT,
      vault: RESERVE,
      borrowRate: 612,
      feeOnInterest: 1000,
      lastUtilization: 8123,
      lastUpdateTimestamp: new BN(NOW_S - 60),
      supplyExchangePrice: new BN("1200000412345"),
      borrowExchangePrice: new BN("1300000987654"),
      maxUtilization: 9500,
      totalSupplyWithInterest: new BN("14000000000000"),
      totalSupplyInterestFree: new BN(0),
      totalBorrowWithInterest: new BN("11000000000000"),
      totalBorrowInterestFree: new BN(0),
      totalClaimAmount: new BN(0),
      interactingProtocol: PublicKey.default,
      interactingTimestamp: new BN(0),
      interactingBalance: new BN(0),
    }),
  });
  chain.set(REWARDS.toBase58(), {
    owner: REWARDS_PROGRAM,
    data: await coder.encode("lendingRewardsRateModel", {
      mint: USDT,
      startTvl: new BN(1_000_000),
      duration: new BN(365 * 86_400),
      startTime: new BN(NOW_S - 30 * 86_400),
      yearlyReward: new BN("50000000000"),
      nextDuration: new BN(0),
      nextRewardAmount: new BN(0),
      bump: 253,
    }),
  });
  chain.set(ata(holder, JLUSDT).toBase58(), {
    owner: TOKEN_PROGRAM,
    data: tokenAccount(JLUSDT, holder, 1_234_567_890n),
  });
  chain.set(ata(holder, USDT).toBase58(), {
    owner: TOKEN_PROGRAM,
    data: tokenAccount(USDT, holder, 10_000_000n),
  });
  for (const [index, owner] of others.entries()) {
    chain.set(ata(owner, JLUSDT).toBase58(), {
      owner: TOKEN_PROGRAM,
      data: tokenAccount(JLUSDT, owner, BigInt(index + 1) * 1_000_000n),
    });
  }
});

beforeEach(() => {
  requests = [];
  catalogueRequests = 0;
  inject = undefined;
  vi.spyOn(Date, "now").mockReturnValue(FIXED_MS);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      // Every answer lands on a later macrotask, so requests issued together
      // are in flight together, as they are on a real network.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (String(input).startsWith("https://lite-api.jup.ag/")) {
        catalogueRequests += 1;
        return Response.json([
          {
            address: JUPITER_LEND_USDT.shareMint,
            assetAddress: JUPITER_LEND_USDT.assetMint,
            decimals: 6,
            liquiditySupplyData: { withdrawable: "4100000000000" },
          },
        ]);
      }
      const { method, params } = JSON.parse(String(init?.body)) as {
        method: string;
        params: unknown[];
      };
      requests.push({ method, params });
      return (
        inject?.(method, params) ??
        Response.json({ jsonrpc: "2.0", id: "1", result: rpcResult(method, params) })
      );
    })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** RPC requests per method, plus the withdrawal-liquidity catalogue reads. */
function requestCounts() {
  const counts: Record<string, number> = { catalogue: catalogueRequests };
  for (const { method } of requests) counts[method] = (counts[method] ?? 0) + 1;
  return counts;
}

/** HTTP 500 for the one account read of `address`. */
const failAccountRead = (address: PublicKey) => (method: string, params: unknown[]) =>
  method === "getAccountInfo" && params[0] === address.toBase58()
    ? new Response("upstream unavailable", { status: 500 })
    : undefined;

const client = () =>
  new JupiterLendVaultDirectClient(
    async () => RPC,
    async (_label, operation) => operation(() => undefined)
  );

const details = (value: Awaited<ReturnType<typeof getLendingTokenDetails>>) =>
  Object.fromEntries(Object.entries(value).map(([field, item]) => [field, String(item)]));

function earnInstruction(instruction: TransactionInstruction) {
  return {
    programAddress: instruction.programId.toBase58(),
    accounts: instruction.keys.map((key) => ({
      address: key.pubkey.toBase58(),
      role: (key.isSigner ? 2 : 0) + (key.isWritable ? 1 : 0),
    })),
    data: instruction.data.toString("base64"),
  };
}

const deposit = (owner: PublicKey) =>
  client().buildVaultDeposit(runtime, {
    providerReference: JUPITER_LEND_USDT.assetMint,
    owner: owner.toBase58(),
    amount: "25.5",
    minSharesOut: "24",
  });

const withdrawal = (owner: PublicKey) =>
  client().buildVaultWithdrawal(runtime, {
    providerReference: JUPITER_LEND_USDT.assetMint,
    owner: owner.toBase58(),
    shares: "10",
    minAmountOut: "10.4",
  });

/** The SDK-only plan for `deposit(owner)`, read through `plain`. */
async function sdkDeposit(owner: PublicKey) {
  const context = await getDepositContext({
    asset: USDT,
    signer: owner,
    connection: plain,
    market: "main",
  });
  const ataIxs = await getOrCreateATAInstruction(owner, context.fTokenMint, plain);
  const depositIx = await getLendingProgram({ connection: plain, market: "main", signer: owner })
    .methods.depositWithMinAmountOut(new BN(25_500_000), new BN(24_000_000))
    .accounts(context)
    .instruction();
  return { ataIxs, instructions: [...ataIxs, depositIx].map(earnInstruction) };
}

/** The SDK-only plan for `withdrawal(owner)`, read through `plain`. */
async function sdkWithdrawal(owner: PublicKey) {
  const context = await getWithdrawContext({
    asset: USDT,
    signer: owner,
    connection: plain,
    market: "main",
  });
  const ataIxs = await getOrCreateATAInstruction(owner, USDT, plain);
  const redeemIx = await getLendingProgram({ connection: plain, market: "main", signer: owner })
    .methods.redeemWithMinAmountOut(new BN(10_000_000), new BN(10_400_000))
    .accounts(context)
    .instruction();
  return { ataIxs, instructions: [...ataIxs, redeemIx].map(earnInstruction) };
}

/** A connection whose mint answers record every field the SDK reads from them. */
function recordingMints(fields: Set<string>) {
  return new Proxy(plain, {
    get(target, property, receiver) {
      if (property !== "getAccountInfo") return Reflect.get(target, property, receiver);
      return async (address: PublicKey, config?: Parameters<Connection["getAccountInfo"]>[1]) => {
        if (!address.equals(USDT) && !address.equals(JLUSDT))
          return target.getAccountInfo(address, config);
        const info = await target.getAccountInfo(address, config);
        return new Proxy(info ?? {}, {
          get(account, field) {
            if (field !== "then") fields.add(String(field));
            return Reflect.get(account, field);
          },
        }) as AccountInfo<Buffer>;
      };
    },
  });
}

describe("@jup-ag/lend coupling", () => {
  it("looks the lending account up with exactly the query the PDA shim answers", async () => {
    const scan = vi.spyOn(Connection.prototype, "getProgramAccounts");
    await getLendingTokenDetails({ lendingToken: JLUSDT, connection: plain, market: "main" });
    expect(scan).toHaveBeenCalledTimes(1);
    const [programId, config] = scan.mock.calls[0] ?? [];
    expect(programId?.equals(LENDING_PROGRAM)).toBe(true);
    expect(config).toEqual({
      commitment: "confirmed",
      filters: [
        { memcmp: { offset: 0, bytes: LENDING_DISCRIMINATOR } },
        { memcmp: { bytes: JUPITER_LEND_USDT.shareMint, offset: 40 } },
      ],
    });
  });

  it("returns the same lending details through the PDA shim as through the scan", async () => {
    const scanned = await getLendingTokenDetails({
      lendingToken: JLUSDT,
      connection: plain,
      market: "main",
    });
    requests = [];
    const shimmed = await getLendingTokenDetails({
      lendingToken: JLUSDT,
      connection: jupiterLendConnection(RPC),
      market: "main",
    });
    expect(details(shimmed)).toEqual(details(scanned));
    expect(requests.map((request) => request.method)).not.toContain("getProgramAccounts");
    expect(requests).toContainEqual({
      method: "getAccountInfo",
      params: [LENDING.toBase58(), { encoding: "base64", commitment: "confirmed" }],
    });
  });

  it("reads nothing but the owner of the pinned mints for contexts and ATA creates", async () => {
    const fields = new Set<string>();
    const connection = recordingMints(fields);
    await getDepositContext({ asset: USDT, signer: holder, connection, market: "main" });
    await getWithdrawContext({ asset: USDT, signer: holder, connection, market: "main" });
    await getOrCreateATAInstruction(newcomer, JLUSDT, connection);
    await getOrCreateATAInstruction(newcomer, USDT, connection);
    expect([...fields]).toEqual(["owner"]);
  });

  it("derives the share and asset accounts the client reads", async () => {
    const withdraw = await getWithdrawContext({
      asset: USDT,
      signer: holder,
      connection: plain,
      market: "main",
    });
    const deposit = await getDepositContext({
      asset: USDT,
      signer: holder,
      connection: plain,
      market: "main",
    });
    expect(withdraw.fTokenMint.equals(JLUSDT)).toBe(true);

    requests = [];
    await client().readVaultPositions(runtime, {
      owner: holder.toBase58(),
      providerReferences: [],
    });
    expect(requests[0]?.params[0]).toBe(withdraw.ownerTokenAccount.toBase58());

    requests = [];
    await client().buildVaultDeposit(runtime, {
      providerReference: JUPITER_LEND_USDT.assetMint,
      owner: holder.toBase58(),
      amount: "1",
      minSharesOut: "0.9",
    });
    expect(requests.map((request) => request.params[0])).toEqual([
      deposit.recipientTokenAccount.toBase58(),
    ]);

    requests = [];
    await client().buildVaultWithdrawal(runtime, {
      providerReference: JUPITER_LEND_USDT.assetMint,
      owner: holder.toBase58(),
      shares: "1",
      minAmountOut: "0.9",
    });
    expect(requests.map((request) => request.params[0])).toEqual([
      withdraw.recipientTokenAccount.toBase58(),
    ]);
  });

  it.each([
    ["an existing", holder],
    ["a missing", newcomer],
  ])("builds exactly the SDK's instructions for %s share account", async (_case, owner) => {
    const plan = await deposit(owner);
    const expected = await sdkDeposit(owner);
    expect(plan.instructions).toEqual(expected.instructions);
    expect(plan.createsShareAccount).toBe(expected.ataIxs.length > 0);

    const exit = await withdrawal(owner);
    expect(exit.instructions).toEqual((await sdkWithdrawal(owner)).instructions);
  });

  it("plans the SDK's ATA create when the ATA read fails, as the SDK alone does", async () => {
    inject = failAccountRead(ata(holder, JLUSDT));
    const plan = await deposit(holder);
    const expected = await sdkDeposit(holder);
    expect(expected.ataIxs).toHaveLength(1);
    expect(plan.instructions).toEqual(expected.instructions);
    expect(plan.createsShareAccount).toBe(true);

    inject = failAccountRead(ata(holder, USDT));
    const exit = await withdrawal(holder);
    const expectedExit = await sdkWithdrawal(holder);
    expect(expectedExit.ataIxs).toHaveLength(1);
    expect(exit.instructions).toEqual(expectedExit.instructions);
  });
});

describe("request budget, real SDK", () => {
  const read = (owner: PublicKey) =>
    client().readVaultPositions(runtime, { owner: owner.toBase58(), providerReferences: [] });

  it("reads a holder in 7 RPC requests and one catalogue read", async () => {
    await read(holder);
    expect(requestCounts()).toEqual({ catalogue: 1, getAccountInfo: 5, getTokenSupply: 2 });
  });

  it("shares the market reads between holders read together", async () => {
    await Promise.all([holder, ...others].map(read));
    expect(requestCounts()).toEqual({ catalogue: 1, getAccountInfo: 7, getTokenSupply: 2 });
  });

  it("reads an owner without a share account in one request", async () => {
    await expect(read(newcomer)).resolves.toEqual([]);
    expect(requestCounts()).toEqual({ catalogue: 0, getAccountInfo: 1 });
  });

  it("quotes a deposit in 6 RPC requests and a withdrawal in 6 plus the catalogue", async () => {
    await client().quoteVaultDeposit(runtime, {
      providerReference: JUPITER_LEND_USDT.assetMint,
      amount: "1000",
    });
    expect(requestCounts()).toEqual({ catalogue: 0, getAccountInfo: 4, getTokenSupply: 2 });

    requests = [];
    await client().quoteVaultWithdrawal(runtime, {
      providerReference: JUPITER_LEND_USDT.assetMint,
      shares: "1000",
    });
    expect(requestCounts()).toEqual({ catalogue: 1, getAccountInfo: 4, getTokenSupply: 2 });
  });

  it.each([
    ["an existing", holder],
    ["a missing", newcomer],
  ])("builds for %s ATA with one request each way", async (_case, owner) => {
    await deposit(owner);
    expect(requestCounts()).toEqual({ catalogue: 0, getAccountInfo: 1 });
    requests = [];
    await withdrawal(owner);
    expect(requestCounts()).toEqual({ catalogue: 0, getAccountInfo: 1 });
  });
});
