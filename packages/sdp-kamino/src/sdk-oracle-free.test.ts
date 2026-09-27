import { type Address, address, type TransactionSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildKaminoDepositPlan,
  buildKaminoWithdrawPlan,
  quoteKaminoWithdraw,
  readKaminoPosition,
} from "./sdk";

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
  freelyAvailableLiquidity: 1_000_000,
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
      return this.tokenOraclePrice.decimals.mul(mocks.freelyAvailableLiquidity);
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
  minWithdrawAmount: integer(0),
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
  mocks.freelyAvailableLiquidity = 1_000_000;
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

  /**
   * SOLA9-516 regression: the position read used to report the whole unstaked
   * balance as `withdrawableShares` without consulting the same liquidity-aware
   * exit plan the quote uses, so the dashboard could present a full exit as
   * immediately available while the executable plan covered only part of it.
   * The vault here holds 0.5 idle tokens plus a reserve allocation whose
   * freely withdrawable liquidity is 0.6, against 1 share priced at 1.5
   * tokens: the plan can execute 1.099999 of the 1.5 the full exit needs, so
   * the ceiling must be the largest share quantity whose own plan is fully
   * coverable — 733333 base units, exactly `floor(1099999 / 1.5)` — never the
   * full balance.
   */
  it("caps withdrawableShares at the exit liquidity the vault can actually execute", async () => {
    mocks.getState.mockResolvedValue({
      ...state,
      tokenAvailable: integer(500_000),
      vaultAllocationStrategy: [{ ctokenAllocation: integer(1_000_000), reserve: RESERVE }],
    });
    mocks.freelyAvailableLiquidity = 100_000;

    await expect(
      readKaminoPosition(runtime, { owner: OWNER, slot: 123n, vault: VAULT })
    ).resolves.toMatchObject({
      shares: "1",
      tokenValue: "1.5",
      withdrawableShares: "0.733333",
    });
  });

  /**
   * With allocated reserves, the planner's one-lamport rounding buffer
   * (`RESERVE_WITHDRAW_LIQUIDITY_ROUNDING_BUFFER_LAMPORTS`) leaves even a
   * well-funded vault one base unit short of a full burn-all exit — the same
   * shortfall `quoteKaminoWithdraw` reports for the full balance. The ceiling
   * must agree with the quote at that scale too: the position read reports the
   * largest coverable amount, and the pre-fix read ("1") was already an exit
   * the builder refuses (encoded shares would differ from the request).
   */
  it("agrees with the quote down to the planner's one-lamport reserve buffer", async () => {
    mocks.getState.mockResolvedValue({
      ...state,
      tokenAvailable: integer(4_000_000),
      vaultAllocationStrategy: [{ ctokenAllocation: integer(1_000_000), reserve: RESERVE }],
    });
    mocks.freelyAvailableLiquidity = 200_000;

    await expect(
      readKaminoPosition(runtime, { owner: OWNER, slot: 123n, vault: VAULT })
    ).resolves.toMatchObject({ shares: "1", tokenValue: "5", withdrawableShares: "0.999999" });
    await expect(
      quoteKaminoWithdraw(runtime, { shares: "1", slot: 123n, vault: VAULT })
    ).resolves.toMatchObject({
      issues: [expect.objectContaining({ code: "INSUFFICIENT_WITHDRAWAL_LIQUIDITY" })],
    });
    await expect(
      quoteKaminoWithdraw(runtime, { shares: "0.999999", slot: 123n, vault: VAULT })
    ).resolves.toMatchObject({ issues: [] });
  });

  it("reports nothing immediately withdrawable when the exit plan cannot be observed", async () => {
    mocks.fetchReserveStates.mockRejectedValue(new Error("reserve state unavailable"));

    const position = await readKaminoPosition(runtime, {
      owner: OWNER,
      slot: 123n,
      vault: VAULT,
    });
    expect(position.shares).toBe("1");
    expect(position.tokenValue).toBeUndefined();
    expect(position.withdrawableShares).toBe("0");
  });

  it("ceiling and quote agree: the capped amount quotes clean while the full balance reports short liquidity", async () => {
    mocks.getState.mockResolvedValue({
      ...state,
      tokenAvailable: integer(500_000),
      vaultAllocationStrategy: [{ ctokenAllocation: integer(1_000_000), reserve: RESERVE }],
    });
    mocks.freelyAvailableLiquidity = 100_000;

    await expect(
      quoteKaminoWithdraw(runtime, { shares: "1", slot: 123n, vault: VAULT })
    ).resolves.toMatchObject({
      issues: [expect.objectContaining({ code: "INSUFFICIENT_WITHDRAWAL_LIQUIDITY" })],
    });
    await expect(
      quoteKaminoWithdraw(runtime, { shares: "0.733333", slot: 123n, vault: VAULT })
    ).resolves.toMatchObject({ issues: [] });
  });

  /**
   * The fail-closed half of the same invariant: a full exit the liquidity plan
   * cannot fill makes the SDK encode fewer shares than requested, and the
   * builder must refuse rather than sign a ledger record that would not match
   * what moves on chain. The position ceiling above is what keeps the UI away
   * from exactly this refusal.
   */
  it("refuses a full exit whose liquidity plan cannot burn every requested share", async () => {
    mocks.getState.mockResolvedValue({
      ...state,
      tokenAvailable: integer(500_000),
      vaultAllocationStrategy: [{ ctokenAllocation: integer(1_000_000), reserve: RESERVE }],
    });
    mocks.freelyAvailableLiquidity = 100_000;

    await expect(
      buildKaminoWithdrawPlan(runtime, { owner, shares: "1", slot: 123n, vault: VAULT })
    ).rejects.toMatchObject({
      name: "SdpKaminoError",
      code: "VAULT_UNREADABLE",
      message: expect.stringContaining("encode 733332 share base units"),
    });
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
