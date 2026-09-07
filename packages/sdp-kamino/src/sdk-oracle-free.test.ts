import { type Address, address, type TransactionSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildKaminoDepositPlan, buildKaminoWithdrawPlan, readKaminoPosition } from "./sdk";

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
      }
    ) {
      this.address = reserveAddress;
      this.state = state;
      this.tokenOraclePrice = tokenOraclePrice;
      mocks.stateOnlyOracles.push(tokenOraclePrice);
    }

    getEstimatedCollateralExchangeRate() {
      return this.tokenOraclePrice.decimals.div(6);
    }

    getFreelyAvailableLiquidityAmount() {
      return this.tokenOraclePrice.decimals.mul(1_000_000);
    }
  }

  class BoundVault {
    readonly address: Address;
    readonly programId: Address;

    constructor(_rpc: unknown, vaultAddress: Address, _state: unknown, programId: Address) {
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
  };
});

vi.mock("./lookup-table", () => ({ loadVaultLookupTableAddresses: vi.fn(async () => ({})) }));
vi.mock("./rpc", () => ({ createKaminoRpc: mocks.createKaminoRpc }));

function integer(value: number) {
  return {
    gt: () => false,
    isZero: () => value === 0,
    lt: () => false,
    toNumber: () => value,
    toString: () => String(value),
  };
}

const state = {
  baseVaultAuthority: VAULT,
  managementFeeBps: integer(0),
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
  vaultAllocationStrategy: [{ ctokenAllocation: integer(0), reserve: RESERVE }],
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
  };
  mocks.createKaminoRpc.mockReturnValue(mocks.rpc);
  mocks.fetchGlobalConfig.mockResolvedValue({
    withdrawalPenaltyBps: "0",
    withdrawalPenaltyLamports: "0",
  });
  mocks.fetchReserveStates.mockResolvedValue([reserveState]);
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
  it("executes the pinned SDK deposit builder with state-only reserves", async () => {
    const plan = await buildKaminoDepositPlan(runtime, { amount: "1", owner, vault: VAULT });

    expect(plan.accepted).toEqual({ amount: "1" });
    expect(plan.instructions.length).toBeGreaterThan(0);
    expect(mocks.stateOnlyOracles).toHaveLength(1);
    expect(mocks.stateOnlyOracles[0]?.valid).toBe(false);
  });

  it("executes the pinned SDK withdrawal builder with state-only reserves", async () => {
    const plan = await buildKaminoWithdrawPlan(runtime, {
      owner,
      shares: "1",
      slot: 123n,
      vault: VAULT,
    });

    expect(plan.accepted).toEqual({ shares: "1" });
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
