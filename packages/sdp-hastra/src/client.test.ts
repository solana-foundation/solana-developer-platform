import { createHash } from "node:crypto";
import type { EarnRuntimeContext, EarnVaultInstruction } from "@sdp/earn/types";
import { wellKnownMint } from "@sdp/types";
import { HASTRA_DEPLOYMENTS } from "@sdp/types/hastra-programs";
import { PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveHastraAddresses,
  HASTRA_PAR_MINIMUM_ASSETS,
  HASTRA_REQUEST_REUSE_COOLDOWN_BLOCKS,
  HASTRA_SWAP_COMPUTE_UNIT_LIMIT,
  HastraVaultDirectClient,
} from "./client";
import type { HastraSwapLeg, HastraSwapPort } from "./types";

const configuredDeployment = HASTRA_DEPLOYMENTS["mainnet-beta"];
if (!configuredDeployment) throw new Error("test premise: Hastra mainnet deployment is configured");
const DEPLOYMENT = configuredDeployment;
const configuredUsdc = wellKnownMint("USDC", "mainnet-beta");
if (!configuredUsdc) throw new Error("test premise: mainnet USDC is configured");
const USDC = configuredUsdc;

const OWNER = "C4XGF8r1gQP7p2PeKcRAFNwGAU1gCxiinRufqddY1m98";
const PAYER = "9jQqxu5N6bV1qkh1Yv5F6zSMDNFCV2eqRV8HqvcHhk9V";
const FOREIGN_PROGRAM = "B8FDo5EGA2hZ7YMugcw8wPHUYDBQJfNkEYpduXFLHfdZ";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const CTX: EarnRuntimeContext = { env: {}, environment: "production" };

function disc(namespace: "account" | "event" | "global", name: string): Buffer {
  return createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8);
}

function key(value: string): Buffer {
  return new PublicKey(value).toBuffer();
}

function u32(value: number): Buffer {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(value);
  return data;
}

function u64(value: bigint): Buffer {
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(value);
  return data;
}

function i64(value: bigint): Buffer {
  const data = Buffer.alloc(8);
  data.writeBigInt64LE(value);
  return data;
}

function i128(value: bigint): Buffer {
  const data = Buffer.alloc(16);
  data.writeBigUInt64LE(value & ((1n << 64n) - 1n), 0);
  data.writeBigUInt64LE(value >> 64n, 8);
  return data;
}

function pda(program: string, ...seeds: (string | Uint8Array)[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    seeds.map((seed) => (typeof seed === "string" ? Buffer.from(seed) : Buffer.from(seed))),
    new PublicKey(program)
  );
}

function ata(owner: string, mint: string): string {
  return PublicKey.findProgramAddressSync(
    [key(owner), key(TOKEN_PROGRAM), key(mint)],
    new PublicKey(ATA_PROGRAM)
  )[0].toBase58();
}

interface FixtureAccount {
  data: Buffer;
  executable?: boolean;
  owner: string;
}

function accountWire(account: FixtureAccount | undefined) {
  if (!account) return null;
  return {
    data: [account.data.toString("base64"), "base64"],
    executable: account.executable ?? false,
    owner: account.owner,
    lamports: 1,
  };
}

function mintData(authority: string | null, supply = 0n): Buffer {
  const data = Buffer.alloc(82);
  if (authority) {
    data.writeUInt32LE(1, 0);
    key(authority).copy(data, 4);
  }
  data.writeBigUInt64LE(supply, 36);
  data[44] = 6;
  data[45] = 1;
  return data;
}

function tokenAccountData(mint: string, owner: string, amount = 0n, frozen = false): Buffer {
  const data = Buffer.alloc(165);
  key(mint).copy(data, 0);
  key(owner).copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = frozen ? 2 : 1;
  return data;
}

function fixtureState(options?: { mintPaused?: boolean; stakePaused?: boolean; stale?: boolean }) {
  const addresses = deriveHastraAddresses(DEPLOYMENT);
  const mintProgram = DEPLOYMENT.vaultMintProgramAddress;
  const stakeProgram = DEPLOYMENT.vaultStakeProgramAddress;
  const depositVault = pda(mintProgram, "fixture_deposit_vault")[0].toBase58();
  const redeemVault = pda(mintProgram, "fixture_redeem_vault")[0].toBase58();
  const stakeVault = pda(stakeProgram, "fixture_stake_vault")[0].toBase58();
  const depositVaultAuthority = PAYER;
  const [mintConfig, mintConfigBump] = pda(mintProgram, "config");
  const [, mintVaultConfigBump] = pda(
    mintProgram,
    "vault_token_account_config",
    mintConfig.toBytes()
  );
  const [stakeConfig, stakeConfigBump] = pda(stakeProgram, "stake_config");
  const [, stakeVaultConfigBump] = pda(
    stakeProgram,
    "stake_vault_token_account_config",
    stakeConfig.toBytes()
  );
  const [, priceBump] = pda(stakeProgram, "stake_price_config", stakeConfig.toBytes());

  const mintConfigData = Buffer.concat([
    disc("account", "Config"),
    key(USDC),
    key(DEPLOYMENT.wYldsMint),
    u32(0),
    u32(0),
    key(depositVaultAuthority),
    key(redeemVault),
    Buffer.from([mintConfigBump, options?.mintPaused ? 1 : 0]),
    key(stakeProgram),
  ]);
  const stakeConfigData = Buffer.concat([
    disc("account", "StakeConfig"),
    key(DEPLOYMENT.wYldsMint),
    key(DEPLOYMENT.primeMint),
    i64(0n),
    u32(0),
    u32(0),
    Buffer.from([stakeConfigBump, options?.stakePaused ? 1 : 0]),
  ]);
  const price = 1_250_000_000n; // 1 PRIME = 1.25 wYLDS
  const scale = 1_000_000_000n;
  const timestamp = BigInt(Math.floor(Date.now() / 1_000) - (options?.stale ? 7_200 : 0));
  const priceData = Buffer.concat([
    disc("account", "StakePriceConfig"),
    key(FOREIGN_PROGRAM),
    key(PAYER),
    key(OWNER),
    Buffer.alloc(32, 7),
    i128(price),
    u64(scale),
    i64(timestamp),
    i64(3_600n),
    Buffer.from([priceBump]),
  ]);

  const accounts = new Map<string, FixtureAccount>([
    [mintProgram, { data: Buffer.alloc(0), executable: true, owner: LOADER }],
    [stakeProgram, { data: Buffer.alloc(0), executable: true, owner: LOADER }],
    [addresses.mintConfig, { data: mintConfigData, owner: mintProgram }],
    [
      addresses.mintVaultTokenAccountConfig,
      {
        data: Buffer.concat([
          disc("account", "VaultTokenAccountConfig"),
          key(depositVault),
          Buffer.from([mintVaultConfigBump]),
        ]),
        owner: mintProgram,
      },
    ],
    [addresses.stakeConfig, { data: stakeConfigData, owner: stakeProgram }],
    [
      addresses.stakeVaultTokenAccountConfig,
      {
        data: Buffer.concat([
          disc("account", "StakeVaultTokenAccountConfig"),
          key(stakeVault),
          key(addresses.stakeVaultAuthority),
          Buffer.from([stakeVaultConfigBump]),
        ]),
        owner: stakeProgram,
      },
    ],
    [addresses.stakePriceConfig, { data: priceData, owner: stakeProgram }],
    [USDC, { data: mintData(null), owner: TOKEN_PROGRAM }],
    [
      DEPLOYMENT.wYldsMint,
      { data: mintData(addresses.mintAuthority, 10_000_000_000n), owner: TOKEN_PROGRAM },
    ],
    [
      DEPLOYMENT.primeMint,
      { data: mintData(addresses.stakeMintAuthority, 8_000_000_000n), owner: TOKEN_PROGRAM },
    ],
    [
      depositVault,
      {
        data: tokenAccountData(USDC, depositVaultAuthority, 10_000_000_000n),
        owner: TOKEN_PROGRAM,
      },
    ],
    [
      redeemVault,
      {
        data: tokenAccountData(USDC, addresses.redeemVaultAuthority, 10_000_000_000n),
        owner: TOKEN_PROGRAM,
      },
    ],
    [
      stakeVault,
      {
        data: tokenAccountData(
          DEPLOYMENT.wYldsMint,
          addresses.stakeVaultAuthority,
          10_000_000_000n
        ),
        owner: TOKEN_PROGRAM,
      },
    ],
    [
      ata(OWNER, USDC),
      { data: tokenAccountData(USDC, OWNER, 10_000_000_000n), owner: TOKEN_PROGRAM },
    ],
  ]);
  return { accounts, addresses, depositVault, redeemVault, stakeVault, price, scale };
}

function stubRpc(
  accounts: Map<string, FixtureAccount>,
  reuse?: {
    latestSlot: number;
    closingBlockHeight: number;
    currentBlockHeight: number;
    finalizedRequest?: FixtureAccount;
    lifecycle?: "close" | "unrelated" | "failed" | "missing-err" | "unavailable" | "missing-logs";
  }
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (body.method === "getMultipleAccounts") {
        const addresses = body.params[0] as string[];
        return Response.json({
          result: { value: addresses.map((address) => accountWire(accounts.get(address))) },
        });
      }
      if (body.method === "getAccountInfo") {
        const address = body.params[0] as string;
        const options = body.params[1] as { commitment?: string } | undefined;
        if (options?.commitment === "finalized" && reuse?.finalizedRequest) {
          return Response.json({ result: { value: accountWire(reuse.finalizedRequest) } });
        }
        return Response.json({ result: { value: accountWire(accounts.get(address)) } });
      }
      if (body.method === "getMinimumBalanceForRentExemption") {
        return Response.json({ result: 2_039_280 });
      }
      if (body.method === "getSignaturesForAddress") {
        const historyEntry = {
          slot: reuse?.latestSlot,
          signature: "prior",
          ...(reuse?.lifecycle === "missing-err"
            ? {}
            : {
                err: reuse?.lifecycle === "failed" ? { InstructionError: [0, "Custom"] } : null,
              }),
        };
        return Response.json({
          result: reuse ? [historyEntry] : [],
        });
      }
      if (body.method === "getTransaction") {
        if (reuse?.lifecycle === "unavailable") {
          return Response.json({ result: null });
        }
        const cancelled = event("RedemptionCancelled", [
          key(OWNER),
          u64(2_000_000_000n),
          key(DEPLOYMENT.wYldsMint),
          key(USDC),
        ]);
        return Response.json({
          result: {
            meta: {
              err: null,
              logMessages:
                reuse?.lifecycle === "missing-logs"
                  ? null
                  : reuse?.lifecycle === "unrelated"
                    ? [
                        `Program ${FOREIGN_PROGRAM} invoke [1]`,
                        `Program ${FOREIGN_PROGRAM} success`,
                      ]
                    : [
                        `Program ${DEPLOYMENT.vaultMintProgramAddress} invoke [1]`,
                        cancelled,
                        `Program ${DEPLOYMENT.vaultMintProgramAddress} success`,
                      ],
            },
          },
        });
      }
      if (body.method === "getBlock") {
        return Response.json({ result: { blockHeight: reuse?.closingBlockHeight ?? null } });
      }
      if (body.method === "getBlockHeight") {
        return Response.json({ result: reuse?.currentBlockHeight ?? 0 });
      }
      throw new Error(`unexpected RPC method ${body.method}`);
    })
  );
}

function swapLeg(minOutAmount: string, quotedAmount = minOutAmount): HastraSwapLeg {
  return {
    instructions: [
      {
        programAddress: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        accounts: [{ address: OWNER, role: 3 }],
        data: "AA==",
      },
    ],
    lookupTableAddresses: ["9xQeWvG816bUx9EPfEZNeXhBCZDxwxVjC9LK9ZQHLuL7"],
    quotedAmount,
    minOutAmount,
    priceImpactPct: "0.001",
    routeLabels: ["Whirlpool"],
  };
}

function makeClient(port: Partial<HastraSwapPort> = {}) {
  const swapPort: HastraSwapPort = {
    quoteSwap: port.quoteSwap ?? (async () => ({ outAmount: "125", priceImpactPct: "0" })),
    buildSwapLeg: port.buildSwapLeg ?? (async () => swapLeg("120", "125")),
  };
  return new HastraVaultDirectClient(
    async () => "https://rpc.test",
    (_label, operation) => operation(() => {}),
    () => swapPort
  );
}

function instructionAmount(instruction: EarnVaultInstruction): bigint {
  return Buffer.from(instruction.data, "base64").readBigUInt64LE(8);
}

function event(name: string, fields: Buffer[]): string {
  return `Program data: ${Buffer.concat([disc("event", name), ...fields]).toString("base64")}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Hastra deposit", () => {
  it("quotes and builds one atomic USDC -> wYLDS -> PRIME transaction", async () => {
    const fixture = fixtureState();
    stubRpc(fixture.accounts);
    const client = makeClient();

    await expect(
      client.quoteVaultDeposit(CTX, { providerReference: DEPLOYMENT.primeMint, amount: "100" })
    ).resolves.toEqual({ sharesOut: "80", shareDecimals: 6, blockingIssues: [] });

    const plan = await client.buildVaultDeposit(CTX, {
      providerReference: DEPLOYMENT.primeMint,
      owner: OWNER,
      amount: "100.0",
      rentPayer: PAYER,
    });
    expect(plan.cluster).toBe("mainnet-beta");
    expect(plan.assetIdentity).toEqual({ depositTokenMint: USDC, shareMint: DEPLOYMENT.primeMint });
    expect(plan.accepted).toEqual({ amount: "100" });
    expect(plan.createsShareAccount).toBe(true);
    expect(plan.instructions.map((ix) => ix.programAddress)).toEqual([
      "ComputeBudget111111111111111111111111111111",
      ATA_PROGRAM,
      ATA_PROGRAM,
      DEPLOYMENT.vaultMintProgramAddress,
      DEPLOYMENT.vaultStakeProgramAddress,
    ]);
    expect(plan.instructions[1]?.accounts[0]).toEqual({ address: PAYER, role: 3 });
    expect(instructionAmount(plan.instructions[3] as EarnVaultInstruction)).toBe(100_000_000n);
    expect(instructionAmount(plan.instructions[4] as EarnVaultInstruction)).toBe(100_000_000n);
  });

  it("refuses a fictional on-chain deposit floor", async () => {
    const client = makeClient();
    await expect(
      client.buildVaultDeposit(CTX, {
        providerReference: DEPLOYMENT.primeMint,
        owner: OWNER,
        amount: "100",
        minSharesOut: "79",
      })
    ).rejects.toMatchObject({ code: "DEPOSIT_REFUSED" });
  });

  it("reports provider pauses and stale Chainlink state as quote blockers", async () => {
    const fixture = fixtureState({ mintPaused: true, stakePaused: true, stale: true });
    stubRpc(fixture.accounts);
    const quote = await makeClient().quoteVaultDeposit(CTX, {
      providerReference: DEPLOYMENT.primeMint,
      amount: "100",
    });
    expect(quote.blockingIssues.map((issue) => issue.code)).toEqual([
      "HASTRA_MINT_PAUSED",
      "HASTRA_STAKE_PAUSED",
      "HASTRA_PRICE_STALE",
    ]);
  });
});

describe("Hastra DEX withdrawal", () => {
  it("redeems PRIME to the exact quoted wYLDS input, then applies an explicit Jupiter floor", async () => {
    const fixture = fixtureState();
    fixture.accounts.set(ata(OWNER, DEPLOYMENT.primeMint), {
      owner: TOKEN_PROGRAM,
      data: tokenAccountData(DEPLOYMENT.primeMint, OWNER, 1_000_000_000n),
    });
    stubRpc(fixture.accounts);
    const quoteSwap = vi.fn(async ({ amount }: { amount: string }) => {
      expect(amount).toBe("125");
      return { outAmount: "124", priceImpactPct: "0.01" };
    });
    const buildSwapLeg = vi.fn(
      async (request: {
        amount: string;
        payer?: string;
        maxAccounts?: number;
        slippageBps: number;
      }) => {
        expect(request).toMatchObject({ amount: "125", payer: PAYER, maxAccounts: 20 });
        expect(request.slippageBps).toBe(322);
        return swapLeg("120.01", "124");
      }
    );
    const client = makeClient({ quoteSwap, buildSwapLeg });

    await expect(
      client.quoteVaultWithdrawal(CTX, { providerReference: DEPLOYMENT.primeMint, shares: "100" })
    ).resolves.toEqual({ assetsOut: "124", assetDecimals: 6, blockingIssues: [] });

    const plan = await client.buildVaultWithdrawal(CTX, {
      providerReference: DEPLOYMENT.primeMint,
      owner: OWNER,
      shares: "100",
      minAmountOut: "120",
      rentPayer: PAYER,
    });
    expect(plan.instructions.map((ix) => ix.programAddress)).toEqual([
      "ComputeBudget111111111111111111111111111111",
      ATA_PROGRAM,
      ATA_PROGRAM,
      "11111111111111111111111111111111",
      TOKEN_PROGRAM,
      DEPLOYMENT.vaultStakeProgramAddress,
      TOKEN_PROGRAM,
      TOKEN_PROGRAM,
      "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    ]);
    expect(Buffer.from(plan.instructions[0]?.data ?? "", "base64").readUInt32LE(1)).toBe(
      HASTRA_SWAP_COMPUTE_UNIT_LIMIT
    );
    expect(instructionAmount(plan.instructions[5] as EarnVaultInstruction)).toBe(100_000_000n);
    const transient = plan.instructions[5]?.accounts[6]?.address;
    expect(transient).toBeTruthy();
    expect(transient).not.toBe(ata(OWNER, DEPLOYMENT.wYldsMint));
    expect(plan.instructions[6]?.accounts.map((account) => account.address)).toEqual([
      transient,
      ata(OWNER, DEPLOYMENT.wYldsMint),
      OWNER,
    ]);
    expect(Buffer.from(plan.instructions[6]?.data ?? "", "base64").readBigUInt64LE(1)).toBe(
      125_000_000n
    );
    expect(Buffer.from(plan.instructions[7]?.data ?? "", "base64")[0]).toBe(9);
    expect(plan.accepted).toEqual({ shares: "100", minAmountOut: "120" });
    expect(plan.lookupTables).toEqual(["9xQeWvG816bUx9EPfEZNeXhBCZDxwxVjC9LK9ZQHLuL7"]);
  });

  it("requires a caller-selected output floor", async () => {
    await expect(
      makeClient().buildVaultWithdrawal(CTX, {
        providerReference: DEPLOYMENT.primeMint,
        owner: OWNER,
        shares: "1",
      })
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
  });

  it("refuses when Jupiter cannot guarantee the approved floor", async () => {
    const fixture = fixtureState();
    fixture.accounts.set(ata(OWNER, DEPLOYMENT.primeMint), {
      owner: TOKEN_PROGRAM,
      data: tokenAccountData(DEPLOYMENT.primeMint, OWNER, 1_000_000_000n),
    });
    stubRpc(fixture.accounts);
    const client = makeClient({
      quoteSwap: async () => ({ outAmount: "119", priceImpactPct: "0" }),
    });
    await expect(
      client.buildVaultWithdrawal(CTX, {
        providerReference: DEPLOYMENT.primeMint,
        owner: OWNER,
        shares: "100",
        minAmountOut: "120",
      })
    ).rejects.toMatchObject({ code: "WITHDRAW_REFUSED" });
  });

  it("isolates the live redeem output without consuming a pre-existing wYLDS balance", async () => {
    const fixture = fixtureState();
    fixture.accounts.set(ata(OWNER, DEPLOYMENT.primeMint), {
      owner: TOKEN_PROGRAM,
      data: tokenAccountData(DEPLOYMENT.primeMint, OWNER, 1_000_000_000n),
    });
    fixture.accounts.set(ata(OWNER, DEPLOYMENT.wYldsMint), {
      owner: TOKEN_PROGRAM,
      data: tokenAccountData(DEPLOYMENT.wYldsMint, OWNER, 1n),
    });
    stubRpc(fixture.accounts);

    const plan = await makeClient().buildVaultWithdrawal(CTX, {
      providerReference: DEPLOYMENT.primeMint,
      owner: OWNER,
      shares: "100",
      minAmountOut: "120",
    });
    expect(plan.instructions[5]?.accounts[6]?.address).not.toBe(ata(OWNER, DEPLOYMENT.wYldsMint));
    expect(plan.instructions[6]?.accounts[1]?.address).toBe(ata(OWNER, DEPLOYMENT.wYldsMint));
  });
});

describe("Hastra par redemption", () => {
  it("publishes the smallest PRIME amount that produces one wYLDS atom", async () => {
    const fixture = fixtureState();
    stubRpc(fixture.accounts);
    const client = makeClient();
    await expect(
      client.getParRedemptionOptions(CTX, { providerReference: DEPLOYMENT.primeMint })
    ).resolves.toEqual({
      intermediateMint: DEPLOYMENT.wYldsMint,
      assetMint: USDC,
      minimumShares: "0.000001",
      shareDecimals: 6,
      assetDecimals: 6,
      cancelable: true,
      operatorSettled: true,
    });
    expect(HASTRA_PAR_MINIMUM_ASSETS).toBe("0.000001");
  });

  it("quotes par value without enforcing Hastra's off-chain batching threshold", async () => {
    const fixture = fixtureState();
    stubRpc(fixture.accounts);
    const quote = await makeClient().quoteParRedemption(CTX, {
      providerReference: DEPLOYMENT.primeMint,
      shares: "100",
    });
    expect(quote).toMatchObject({
      shares: "100",
      intermediateAmount: "125",
      assets: "125",
      intermediateMint: DEPLOYMENT.wYldsMint,
      assetMint: USDC,
    });
    expect(quote.blockingIssues).toEqual([]);
  });

  it("atomically redeems PRIME to wYLDS and opens the one-per-owner request", async () => {
    const fixture = fixtureState();
    fixture.accounts.set(ata(OWNER, DEPLOYMENT.primeMint), {
      owner: TOKEN_PROGRAM,
      data: tokenAccountData(DEPLOYMENT.primeMint, OWNER, 2_000_000_000n),
    });
    stubRpc(fixture.accounts);
    const plan = await makeClient().buildParRedemptionRequest(CTX, {
      providerReference: DEPLOYMENT.primeMint,
      owner: OWNER,
      shares: "1600",
    });
    const request = pda(DEPLOYMENT.vaultMintProgramAddress, "redemption_request", key(OWNER))[0];
    expect(plan.requestAddress).toBe(request.toBase58());
    expect(plan.expectedRequest).toEqual({
      shares: "1600",
      intermediateMint: DEPLOYMENT.wYldsMint,
      intermediateAmount: "2000",
      assetMint: USDC,
      assets: "2000",
    });
    expect(plan.instructions.map((ix) => ix.programAddress)).toEqual([
      "ComputeBudget111111111111111111111111111111",
      ATA_PROGRAM,
      ATA_PROGRAM,
      "11111111111111111111111111111111",
      TOKEN_PROGRAM,
      DEPLOYMENT.vaultStakeProgramAddress,
      TOKEN_PROGRAM,
      TOKEN_PROGRAM,
      DEPLOYMENT.vaultMintProgramAddress,
    ]);
    expect(instructionAmount(plan.instructions[5] as EarnVaultInstruction)).toBe(1_600_000_000n);
    expect(instructionAmount(plan.instructions[8] as EarnVaultInstruction)).toBe(2_000_000_000n);
    expect(plan.instructions[5]?.accounts[6]?.address).not.toBe(ata(OWNER, DEPLOYMENT.wYldsMint));
    expect(plan.instructions[6]?.accounts[1]?.address).toBe(ata(OWNER, DEPLOYMENT.wYldsMint));
  });

  it("attributes each persistent output ATA's rent on the plan only when it is newly created", async () => {
    const fixture = fixtureState();
    fixture.accounts.set(ata(OWNER, DEPLOYMENT.primeMint), {
      owner: TOKEN_PROGRAM,
      data: tokenAccountData(DEPLOYMENT.primeMint, OWNER, 2_000_000_000n),
    });
    // The owner holds neither persistent output account, so both idempotent
    // creates charge real rent to the sponsor and the plan must name each
    // created account and its funder for the queued lifecycle to refund.
    fixture.accounts.delete(ata(OWNER, USDC));
    stubRpc(fixture.accounts);
    const plan = await makeClient().buildParRedemptionRequest(CTX, {
      providerReference: DEPLOYMENT.primeMint,
      owner: OWNER,
      shares: "1600",
      rentPayer: PAYER,
    });
    expect(plan.createdOutputAtas).toEqual([
      {
        mint: DEPLOYMENT.wYldsMint,
        address: ata(OWNER, DEPLOYMENT.wYldsMint),
        rentFunder: PAYER,
      },
      { mint: USDC, address: ata(OWNER, USDC), rentFunder: PAYER },
    ]);
    // The charged creates build owner-owned persistent accounts, exactly the
    // partner-funded state whose rent the queued lifecycle must attribute.
    expect(plan.instructions[2]?.accounts[0]).toEqual({ address: PAYER, role: 3 });
    expect(plan.instructions[2]?.accounts[1]?.address).toBe(ata(OWNER, DEPLOYMENT.wYldsMint));
    expect(plan.instructions[2]?.accounts[2]?.address).toBe(OWNER);
    expect(plan.instructions[3]?.accounts[0]).toEqual({ address: PAYER, role: 3 });
    expect(plan.instructions[3]?.accounts[1]?.address).toBe(ata(OWNER, USDC));
    expect(plan.instructions[3]?.accounts[2]?.address).toBe(OWNER);
  });

  it("omits output-ATA attribution when both persistent output accounts already exist", async () => {
    const fixture = fixtureState();
    fixture.accounts.set(ata(OWNER, DEPLOYMENT.primeMint), {
      owner: TOKEN_PROGRAM,
      data: tokenAccountData(DEPLOYMENT.primeMint, OWNER, 2_000_000_000n),
    });
    fixture.accounts.set(ata(OWNER, DEPLOYMENT.wYldsMint), {
      owner: TOKEN_PROGRAM,
      data: tokenAccountData(DEPLOYMENT.wYldsMint, OWNER, 1n),
    });
    stubRpc(fixture.accounts);
    const plan = await makeClient().buildParRedemptionRequest(CTX, {
      providerReference: DEPLOYMENT.primeMint,
      owner: OWNER,
      shares: "1600",
      rentPayer: PAYER,
    });
    // Both idempotent creates are no-ops here, so no rent was charged and the
    // plan must not claim an attribution that could route a false refund.
    expect(plan.createdOutputAtas).toBeUndefined();
  });

  it("charges a sponsored rent payer for the creates and pre-funds the owner's request rent", async () => {
    const fixture = fixtureState();
    fixture.accounts.set(ata(OWNER, DEPLOYMENT.primeMint), {
      owner: TOKEN_PROGRAM,
      data: tokenAccountData(DEPLOYMENT.primeMint, OWNER, 2_000_000_000n),
    });
    stubRpc(fixture.accounts);
    const plan = await makeClient().buildParRedemptionRequest(CTX, {
      providerReference: DEPLOYMENT.primeMint,
      owner: OWNER,
      shares: "1600",
      rentPayer: PAYER,
    });
    // One System transfer of the request account's live rent, sponsor -> owner.
    expect(plan.instructions[1]?.programAddress).toBe("11111111111111111111111111111111");
    expect(plan.instructions[1]?.accounts).toEqual([
      { address: PAYER, role: 3 },
      { address: OWNER, role: 1 },
    ]);
    expect(Buffer.from(plan.instructions[1]?.data ?? "", "base64").readBigUInt64LE(4)).toBe(
      2_039_280n
    );
    // The builder-controlled creates and the transient account charge the sponsor...
    expect(plan.instructions[2]?.accounts[0]).toEqual({ address: PAYER, role: 3 });
    expect(plan.instructions[3]?.accounts[0]).toEqual({ address: PAYER, role: 3 });
    expect(plan.instructions[4]?.accounts[0]).toEqual({ address: PAYER, role: 3 });
    // ...while the program-hardcoded request payer stays the owner.
    const request = plan.instructions.at(-1);
    expect(request?.accounts[0]).toEqual({ address: OWNER, role: 3 });
    expect(instructionAmount(request as EarnVaultInstruction)).toBe(2_000_000_000n);
  });

  it("delegates only the isolated live output when canonical wYLDS already exists", async () => {
    const fixture = fixtureState();
    fixture.accounts.set(ata(OWNER, DEPLOYMENT.primeMint), {
      owner: TOKEN_PROGRAM,
      data: tokenAccountData(DEPLOYMENT.primeMint, OWNER, 2_000_000_000n),
    });
    fixture.accounts.set(ata(OWNER, DEPLOYMENT.wYldsMint), {
      owner: TOKEN_PROGRAM,
      data: tokenAccountData(DEPLOYMENT.wYldsMint, OWNER, 1n),
    });
    stubRpc(fixture.accounts);

    const plan = await makeClient().buildParRedemptionRequest(CTX, {
      providerReference: DEPLOYMENT.primeMint,
      owner: OWNER,
      shares: "1600",
    });
    expect(plan.instructions[5]?.accounts[6]?.address).not.toBe(ata(OWNER, DEPLOYMENT.wYldsMint));
    expect(plan.instructions[6]?.accounts[1]?.address).toBe(ata(OWNER, DEPLOYMENT.wYldsMint));
    expect(instructionAmount(plan.instructions[8] as EarnVaultInstruction)).toBe(2_000_000_000n);
  });

  it("waits beyond the recent-blockhash window before reusing an owner request PDA", async () => {
    const fixture = fixtureState();
    fixture.accounts.set(ata(OWNER, DEPLOYMENT.primeMint), {
      owner: TOKEN_PROGRAM,
      data: tokenAccountData(DEPLOYMENT.primeMint, OWNER, 2_000_000_000n),
    });
    const closingBlockHeight = 1_000;
    stubRpc(fixture.accounts, {
      latestSlot: 900,
      closingBlockHeight,
      currentBlockHeight: closingBlockHeight + HASTRA_REQUEST_REUSE_COOLDOWN_BLOCKS,
    });
    const client = makeClient();
    const input = {
      providerReference: DEPLOYMENT.primeMint,
      owner: OWNER,
      shares: "1600",
    };

    await expect(client.buildParRedemptionRequest(CTX, input)).rejects.toMatchObject({
      code: "REDEMPTION_REFUSED",
    });

    stubRpc(fixture.accounts, {
      latestSlot: 900,
      closingBlockHeight,
      currentBlockHeight: closingBlockHeight + HASTRA_REQUEST_REUSE_COOLDOWN_BLOCKS + 1,
    });
    await expect(client.buildParRedemptionRequest(CTX, input)).resolves.toMatchObject({
      expectedRequest: { shares: "1600", intermediateAmount: "2000" },
    });
  });

  it("does not reuse a request while its confirmed close is still awaiting finality", async () => {
    const fixture = fixtureState();
    fixture.accounts.set(ata(OWNER, DEPLOYMENT.primeMint), {
      owner: TOKEN_PROGRAM,
      data: tokenAccountData(DEPLOYMENT.primeMint, OWNER, 2_000_000_000n),
    });
    stubRpc(fixture.accounts, {
      latestSlot: 900,
      closingBlockHeight: 1_000,
      currentBlockHeight: 2_000,
      finalizedRequest: {
        owner: DEPLOYMENT.vaultMintProgramAddress,
        data: Buffer.alloc(1),
      },
    });

    await expect(
      makeClient().buildParRedemptionRequest(CTX, {
        providerReference: DEPLOYMENT.primeMint,
        owner: OWNER,
        shares: "1600",
      })
    ).rejects.toMatchObject({ code: "REDEMPTION_REFUSED" });
  });

  it("ignores unrelated and failed address-history entries when proving first use", async () => {
    const fixture = fixtureState();
    fixture.accounts.set(ata(OWNER, DEPLOYMENT.primeMint), {
      owner: TOKEN_PROGRAM,
      data: tokenAccountData(DEPLOYMENT.primeMint, OWNER, 2_000_000_000n),
    });
    const input = {
      providerReference: DEPLOYMENT.primeMint,
      owner: OWNER,
      shares: "1600",
    };
    for (const lifecycle of ["unrelated", "failed"] as const) {
      stubRpc(fixture.accounts, {
        latestSlot: 900,
        closingBlockHeight: 1_000,
        currentBlockHeight: 1_001,
        lifecycle,
      });
      await expect(makeClient().buildParRedemptionRequest(CTX, input)).resolves.toMatchObject({
        expectedRequest: { shares: "1600", intermediateAmount: "2000" },
      });
    }
  });

  it("fails closed when successful request history cannot be authenticated", async () => {
    const fixture = fixtureState();
    fixture.accounts.set(ata(OWNER, DEPLOYMENT.primeMint), {
      owner: TOKEN_PROGRAM,
      data: tokenAccountData(DEPLOYMENT.primeMint, OWNER, 2_000_000_000n),
    });
    const input = {
      providerReference: DEPLOYMENT.primeMint,
      owner: OWNER,
      shares: "1600",
    };
    for (const lifecycle of ["missing-err", "unavailable", "missing-logs"] as const) {
      stubRpc(fixture.accounts, {
        latestSlot: 900,
        closingBlockHeight: 1_000,
        currentBlockHeight: 2_000,
        lifecycle,
      });
      await expect(makeClient().buildParRedemptionRequest(CTX, input)).rejects.toMatchObject({
        code: "REQUEST_UNREADABLE",
      });
    }
  });

  it("reads and cancels an open request without applying pause or oracle gates", async () => {
    const fixture = fixtureState({ mintPaused: true, stakePaused: true, stale: true });
    const [request, bump] = pda(
      DEPLOYMENT.vaultMintProgramAddress,
      "redemption_request",
      key(OWNER)
    );
    fixture.accounts.set(request.toBase58(), {
      owner: DEPLOYMENT.vaultMintProgramAddress,
      data: Buffer.concat([
        disc("account", "RedemptionRequest"),
        key(OWNER),
        u64(2_000_000_000n),
        key(DEPLOYMENT.wYldsMint),
        Buffer.from([bump]),
      ]),
    });
    stubRpc(fixture.accounts);
    const client = makeClient();
    await expect(
      client.readParRedemptionRequest(CTX, {
        providerReference: DEPLOYMENT.primeMint,
        requestAddress: request.toBase58(),
      })
    ).resolves.toMatchObject({
      status: "pending",
      request: { owner: OWNER, intermediateAmount: "2000" },
    });
    const cancel = await client.buildParRedemptionCancel(CTX, {
      providerReference: DEPLOYMENT.primeMint,
      owner: OWNER,
      requestAddress: request.toBase58(),
    });
    expect(cancel.instructions.map((ix) => ix.programAddress)).toEqual([
      ATA_PROGRAM,
      DEPLOYMENT.vaultMintProgramAddress,
    ]);
    expect(Buffer.from(cancel.instructions[1]?.data ?? "", "base64").subarray(0, 8)).toEqual(
      disc("global", "cancel_redeem")
    );
  });

  it("accepts only lifecycle events emitted in the pinned vault-mint invocation", async () => {
    const request = pda(
      DEPLOYMENT.vaultMintProgramAddress,
      "redemption_request",
      key(OWNER)
    )[0].toBase58();
    const requested = event("RedemptionRequested", [
      key(OWNER),
      u64(2_000_000_000n),
      key(USDC),
      key(DEPLOYMENT.wYldsMint),
    ]);
    const fulfilled = event("RedeemCompleted", [
      key(OWNER),
      key(PAYER),
      u64(2_000_000_000n),
      key(DEPLOYMENT.wYldsMint),
      key(USDC),
    ]);
    const logs = [
      `Program ${FOREIGN_PROGRAM} invoke [1]`,
      requested,
      `Program ${FOREIGN_PROGRAM} success`,
      `Program ${DEPLOYMENT.vaultMintProgramAddress} invoke [1]`,
      requested,
      `Program ${FOREIGN_PROGRAM} invoke [2]`,
      fulfilled,
      `Program ${FOREIGN_PROGRAM} success`,
      fulfilled,
      `Program ${DEPLOYMENT.vaultMintProgramAddress} success`,
    ];
    await expect(
      makeClient().decodeParRedemptionLifecycleEvents(CTX, {
        providerReference: DEPLOYMENT.primeMint,
        requestAddress: request,
        logs,
        blockTime: "1800000100",
        shareDecimals: 6,
        assetDecimals: 6,
      })
    ).resolves.toEqual([
      {
        kind: "redemptionRequested",
        requestAddress: request,
        owner: OWNER,
        intermediateMint: DEPLOYMENT.wYldsMint,
        intermediateAmount: "2000",
        occurredAt: "1800000100",
      },
      {
        kind: "redemptionFulfilled",
        requestAddress: request,
        owner: OWNER,
        intermediateMint: DEPLOYMENT.wYldsMint,
        intermediateAmount: "2000",
        assetsPaid: "2000",
        occurredAt: "1800000100",
      },
    ]);
  });

  it("decodes cancellation and refuses to invent a timestamp for a real event", async () => {
    const request = pda(
      DEPLOYMENT.vaultMintProgramAddress,
      "redemption_request",
      key(OWNER)
    )[0].toBase58();
    const cancelled = event("RedemptionCancelled", [
      key(OWNER),
      u64(50_000_000n),
      key(DEPLOYMENT.wYldsMint),
      key(USDC),
    ]);
    const logs = [
      `Program ${DEPLOYMENT.vaultMintProgramAddress} invoke [1]`,
      cancelled,
      `Program ${DEPLOYMENT.vaultMintProgramAddress} success`,
    ];
    const input = {
      providerReference: DEPLOYMENT.primeMint,
      requestAddress: request,
      logs,
      blockTime: "1800000200",
      shareDecimals: 6,
      assetDecimals: 6,
    } as const;
    await expect(makeClient().decodeParRedemptionLifecycleEvents(CTX, input)).resolves.toEqual([
      {
        kind: "redemptionCancelled",
        requestAddress: request,
        owner: OWNER,
        intermediateMint: DEPLOYMENT.wYldsMint,
        intermediateAmount: "50",
        occurredAt: "1800000200",
      },
    ]);
    await expect(
      makeClient().decodeParRedemptionLifecycleEvents(CTX, { ...input, blockTime: null })
    ).rejects.toMatchObject({ code: "REQUEST_UNREADABLE" });
  });
});

describe("Hastra positions and deployment guardrails", () => {
  it("reads the canonical PRIME account and values it at Hastra's par rate", async () => {
    const fixture = fixtureState();
    fixture.accounts.set(ata(OWNER, DEPLOYMENT.primeMint), {
      owner: TOKEN_PROGRAM,
      data: tokenAccountData(DEPLOYMENT.primeMint, OWNER, 100_000_000n),
    });
    stubRpc(fixture.accounts);
    await expect(
      makeClient().readVaultPositions(CTX, { owner: OWNER, providerReferences: [] })
    ).resolves.toEqual([
      {
        providerReference: DEPLOYMENT.primeMint,
        owner: OWNER,
        cluster: "mainnet-beta",
        shares: "100",
        withdrawableShares: "100",
        tokenValue: "125",
        tokenMint: USDC,
        shareMint: DEPLOYMENT.primeMint,
      },
    ]);
  });

  it("keeps frozen PRIME in holdings without claiming it is withdrawable", async () => {
    const fixture = fixtureState();
    fixture.accounts.set(ata(OWNER, DEPLOYMENT.primeMint), {
      owner: TOKEN_PROGRAM,
      data: tokenAccountData(DEPLOYMENT.primeMint, OWNER, 100_000_000n, true),
    });
    stubRpc(fixture.accounts);
    const [position] = await makeClient().readVaultPositions(CTX, {
      owner: OWNER,
      providerReferences: [DEPLOYMENT.primeMint],
    });
    expect(position).toMatchObject({ shares: "100", withdrawableShares: "0", tokenValue: "125" });
  });

  it("fails closed in sandbox because Hastra has no verified devnet deployment", async () => {
    await expect(
      makeClient().readVaultPositions(
        { env: {}, environment: "sandbox" },
        { owner: OWNER, providerReferences: [] }
      )
    ).rejects.toMatchObject({ code: "DEPLOYMENT_NOT_CONFIGURED" });
  });

  it("rejects live config identity drift before emitting instructions", async () => {
    const fixture = fixtureState();
    const configAccount = fixture.accounts.get(fixture.addresses.mintConfig);
    if (!configAccount) throw new Error("fixture premise");
    key(DEPLOYMENT.primeMint).copy(configAccount.data, 8); // corrupt configured USDC mint
    stubRpc(fixture.accounts);
    await expect(
      makeClient().buildVaultDeposit(CTX, {
        providerReference: DEPLOYMENT.primeMint,
        owner: OWNER,
        amount: "100",
      })
    ).rejects.toMatchObject({ code: "PROGRAM_MISMATCH" });
  });
});
