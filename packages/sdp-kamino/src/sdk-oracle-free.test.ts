import { type Address, address, type TransactionSigner } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { kaminoClusterConfig } from "./programs";
import {
  buildKaminoDepositPlan,
  buildKaminoWithdrawPlan,
  quoteKaminoDeposit,
  quoteKaminoWithdraw,
  readKaminoPosition,
} from "./sdk";
import { isShareAtaCloseInstruction } from "./withdraw-instructions";

const VAULT = address("7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx");
const OWNER = address("11111111111111111111111111111112");
const RESERVE = address("So11111111111111111111111111111111111111112");
const DEPOSIT_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SHARE_MINT = address("So11111111111111111111111111111111111111112");
const LENDING_MARKET = address("11111111111111111111111111111113");

type DecimalLike = {
  div(value: unknown): DecimalLike;
  mul(value: unknown): DecimalLike;
};

const mocks = vi.hoisted(() => ({
  createKaminoRpc: vi.fn(),
  fetchGlobalConfig: vi.fn(),
  fetchReserveStates: vi.fn(),
  fetchMarketStates: vi.fn(),
  constructReserve: vi.fn(),
  constructProbe: vi.fn(),
  sendBlockTime: vi.fn(),
  collateralInstant: vi.fn(),
  getState: vi.fn(),
  getUserShares: vi.fn(),
  getUserSharesState: vi.fn(),
  rpc: {} as Record<string, unknown>,
  sendTokenAccounts: vi.fn(),
  stateOnlyOracles: [] as Array<{
    decimals: DecimalLike;
    readonly price: unknown;
    valid: boolean;
  }>,
}));

vi.mock("@kamino-finance/klend-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kamino-finance/klend-sdk")>();

  class StateOnlyReserve {
    static cTokensToLiquidity(amount: DecimalLike, exchangeRate: unknown) {
      return amount.mul(exchangeRate);
    }

    readonly address: Address;
    readonly state: unknown;
    readonly tokenOraclePrice: {
      decimals: DecimalLike;
      readonly price: unknown;
      valid: boolean;
    };

    constructor(
      state: unknown,
      reserveAddress: Address,
      tokenOraclePrice: {
        decimals: DecimalLike;
        readonly price: unknown;
        valid: boolean;
      },
      rpc: unknown,
      slotDurationMs: number,
      rewardsMaxAprBps: number,
      scaledMultiplier: unknown,
      programId: Address
    ) {
      mocks.constructReserve(rpc, slotDurationMs, rewardsMaxAprBps, scaledMultiplier, programId);
      this.address = reserveAddress;
      this.state = state;
      this.tokenOraclePrice = tokenOraclePrice;
      mocks.stateOnlyOracles.push(tokenOraclePrice);
    }

    getEstimatedCollateralExchangeRate(ledgerInstant: unknown) {
      mocks.collateralInstant(ledgerInstant);
      return this.tokenOraclePrice.decimals.div(6);
    }

    getFreelyAvailableLiquidityAmount() {
      return this.tokenOraclePrice.decimals.mul(1_000_000);
    }
  }

  class BoundVault {
    readonly address: Address;
    readonly programId: Address;

    constructor(
      rpc: unknown,
      vaultAddress: Address,
      slotDurationMs: number,
      state: unknown,
      programId: Address
    ) {
      mocks.constructProbe(rpc, vaultAddress, slotDurationMs, state, programId);
      this.address = vaultAddress;
      this.programId = programId;
    }

    static loadWithClientAndState(client: object, vaultAddress: Address, state: object) {
      const bound = Object.assign(Object.create(actual.KaminoVault.prototype), {
        address: vaultAddress,
        client,
        getUserShares: (...args: unknown[]) => mocks.getUserShares(...args),
        programId: Reflect.get(client, "getProgramID").call(client),
        state,
      });
      Reflect.set(client, "getUserSharesState", (...args: unknown[]) =>
        mocks.getUserSharesState(...args)
      );
      return bound;
    }

    getState(...args: unknown[]) {
      return mocks.getState(...args);
    }
  }

  return {
    ...actual,
    KaminoReserve: StateOnlyReserve,
    KaminoVault: BoundVault,
    KVaultGlobalConfig: { fetch: mocks.fetchGlobalConfig },
    Reserve: { fetchMultiple: mocks.fetchReserveStates },
    LendingMarket: { fetchMultiple: mocks.fetchMarketStates },
  };
});

vi.mock("./lookup-table", () => ({ loadVaultLookupTableAddresses: vi.fn(async () => ({})) }));
vi.mock("./rpc", () => ({ createKaminoRpc: mocks.createKaminoRpc }));

function integer(value: number) {
  return {
    gt: () => false,
    gtn: (other: number) => value > other,
    isZero: () => value === 0,
    lt: () => false,
    toNumber: () => value,
    toString: () => String(value),
  };
}

const state = {
  baseVaultAuthority: VAULT,
  managementFeeBps: integer(0),
  lastFeeChargeTimestamp: integer(1_700_000_000),
  crankFundFeePerReserve: integer(0),
  depositCap: integer(2_000_000),
  minDepositAmount: integer(0),
  minWithdrawAmount: integer(0),
  rewardInfo: {
    rewardPerSecond: integer(10_000),
    rewardsAvailable: integer(100_000),
    lastIssuanceTs: integer(1_699_999_995),
  },
  pendingFeesSf: integer(0),
  performanceFeeBps: integer(0),
  sharesIssued: integer(1_000_000),
  sharesMint: SHARE_MINT,
  sharesMintDecimals: integer(6),
  tokenAvailable: integer(1_500_000),
  tokenMint: DEPOSIT_MINT,
  tokenMintDecimals: integer(6),
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
  tokenVault: VAULT,
  vaultAllocationStrategy: [
    {
      ctokenAllocation: integer(0),
      reserve: RESERVE,
      targetAllocationWeight: integer(1),
      tokenAllocationCap: integer(2_000_000),
    },
  ],
  withdrawalPenaltyBps: "0",
  withdrawalPenaltyLamports: "0",
};
const reserveState = {
  collateral: { mintPubkey: SHARE_MINT },
  config: { protocolTakeRatePct: 0 },
  lendingMarket: LENDING_MARKET,
  liquidity: {
    absoluteReferralRateSf: integer(0),
    mintDecimals: 6,
    mintPubkey: DEPOSIT_MINT,
    supplyVault: VAULT,
  },
};
const tokenAccounts = {
  value: [
    {
      pubkey: OWNER,
      account: { data: { parsed: { info: { tokenAmount: { amount: "1000000" } } } } },
    },
  ],
};
const owner = { address: OWNER } as TransactionSigner;
const runtime = { cluster: "devnet" as const, rpcUrl: "https://devnet.example.invalid" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stateOnlyOracles.length = 0;
  mocks.rpc = {
    getTokenAccountsByOwner: vi.fn(() => ({ send: mocks.sendTokenAccounts })),
    getBlockTime: vi.fn(() => ({ send: mocks.sendBlockTime })),
  };
  mocks.createKaminoRpc.mockReturnValue(mocks.rpc);
  mocks.fetchGlobalConfig.mockResolvedValue({
    withdrawalPenaltyBps: "0",
    withdrawalPenaltyLamports: "0",
  });
  mocks.fetchReserveStates.mockResolvedValue([reserveState]);
  mocks.fetchMarketStates.mockResolvedValue([{ reserveRewardsMaxAprBps: 275 }]);
  mocks.sendBlockTime.mockResolvedValue(1_700_000_000n);
  mocks.getState.mockResolvedValue(state);
  mocks.getUserShares.mockResolvedValue({ stakedShares: "0" });
  mocks.getUserSharesState.mockImplementation(() => {
    const one = mocks.stateOnlyOracles[0]?.decimals.div(6);
    if (!one) throw new Error("state-only reserve must load before the share-state read");
    return {
      ataBalance: one,
      farmBalance: one.mul(0),
      totalShares: one,
      userSharesAta: OWNER,
    };
  });
  mocks.sendTokenAccounts.mockResolvedValue(tokenAccounts);
});

describe("oracle-free Kamino SDK execution", () => {
  it("refuses a withdrawal when its selected slot has no block time", async () => {
    mocks.sendBlockTime.mockResolvedValue(null);
    await expect(
      buildKaminoWithdrawPlan(runtime, { owner, shares: "1", slot: 123n, vault: VAULT })
    ).rejects.toMatchObject({ code: "VAULT_UNREADABLE" });
  });

  it("keeps exact shares but withholds value when block time is unavailable", async () => {
    mocks.sendBlockTime.mockResolvedValue(null);
    const position = await readKaminoPosition(runtime, { owner: OWNER, slot: 123n, vault: VAULT });
    expect(position.shares).toBe("1");
    expect(position).not.toHaveProperty("tokenValue");
  });

  it.each([null, {}, { reserveRewardsMaxAprBps: -1 }])(
    "refuses construction with unreadable lending-market rewards: %s",
    async (market) => {
      mocks.fetchMarketStates.mockResolvedValue([market]);
      await expect(
        buildKaminoDepositPlan(runtime, { amount: "1", owner, vault: VAULT })
      ).rejects.toMatchObject({ code: "VAULT_UNREADABLE" });
    }
  );

  it("quotes deposits with rewards vested at the selected block time", async () => {
    const quote = await quoteKaminoDeposit(runtime, { amount: "0.4", slot: 123n, vault: VAULT });
    expect(quote).toMatchObject({ sharesOut: "0.258064" });
    expect(mocks.rpc.getBlockTime).toHaveBeenCalledWith(123n);
    expect(mocks.collateralInstant).toHaveBeenCalledWith({ slot: 123n, blockTime: 1_700_000_000n });
  });

  it("reports a deposit-cap clamp using the same block-time rewards as the SDK", async () => {
    const quote = await quoteKaminoDeposit(runtime, { amount: "1", slot: 123n, vault: VAULT });
    expect(quote.sharesOut).toBe("0.290322");
    expect(quote.issues).toContainEqual(expect.objectContaining({ code: "DEPOSIT_CAP_EXCEEDED" }));
  });

  it("quotes withdrawals using the same ledger instant as reserve accrual", async () => {
    const quote = await quoteKaminoWithdraw(runtime, { shares: "0.5", slot: 123n, vault: VAULT });
    expect(quote).toMatchObject({ assetsOut: "0.75" });
    expect(mocks.rpc.getBlockTime).toHaveBeenCalledWith(123n);
    expect(mocks.collateralInstant).toHaveBeenCalledWith({ slot: 123n, blockTime: 1_700_000_000n });
  });
  it("executes the pinned SDK deposit builder with state-only reserves", async () => {
    const plan = await buildKaminoDepositPlan(runtime, { amount: "1", owner, vault: VAULT });

    expect(plan.accepted).toEqual({ amount: "1" });
    const config = kaminoClusterConfig("devnet");
    expect(mocks.constructProbe).toHaveBeenCalledWith(
      mocks.rpc,
      VAULT,
      config.slotDurationMs,
      undefined,
      config.kvaultProgramId
    );
    expect(mocks.fetchMarketStates).toHaveBeenCalledWith(
      mocks.rpc,
      [LENDING_MARKET],
      config.klendProgramId
    );
    expect(mocks.constructReserve).toHaveBeenCalledWith(
      mocks.rpc,
      config.slotDurationMs,
      275,
      undefined,
      config.klendProgramId
    );
    expect(plan.instructions.length).toBeGreaterThan(0);
    expect(mocks.stateOnlyOracles).toHaveLength(1);
    expect(mocks.stateOnlyOracles[0]?.valid).toBe(false);
  });

  /**
   * Kamino's devnet kvault build has no `deposit_with_min_shares_out`, and the
   * SDK emits exactly that for any `minSharesOut`. The refusal must land before
   * a single read: the chain's own answer (Anchor 101) would arrive only after
   * the caller had been shown a floor, and as a 400 the API can relay verbatim.
   */
  it("refuses a share floor on devnet before touching the RPC", async () => {
    await expect(
      buildKaminoDepositPlan(runtime, { amount: "1", owner, vault: VAULT, minSharesOut: "0.9" })
    ).rejects.toMatchObject({
      name: "SdpKaminoError",
      code: "DEPOSIT_REFUSED",
      message: expect.stringContaining("devnet vault program cannot enforce a share floor"),
    });
    expect(mocks.createKaminoRpc).not.toHaveBeenCalled();
    expect(mocks.getState).not.toHaveBeenCalled();
  });

  it("executes the pinned SDK withdrawal builder with state-only reserves", async () => {
    const plan = await buildKaminoWithdrawPlan(runtime, {
      owner,
      shares: "1",
      slot: 123n,
      vault: VAULT,
    });

    expect(plan.accepted).toEqual({ shares: "1" });
    expect(mocks.rpc.getBlockTime).toHaveBeenCalledWith(123n);
    expect(mocks.collateralInstant).toHaveBeenCalledWith({ slot: 123n, blockTime: 1_700_000_000n });
    expect(plan.instructions.length).toBeGreaterThan(0);
    expect(mocks.stateOnlyOracles).toHaveLength(1);
    expect(mocks.stateOnlyOracles[0]?.valid).toBe(false);
  });

  it("executes pinned token-per-share math without reading an oracle price", async () => {
    await expect(
      readKaminoPosition(runtime, { owner: OWNER, slot: 123n, vault: VAULT })
    ).resolves.toMatchObject({ shares: "1", tokenValue: "1.5", withdrawableShares: "1" });

    expect(mocks.stateOnlyOracles).toHaveLength(1);
    expect(mocks.stateOnlyOracles[0]?.valid).toBe(false);
  });

  it("retains an ATA created during consolidation even with a refund hint", async () => {
    const rentPayer = { address: LENDING_MARKET } as TransactionSigner;
    const plan = await buildKaminoWithdrawPlan(runtime, {
      owner,
      shares: "1",
      slot: 123n,
      vault: VAULT,
      rentPayer,
      rentRefundTo: VAULT,
    });
    const [shareAta] = await findAssociatedTokenPda({
      owner: OWNER,
      mint: SHARE_MINT,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    expect(plan.createsShareAccount).toBe(true);
    expect(
      plan.instructions.some((instruction) => isShareAtaCloseInstruction(instruction, shareAta))
    ).toBe(false);
  });

  it("strips SDK cleanup and ignores refund hints for an existing ATA", async () => {
    const [shareAta] = await findAssociatedTokenPda({
      owner: OWNER,
      mint: SHARE_MINT,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    mocks.sendTokenAccounts.mockResolvedValue({
      value: [{ ...tokenAccounts.value[0], pubkey: shareAta }],
    });
    const plan = await buildKaminoWithdrawPlan(runtime, {
      owner,
      shares: "1",
      slot: 123n,
      vault: VAULT,
      rentRefundTo: LENDING_MARKET,
    });
    expect(plan.createsShareAccount).toBe(false);
    expect(
      plan.instructions.some((instruction) => isShareAtaCloseInstruction(instruction, shareAta))
    ).toBe(false);
  });

  it("keeps the state-only oracle fail-closed if an SDK path tries to price", async () => {
    await buildKaminoDepositPlan(runtime, { amount: "1", owner, vault: VAULT });

    let thrown: unknown;
    try {
      mocks.stateOnlyOracles[0]?.price;
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toMatchObject({
      code: "VAULT_UNREADABLE",
      cause: expect.stringMatching(/state-only reserve access attempted to price reserve/),
    });
  });
});
