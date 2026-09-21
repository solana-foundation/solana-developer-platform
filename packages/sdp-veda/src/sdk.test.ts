import { wellKnownMint } from "@sdp/types";
import type { VedaDeployment } from "@sdp/types/veda-programs";
import { address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  VEDA_DEPOSIT_ALLOWED_USER_ACCOUNT_INDEX,
  VEDA_DEPOSIT_DISCRIMINATOR,
} from "./allowed-user";
import { toClusterConfig } from "./programs";
import {
  VEDA_REQUEST_WITHDRAW_DISCRIMINATOR,
  VEDA_SETUP_USER_WITHDRAW_STATE_DISCRIMINATOR,
} from "./queue-rent";
import type { VedaRuntime } from "./types";

/**
 * Offline unit tests for the asset-resolution and error-mapping seams in
 * `sdk.ts`, with `@vedatech/svm-sdk` mocked at the module boundary.
 *
 * Mocking the SDK HERE does not breach the firewall: `sdk-construction.test.ts`
 * greps only non-test sources, and these tests exist precisely to pin behavior
 * the firewall makes hard to reach — above all the exit-safety rule that a
 * POSITION READ never consults a deposit gate. An earlier revision filtered on
 * `allowDeposits` for both money directions, which would have blanked holders'
 * portfolios whenever Veda paused deposits, so the rule gets its own suite.
 */

const mocks = vi.hoisted(() => ({
  vault: {
    validateCompatibility: vi.fn(),
    getState: vi.fn(),
    listAssets: vi.fn(),
    getUserPosition: vi.fn(),
    previewWithdraw: vi.fn(),
    previewDeposit: vi.fn(),
    previewRequestWithdrawal: vi.fn(),
    buildDeposit: vi.fn(),
    buildRequestWithdrawal: vi.fn(),
    buildCancelWithdrawal: vi.fn(),
    buildWithdraw: vi.fn(),
    getWithdrawalOptions: vi.fn(),
    getQueueWithdrawalAsset: vi.fn(),
    listOpenWithdrawalRequests: vi.fn(),
    getWithdrawalRequest: vi.fn(),
  },
  validateDeployment: vi.fn(),
  readMintDecimals: vi.fn(),
  accountExists: vi.fn(),
  minimumBalanceForRentExemption: vi.fn(),
  parseLifecycleEvents: vi.fn(),
}));

vi.mock("@vedatech/svm-sdk", () => ({
  createVedaClient: () => ({
    validateDeployment: mocks.validateDeployment,
    vault: () => mocks.vault,
  }),
  parseLifecycleEvents: mocks.parseLifecycleEvents,
  VedaSdkError: class VedaSdkError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly context: Readonly<Record<string, unknown>> = {}
    ) {
      super(message);
    }
  },
}));
vi.mock("./mint", () => ({ readMintDecimals: mocks.readMintDecimals }));
vi.mock("./accounts", () => ({
  accountExists: mocks.accountExists,
  minimumBalanceForRentExemption: mocks.minimumBalanceForRentExemption,
}));
// The RPC client is only handed to the (mocked) SDK; keep it inert.
vi.mock("./rpc", () => ({ createVedaRpc: vi.fn(() => ({})) }));

import {
  buildVedaDepositPlan,
  buildVedaQueuedWithdrawalCancelPlan,
  buildVedaQueuedWithdrawalRequestPlan,
  buildVedaWithdrawPlan,
  parseVedaWithdrawalLifecycleEvents,
  previewVedaDeposit,
  previewVedaQueuedWithdrawal,
  previewVedaWithdraw,
  readVedaPosition,
  readVedaQueuedWithdrawalRequest,
  readVedaQueuedWithdrawalRequests,
  readVedaWithdrawalOptions,
  resetVedaCompatibilityCache,
} from "./sdk";

const USDC_DEVNET = wellKnownMint("USDC", "devnet") as string;
const USDC_MAINNET = wellKnownMint("USDC", "mainnet-beta") as string;
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const VAULT = address("7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx");
const OWNER = address("11111111111111111111111111111112");
const REQUEST = address("Vote111111111111111111111111111111111111111");
const QUEUE_STATE = address("SysvarRent111111111111111111111111111111111");
const SPONSOR = address("SysvarC1ock11111111111111111111111111111111");
const QUEUE_PROGRAM = address("Cchro8d7bN5Xfk77z9hJKxREJwSAjpz5K2seK4iNN396");

const DEPLOYMENT: VedaDeployment = {
  vaultProgramAddress: "5J76xGGXn5op9S48pMqWV6Ex48ZxsKsRs4bGeDzSHEVc",
  queueProgramAddress: QUEUE_PROGRAM,
  hookProgramAddress: "FSZPGBfPWb6fUQWSwiKv8de55NabpBWgPmB6RV7kDgv9",
  vaultStateAddresses: [String(VAULT)],
};
const config = toClusterConfig("devnet", DEPLOYMENT);
const runtime: VedaRuntime = { cluster: "devnet", rpcUrl: "https://rpc.test.invalid" };

function primeVault(assets: { mint: string; allowDeposits: boolean }[]): void {
  mocks.validateDeployment.mockResolvedValue({});
  mocks.vault.validateCompatibility.mockResolvedValue({});
  mocks.vault.getState.mockResolvedValue({ shareMint: SHARE_MINT, shareDecimals: 6 });
  mocks.vault.listAssets.mockResolvedValue(
    assets.map((asset) => ({ mint: asset.mint, allowDeposits: asset.allowDeposits }))
  );
  mocks.vault.getUserPosition.mockResolvedValue({ shares: 2_500_000n });
  mocks.vault.previewWithdraw.mockResolvedValue({ assetsOut: 2_600_000n, assetDecimals: 6 });
  mocks.vault.getWithdrawalOptions.mockResolvedValue({
    instant: true,
    queued: true,
    withdrawAuthority: "11111111111111111111111111111111",
    queueState: "SysvarRent111111111111111111111111111111111",
  });
  mocks.vault.getQueueWithdrawalAsset.mockResolvedValue({
    asset: USDC_DEVNET,
    allowWithdrawals: true,
    secondsToMaturity: 60,
    minimumSecondsToDeadline: 120,
    minimumDiscountBps: 25,
    maximumDiscountBps: 500,
    minimumShares: 100_000n,
  });
  mocks.vault.previewRequestWithdrawal.mockResolvedValue({
    assetsOut: 2_487_500n,
    assetDecimals: 6,
    discountBps: 50,
    maturityTimestamp: 1_800_000_060n,
    deadlineTimestamp: 1_800_000_180n,
    issues: [],
  });
  mocks.vault.listOpenWithdrawalRequests.mockResolvedValue([]);
  mocks.vault.buildDeposit.mockResolvedValue({
    instructions: [
      {
        programAddress: config.vaultProgramAddress,
        accounts: [],
        data: new Uint8Array([1]),
      },
    ],
    requiredSignerAddresses: [OWNER],
    protectedInstructionGroups: [],
  });
  mocks.readMintDecimals.mockResolvedValue(6);
  mocks.accountExists.mockResolvedValue(true);
  mocks.minimumBalanceForRentExemption.mockResolvedValue(1_000n);
  mocks.parseLifecycleEvents.mockReturnValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetVedaCompatibilityCache();
});

describe("readVedaPosition never consults a deposit gate", () => {
  /**
   * THE EXIT-SAFETY REGRESSION TEST (ADR 0002). A routine Veda deposit pause
   * (`allow_deposits = false`) must leave holdings fully readable: the flag
   * gates money IN, and a read that consumed it would blank a customer's
   * portfolio at exactly the moment a pause makes them look.
   */
  it("returns shares and value while deposits are paused", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: false }]);

    const position = await readVedaPosition(runtime, config, { vault: VAULT, owner: OWNER });

    expect(position.shares).toBe("2.5");
    expect(position.withdrawableShares).toBe("2.5");
    expect(position.unlockTimestamp).toBeNull();
    expect(position.tokenValue).toBe("2.6");
    expect(String(position.tokenMint)).toBe(USDC_DEVNET);
    expect(String(position.shareMint)).toBe(SHARE_MINT);
  });

  /**
   * The Boring vault share lock covers the whole account until its unlock
   * instant, so redeemable-now is all-or-nothing: claiming locked shares
   * withdrawable would be a claim the chain state does not make.
   */
  it("reports locked shares as held but not withdrawable", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);
    const unlockTimestamp = BigInt(Math.floor(Date.now() / 1000) + 3_600);
    mocks.vault.getUserPosition.mockResolvedValue({
      shares: 2_500_000n,
      unlockTimestamp,
    });

    const position = await readVedaPosition(runtime, config, { vault: VAULT, owner: OWNER });

    expect(position.shares).toBe("2.5");
    expect(position.withdrawableShares).toBe("0");
    expect(position.unlockTimestamp).toBe(unlockTimestamp.toString());
  });

  it("still reads a zero balance without quoting a withdrawal", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: false }]);
    mocks.vault.getUserPosition.mockResolvedValue({ shares: 0n });

    const position = await readVedaPosition(runtime, config, { vault: VAULT, owner: OWNER });

    expect(position.shares).toBe("0");
    expect(position.tokenValue).toBe("0");
    expect(mocks.vault.previewWithdraw).not.toHaveBeenCalled();
  });

  it("withholds only the valuation when the withdrawal quote fails", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: false }]);
    mocks.vault.previewWithdraw.mockRejectedValue(new Error("stale oracle"));

    const position = await readVedaPosition(runtime, config, { vault: VAULT, owner: OWNER });

    expect(position.shares).toBe("2.5");
    expect(position.tokenValue).toBeUndefined();
  });
});

describe("asset resolution is cluster-exact", () => {
  /**
   * Mainnet USDC and devnet USDC share a symbol but are different mints. A
   * devnet vault whose asset config names the mainnet mint must be refused as
   * unsupported — spending or valuing against it would target an account that
   * does not exist on the chain in play.
   */
  it("does not treat the other cluster's mint of a declared symbol as SDP's asset", async () => {
    primeVault([{ mint: USDC_MAINNET, allowDeposits: true }]);

    await expect(
      readVedaPosition(runtime, config, { vault: VAULT, owner: OWNER })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_VAULT" });
  });

  it("collapses the cross-cluster pair to this cluster's own mint", async () => {
    primeVault([
      { mint: USDC_MAINNET, allowDeposits: true },
      { mint: USDC_DEVNET, allowDeposits: true },
    ]);

    const position = await readVedaPosition(runtime, config, { vault: VAULT, owner: OWNER });

    expect(String(position.tokenMint)).toBe(USDC_DEVNET);
  });
});

describe("buildVedaDepositPlan owns the deposit gate", () => {
  const input = { vault: VAULT, owner: OWNER, amount: "1.5", minSharesOut: "1.4" };

  it("refuses a paused asset with the caller-visible DEPOSIT_REFUSED", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: false }]);

    await expect(buildVedaDepositPlan(runtime, config, input)).rejects.toMatchObject({
      code: "DEPOSIT_REFUSED",
      message: expect.stringContaining("deposits disabled"),
    });
    expect(mocks.vault.buildDeposit).not.toHaveBeenCalled();
  });

  it("builds when the asset takes deposits", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);

    const plan = await buildVedaDepositPlan(runtime, config, input);

    expect(String(plan.assetIdentity.depositTokenMint)).toBe(USDC_DEVNET);
    expect(plan.accepted).toEqual({ amount: "1.5", minSharesOut: "1.4" });
    expect(mocks.vault.buildDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 1_500_000n,
        protection: { minAmountOut: 1_400_000n },
      })
    );
  });

  it("maps an unusable share-decimal count into the package taxonomy", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);
    mocks.vault.getState.mockResolvedValue({ shareMint: SHARE_MINT, shareDecimals: 200 });

    await expect(buildVedaDepositPlan(runtime, config, input)).rejects.toMatchObject({
      code: "VAULT_UNREADABLE",
    });
  });
});

describe("rent attribution and share-account truth", () => {
  const input = { vault: VAULT, owner: OWNER, amount: "1.5", minSharesOut: "1.4" };
  const SPONSOR = address("SysvarRecentB1ockHashes11111111111111111111");
  const SHARE_ATA = address("SysvarRent111111111111111111111111111111111");
  const VAULT_ATA = address("SysvarC1ock11111111111111111111111111111111");
  const VAULT_HOLDER = address("Stake11111111111111111111111111111111111111");
  const ATA_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const SYSTEM = address("11111111111111111111111111111111");
  const TOKEN_2022 = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

  /** The SDK's own ATA-create shape: funding payer at account index 0. */
  const ataCreate = (payer: unknown, ata: unknown, wallet: unknown, mint: string) => ({
    programAddress: ATA_PROGRAM,
    accounts: [
      { address: payer, role: 3 },
      { address: ata, role: 1 },
      { address: wallet, role: 0 },
      { address: address(mint), role: 0 },
      { address: SYSTEM, role: 0 },
      { address: TOKEN_2022, role: 0 },
    ],
    data: new Uint8Array([1]),
  });
  const depositInstruction = {
    programAddress: config.vaultProgramAddress,
    accounts: [],
    data: new Uint8Array([7]),
  };

  function primeDepositWithCreates(): void {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);
    mocks.vault.buildDeposit.mockResolvedValue({
      instructions: [
        ataCreate(OWNER, SHARE_ATA, OWNER, SHARE_MINT),
        ataCreate(OWNER, VAULT_ATA, VAULT_HOLDER, USDC_DEVNET),
        depositInstruction,
      ],
      requiredSignerAddresses: [OWNER],
      protectedInstructionGroups: [],
    });
  }

  /**
   * THE SPONSORSHIP CONTRACT (PRO-1736). The SDK hardcodes the owner as every
   * ATA create's funding payer; honoring `rentPayer` means those creates are
   * re-funded, or a zero-SOL custody wallet fails its first deposit with the
   * fee sponsored and the rent not — the smoky failure of 2026-09-02.
   */
  it("charges the sponsor for every ATA create, preserving order and count", async () => {
    primeDepositWithCreates();
    mocks.accountExists.mockResolvedValue(false);

    const plan = await buildVedaDepositPlan(runtime, config, { ...input, rentPayer: SPONSOR });

    expect(plan.instructions).toHaveLength(3);
    expect(plan.instructions[0]?.accounts?.[0]).toEqual({ address: SPONSOR, role: 3 });
    expect(plan.instructions[1]?.accounts?.[0]).toEqual({ address: SPONSOR, role: 3 });
    // Everything that is not the funding payer survives verbatim.
    expect(plan.instructions[0]?.accounts?.[1]).toEqual({ address: SHARE_ATA, role: 1 });
    expect(plan.instructions[2]).toEqual(depositInstruction);
    // A missing share account means THIS deposit pays its rent.
    expect(plan.createsShareAccount).toBe(true);
    expect(mocks.accountExists).toHaveBeenCalledWith(runtime.rpcUrl, SHARE_ATA);
  });

  it("reports createsShareAccount false when the share account already exists", async () => {
    primeDepositWithCreates();
    mocks.accountExists.mockResolvedValue(true);

    const plan = await buildVedaDepositPlan(runtime, config, { ...input, rentPayer: SPONSOR });

    expect(plan.createsShareAccount).toBe(false);
  });

  it("leaves the owner as the funding payer when no rentPayer is supplied", async () => {
    primeDepositWithCreates();
    mocks.accountExists.mockResolvedValue(false);

    const plan = await buildVedaDepositPlan(runtime, config, input);

    expect(plan.instructions[0]?.accounts?.[0]).toEqual({ address: OWNER, role: 3 });
    expect(plan.instructions[1]?.accounts?.[0]).toEqual({ address: OWNER, role: 3 });
    // Truth about rent is reported either way — the funder differs, not the fact.
    expect(plan.createsShareAccount).toBe(true);
  });

  it("omits createsShareAccount when the plan creates no share account", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);

    const plan = await buildVedaDepositPlan(runtime, config, input);

    expect("createsShareAccount" in plan).toBe(false);
    expect(mocks.accountExists).not.toHaveBeenCalled();
  });

  it("charges the sponsor for the exit's asset-account create too", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);
    mocks.vault.buildWithdraw.mockResolvedValue({
      instructions: [ataCreate(OWNER, VAULT_ATA, OWNER, USDC_DEVNET), depositInstruction],
    });

    const plan = await buildVedaWithdrawPlan(runtime, config, {
      vault: VAULT,
      owner: OWNER,
      shares: "2.5",
      minAmountOut: "2.49",
      rentPayer: SPONSOR,
    });

    expect(plan.instructions[0]?.accounts?.[0]).toEqual({ address: SPONSOR, role: 3 });
    // No share account is ever created on the way out, so nothing is claimed.
    expect("createsShareAccount" in plan).toBe(false);
    expect(mocks.accountExists).not.toHaveBeenCalled();
  });
});

describe("a sponsored first deposit pre-funds the allowed-user rent", () => {
  const input = { vault: VAULT, owner: OWNER, amount: "1.5", minSharesOut: "1.4" };
  const SPONSOR = address("SysvarRecentB1ockHashes11111111111111111111");
  const ALLOWED_USER = address("SysvarEpochSchedu1e111111111111111111111111");
  const SYSTEM = "11111111111111111111111111111111";

  /**
   * A deposit instruction as the SDK actually emits it: the vault program,
   * the real Anchor discriminator, allowed_user at its IDL-pinned index.
   */
  function vedaDeposit() {
    const accounts = Array.from({ length: 20 }, (_, index) => ({
      address: index === VEDA_DEPOSIT_ALLOWED_USER_ACCOUNT_INDEX ? ALLOWED_USER : OWNER,
      role: index === 0 ? 3 : 1,
    }));
    return {
      programAddress: config.vaultProgramAddress,
      accounts,
      data: new Uint8Array([...VEDA_DEPOSIT_DISCRIMINATOR, 1, 2, 3]),
    };
  }

  function primeFirstDeposit(allowedUserExists: boolean): void {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);
    mocks.vault.buildDeposit.mockResolvedValue({
      instructions: [vedaDeposit()],
      requiredSignerAddresses: [OWNER],
      protectedInstructionGroups: [],
    });
    mocks.accountExists.mockImplementation(
      async (_rpcUrl: string, account: unknown) =>
        String(account) !== String(ALLOWED_USER) || allowedUserExists
    );
    mocks.minimumBalanceForRentExemption.mockResolvedValue(1_171_605n);
  }

  /**
   * THE PROGRAM-RENT GAP (smoky 2026-09-02, second layer). The vault program
   * creates the depositor's AllowedUser record inside the deposit instruction
   * and charges the SIGNER — a payer the ATA swap cannot reach — so a
   * sponsored plan must hand the owner exactly that rent first, or a zero-SOL
   * custody wallet fails its first deposit with everything else sponsored.
   */
  it("prepends one System transfer of the account's live rent", async () => {
    primeFirstDeposit(false);

    const plan = await buildVedaDepositPlan(runtime, config, { ...input, rentPayer: SPONSOR });

    expect(plan.instructions).toHaveLength(2);
    const [prefund, deposit] = plan.instructions;
    expect(String(prefund?.programAddress)).toBe(SYSTEM);
    expect(prefund?.accounts?.[0]).toMatchObject({ address: SPONSOR, role: 3 });
    expect(prefund?.accounts?.[1]).toMatchObject({ address: OWNER, role: 1 });
    const data = prefund?.data as Uint8Array;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(view.getUint32(0, true)).toBe(2);
    expect(view.getBigUint64(4, true)).toBe(1_171_605n);
    // The deposit instruction itself survives verbatim, still after the prefund.
    expect(deposit).toEqual(vedaDeposit());
    // Sized from the chain the plan targets, never a hardcoded lamport figure.
    expect(mocks.minimumBalanceForRentExemption).toHaveBeenCalledWith(runtime.rpcUrl, 57);
  });

  it("adds nothing when the allowed-user record already exists", async () => {
    primeFirstDeposit(true);

    const plan = await buildVedaDepositPlan(runtime, config, { ...input, rentPayer: SPONSOR });

    expect(plan.instructions).toHaveLength(1);
    expect(mocks.minimumBalanceForRentExemption).not.toHaveBeenCalled();
  });

  it("adds nothing without a sponsor: the owner funds its own record", async () => {
    primeFirstDeposit(false);

    const plan = await buildVedaDepositPlan(runtime, config, input);

    expect(plan.instructions).toHaveLength(1);
    // Unsponsored builds never even ask: the answer could not change the plan.
    expect(mocks.accountExists).not.toHaveBeenCalledWith(runtime.rpcUrl, ALLOWED_USER);
    expect(mocks.minimumBalanceForRentExemption).not.toHaveBeenCalled();
  });
});

describe("previewVedaDeposit is an ungated read", () => {
  it("returns the vault's own numbers and reports issues instead of throwing", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);
    mocks.vault.previewDeposit.mockResolvedValue({
      sharesOut: 999_990n,
      shareDecimals: 6,
      issues: [{ code: "DEPOSIT_CAP_EXCEEDED", message: "The vault deposit cap is exceeded" }],
    });

    const quote = await previewVedaDeposit(runtime, config, { vault: VAULT, amount: "1" });

    expect(quote.sharesOut).toBe("0.99999");
    expect(quote.shareDecimals).toBe(6);
    expect(quote.issues).toEqual([
      { code: "DEPOSIT_CAP_EXCEEDED", message: "The vault deposit cap is exceeded" },
    ]);
    expect(mocks.vault.previewDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 1_000_000n })
    );
    // A quote is a READ: no deployment or compatibility gate, no queue demand —
    // gating it would be a read consuming a money-in gate (ADR 0002).
    expect(mocks.validateDeployment).not.toHaveBeenCalled();
    expect(mocks.vault.validateCompatibility).not.toHaveBeenCalled();
  });

  it("refuses an over-precise amount as the caller's INVALID_AMOUNT", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);

    await expect(
      previewVedaDeposit(runtime, config, { vault: VAULT, amount: "1.0000001" })
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    expect(mocks.vault.previewDeposit).not.toHaveBeenCalled();
  });
});

describe("buildVedaWithdrawPlan is the ungated instant exit", () => {
  const input = { vault: VAULT, owner: OWNER, shares: "2.5", minAmountOut: "2.49" };

  it("builds without any deployment or queue gate — exits never inherit money-in checks", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: false }]);
    mocks.vault.buildWithdraw.mockResolvedValue({
      instructions: [
        { programAddress: config.vaultProgramAddress, accounts: [], data: new Uint8Array([2]) },
      ],
    });

    const plan = await buildVedaWithdrawPlan(runtime, config, input);

    expect(plan.accepted).toEqual({ shares: "2.5", minAmountOut: "2.49" });
    expect(String(plan.assetIdentity.depositTokenMint)).toBe(USDC_DEVNET);
    expect(mocks.vault.buildWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({
        shares: 2_500_000n,
        protection: { minAmountOut: 2_490_000n },
      })
    );
    // No money-in gate on the way out: deposits are DISABLED above and the
    // exit still built, and neither validation gate was consulted.
    expect(mocks.validateDeployment).not.toHaveBeenCalled();
    expect(mocks.vault.validateCompatibility).not.toHaveBeenCalled();
  });

  it("maps a vault exit refusal to WITHDRAW_REFUSED with the SDK's own sentence", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);
    const { VedaSdkError } = await import("@vedatech/svm-sdk");
    mocks.vault.buildWithdraw.mockRejectedValue(
      new VedaSdkError("SHARE_LOCKED", "Shares are locked until the unlock timestamp")
    );

    await expect(buildVedaWithdrawPlan(runtime, config, input)).rejects.toMatchObject({
      code: "WITHDRAW_REFUSED",
      message: expect.stringContaining("Shares are locked"),
    });
  });

  it("refuses over-precise shares as the caller's INVALID_AMOUNT", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);

    await expect(
      buildVedaWithdrawPlan(runtime, config, { ...input, shares: "2.5000001" })
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    expect(mocks.vault.buildWithdraw).not.toHaveBeenCalled();
  });
});

describe("previewVedaWithdraw is an ungated read", () => {
  it("returns the vault's own numbers and reports issues instead of throwing", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: false }]);
    mocks.vault.previewWithdraw.mockResolvedValue({
      assetsOut: 2_497_000n,
      assetDecimals: 6,
      issues: [{ code: "SHARE_LOCKED", message: "Shares are locked" }],
    });

    const quote = await previewVedaWithdraw(runtime, config, { vault: VAULT, shares: "2.5" });

    expect(quote.assetsOut).toBe("2.497");
    expect(quote.assetDecimals).toBe(6);
    expect(quote.issues).toEqual([{ code: "SHARE_LOCKED", message: "Shares are locked" }]);
    expect(mocks.vault.previewWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({ shares: 2_500_000n })
    );
    expect(mocks.validateDeployment).not.toHaveBeenCalled();
  });
});

function queuedRequestView(overrides: Record<string, unknown> = {}) {
  return {
    address: REQUEST,
    user: OWNER,
    vaultId: 7n,
    nonce: 3n,
    asset: USDC_DEVNET,
    shares: 2_500_000n,
    assets: 2_487_500n,
    creationTimestamp: 1_800_000_000n,
    maturityTimestamp: 1_800_000_060n,
    deadlineTimestamp: 1_800_000_180n,
    status: "pending" as const,
    ...overrides,
  };
}

function queueInstruction(
  discriminator: readonly number[],
  accounts: readonly { address: string; role: number }[]
) {
  return {
    programAddress: QUEUE_PROGRAM,
    accounts: accounts.map((account) => ({
      address: address(account.address),
      role: account.role,
    })),
    data: new Uint8Array([...discriminator, 0]),
  };
}

describe("readVedaWithdrawalOptions", () => {
  it("reports instant and queued routes independently with decimal queue limits", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: false }]);

    const options = await readVedaWithdrawalOptions(runtime, config, { vault: VAULT });

    expect(options).toEqual({
      instant: true,
      queued: true,
      withdrawAuthority: address("11111111111111111111111111111111"),
      queueState: QUEUE_STATE,
      queueAsset: {
        assetMint: address(USDC_DEVNET),
        allowWithdrawals: true,
        secondsToMaturity: 60,
        minimumSecondsToDeadline: 120,
        minimumDiscountBps: 25,
        maximumDiscountBps: 500,
        minimumShares: "0.1",
        shareDecimals: 6,
      },
    });
  });

  it("preserves a missing asset-specific queue configuration as null", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);
    mocks.vault.getQueueWithdrawalAsset.mockResolvedValue(null);

    await expect(
      readVedaWithdrawalOptions(runtime, config, { vault: VAULT })
    ).resolves.toMatchObject({ queued: false, queueAsset: null });
  });

  it("does not advertise a queued route when the configured asset is paused", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);
    mocks.vault.getQueueWithdrawalAsset.mockResolvedValue({
      asset: USDC_DEVNET,
      allowWithdrawals: false,
      secondsToMaturity: 60,
      minimumSecondsToDeadline: 120,
      minimumDiscountBps: 25,
      maximumDiscountBps: 500,
      minimumShares: 100_000n,
    });

    await expect(
      readVedaWithdrawalOptions(runtime, config, { vault: VAULT })
    ).resolves.toMatchObject({
      queued: false,
      queueAsset: { allowWithdrawals: false },
    });
  });
});

describe("previewVedaQueuedWithdrawal", () => {
  it("passes exact atomics to the SDK and returns JSON-safe decimal and timestamp fields", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);

    const quote = await previewVedaQueuedWithdrawal(runtime, config, {
      vault: VAULT,
      shares: "2.5",
      discountBps: 50,
      deadlineSeconds: 120,
    });

    expect(mocks.vault.previewRequestWithdrawal).toHaveBeenCalledWith({
      asset: address(USDC_DEVNET),
      shares: 2_500_000n,
      discountBps: 50,
      deadlineSeconds: 120,
    });
    expect(quote).toEqual({
      assetMint: address(USDC_DEVNET),
      shares: "2.5",
      shareDecimals: 6,
      assets: "2.4875",
      assetDecimals: 6,
      discountBps: 50,
      maturityTimestamp: "1800000060",
      deadlineTimestamp: "1800000180",
      issues: [],
    });
  });

  it.each([
    ["fractional discount", { discountBps: 1.5 }],
    ["negative deadline", { deadlineSeconds: -1 }],
    ["oversized discount", { discountBps: 65_536 }],
  ])("rejects %s before asking the SDK", async (_label, override) => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);

    await expect(
      previewVedaQueuedWithdrawal(runtime, config, {
        vault: VAULT,
        shares: "2.5",
        discountBps: 50,
        deadlineSeconds: 120,
        ...override,
      })
    ).rejects.toMatchObject({ code: "INVALID_QUEUE_PARAMETERS" });
    expect(mocks.vault.previewRequestWithdrawal).not.toHaveBeenCalled();
  });
});

describe("buildVedaQueuedWithdrawalRequestPlan", () => {
  function primeRequestPlan(includeUserState: boolean): void {
    const setup = queueInstruction(VEDA_SETUP_USER_WITHDRAW_STATE_DISCRIMINATOR, [
      { address: OWNER, role: 3 },
      { address: QUEUE_STATE, role: 1 },
      { address: "11111111111111111111111111111111", role: 0 },
    ]);
    const requestAccounts: { address: string; role: number }[] = Array.from({ length: 17 }, () => ({
      address: OWNER,
      role: 0,
    }));
    requestAccounts[0] = { address: OWNER, role: 3 };
    requestAccounts[5] = { address: REQUEST, role: 1 };
    const request = queueInstruction(VEDA_REQUEST_WITHDRAW_DISCRIMINATOR, requestAccounts);
    mocks.vault.buildRequestWithdrawal.mockResolvedValue({
      instructions: [...(includeUserState ? [setup] : []), request],
    });
  }

  it("exposes the request PDA and labels preview metadata as expected state", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);
    primeRequestPlan(false);

    const plan = await buildVedaQueuedWithdrawalRequestPlan(runtime, config, {
      vault: VAULT,
      owner: OWNER,
      shares: "2.5",
      discountBps: 50,
      deadlineSeconds: 120,
    });

    expect(plan.requestAddress).toBe(REQUEST);
    expect(plan.accepted).toEqual({ shares: "2.5" });
    expect(plan.expectedRequest).toEqual({
      assetMint: address(USDC_DEVNET),
      shares: "2.5",
      assets: "2.4875",
      discountBps: 50,
      maturityTimestamp: "1800000060",
      deadlineTimestamp: "1800000180",
    });
  });

  it("pre-funds the owner for both queue accounts when a sponsor pays first-request rent", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);
    primeRequestPlan(true);
    mocks.minimumBalanceForRentExemption.mockImplementation(async (_rpc, bytes: number) =>
      bytes === 16 ? 160n : 1_200n
    );

    const plan = await buildVedaQueuedWithdrawalRequestPlan(runtime, config, {
      vault: VAULT,
      owner: OWNER,
      rentPayer: SPONSOR,
      shares: "2.5",
      discountBps: 50,
      deadlineSeconds: 120,
    });

    expect(mocks.minimumBalanceForRentExemption.mock.calls.map((call) => call[1])).toEqual([
      16, 120,
    ]);
    const [prefund] = plan.instructions;
    expect(String(prefund?.programAddress)).toBe("11111111111111111111111111111111");
    expect(prefund?.accounts?.[0]).toMatchObject({ address: SPONSOR, role: 3 });
    expect(prefund?.accounts?.[1]).toMatchObject({ address: OWNER, role: 1 });
    const data = prefund?.data as Uint8Array;
    expect(new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(4, true)).toBe(
      1_360n
    );
  });

  it("refuses a plan whose queue instruction does not expose this owner's request PDA", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);
    mocks.vault.buildRequestWithdrawal.mockResolvedValue({
      instructions: [
        queueInstruction(VEDA_REQUEST_WITHDRAW_DISCRIMINATOR, [
          { address: SPONSOR, role: 3 },
          { address: OWNER, role: 0 },
          { address: OWNER, role: 0 },
          { address: OWNER, role: 0 },
          { address: OWNER, role: 0 },
          { address: REQUEST, role: 1 },
        ]),
      ],
    });

    await expect(
      buildVedaQueuedWithdrawalRequestPlan(runtime, config, {
        vault: VAULT,
        owner: OWNER,
        shares: "2.5",
        discountBps: 50,
        deadlineSeconds: 120,
      })
    ).rejects.toMatchObject({ code: "INCOMPATIBLE_DEPLOYMENT" });
  });
});

describe("queued withdrawal lifecycle reads", () => {
  it("lists only the SDP-facing asset and converts every atomic/timestamp field", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);
    mocks.vault.listOpenWithdrawalRequests.mockResolvedValue([
      queuedRequestView(),
      queuedRequestView({ address: QUEUE_STATE, asset: USDC_MAINNET }),
    ]);

    await expect(
      readVedaQueuedWithdrawalRequests(runtime, config, { vault: VAULT, owner: OWNER })
    ).resolves.toEqual([
      {
        requestAddress: REQUEST,
        vault: VAULT,
        owner: OWNER,
        nonce: "3",
        assetMint: address(USDC_DEVNET),
        shares: "2.5",
        assets: "2.4875",
        creationTimestamp: "1800000000",
        maturityTimestamp: "1800000060",
        deadlineTimestamp: "1800000180",
        status: "pending",
      },
    ]);
  });

  it("preserves the SDK's closed-or-unknown terminal answer", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);
    mocks.vault.getWithdrawalRequest.mockResolvedValue({
      address: REQUEST,
      status: "closedOrUnknown",
      request: null,
    });

    await expect(
      readVedaQueuedWithdrawalRequest(runtime, config, { vault: VAULT, request: REQUEST })
    ).resolves.toEqual({
      requestAddress: REQUEST,
      status: "closedOrUnknown",
      request: null,
    });
    expect(mocks.vault.listAssets).not.toHaveBeenCalled();
  });

  it("reads an open request and rejects an asset outside SDP's vault surface", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);
    mocks.vault.getWithdrawalRequest.mockResolvedValue({
      address: REQUEST,
      status: "fulfillable",
      request: queuedRequestView({ status: "fulfillable" }),
    });

    await expect(
      readVedaQueuedWithdrawalRequest(runtime, config, { vault: VAULT, request: REQUEST })
    ).resolves.toMatchObject({ status: "fulfillable", request: { assets: "2.4875" } });

    mocks.vault.getWithdrawalRequest.mockResolvedValue({
      address: REQUEST,
      status: "pending",
      request: queuedRequestView({ asset: USDC_MAINNET }),
    });
    await expect(
      readVedaQueuedWithdrawalRequest(runtime, config, { vault: VAULT, request: REQUEST })
    ).rejects.toMatchObject({ code: "UNSUPPORTED_VAULT" });
  });
});

describe("buildVedaQueuedWithdrawalCancelPlan", () => {
  it("builds the post-deadline return and carries the shares being recovered", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);
    mocks.vault.getWithdrawalRequest.mockResolvedValue({
      address: REQUEST,
      status: "expiredCancelable",
      request: queuedRequestView({ status: "expiredCancelable" }),
    });
    mocks.vault.buildCancelWithdrawal.mockResolvedValue({
      instructions: [
        queueInstruction(
          [112, 53, 226, 58, 158, 30, 37, 168],
          [
            { address: OWNER, role: 3 },
            { address: SHARE_MINT, role: 0 },
            { address: REQUEST, role: 1 },
          ]
        ),
      ],
    });

    const plan = await buildVedaQueuedWithdrawalCancelPlan(runtime, config, {
      vault: VAULT,
      owner: OWNER,
      request: REQUEST,
    });

    expect(mocks.vault.buildCancelWithdrawal).toHaveBeenCalledWith({
      owner: OWNER,
      request: REQUEST,
    });
    expect(plan.accepted).toEqual({ shares: "2.5" });
  });

  it("refuses a closed request without constructing a cancellation", async () => {
    primeVault([{ mint: USDC_DEVNET, allowDeposits: true }]);
    mocks.vault.getWithdrawalRequest.mockResolvedValue({
      address: REQUEST,
      status: "closedOrUnknown",
      request: null,
    });

    await expect(
      buildVedaQueuedWithdrawalCancelPlan(runtime, config, {
        vault: VAULT,
        owner: OWNER,
        request: REQUEST,
      })
    ).rejects.toMatchObject({ code: "WITHDRAWAL_REQUEST_NOT_FOUND" });
    expect(mocks.vault.buildCancelWithdrawal).not.toHaveBeenCalled();
  });
});

describe("parseVedaWithdrawalLifecycleEvents", () => {
  it("keeps only queue lifecycle events and decimalizes their atomic fields", () => {
    mocks.parseLifecycleEvents.mockReturnValue([
      { kind: "deposit", assetsIn: 1n },
      {
        kind: "withdrawalRequested",
        queueState: QUEUE_STATE,
        request: REQUEST,
        vaultId: 7n,
        user: OWNER,
        assetMint: USDC_DEVNET,
        nonce: 3n,
        shares: 2_500_000n,
        assets: 2_487_500n,
        creationTime: 1_800_000_000n,
        maturityTime: 1_800_000_060n,
        deadline: 1_800_000_180n,
      },
      {
        kind: "withdrawalCancelled",
        queueState: QUEUE_STATE,
        request: REQUEST,
        vaultId: 7n,
        user: OWNER,
        assetMint: USDC_DEVNET,
        nonce: 3n,
        sharesReturned: 2_500_000n,
        cancelledAt: 1_800_000_181n,
      },
      {
        kind: "withdrawalFulfilled",
        queueState: QUEUE_STATE,
        request: REQUEST,
        vaultId: 7n,
        user: OWNER,
        assetMint: USDC_DEVNET,
        nonce: 3n,
        sharesBurned: 2_500_000n,
        assetsPaid: 2_487_500n,
        vaultAssetsOut: 2_490_000n,
        excessReturned: 2_500n,
        fulfilledAt: 1_800_000_100n,
      },
    ]);

    const events = parseVedaWithdrawalLifecycleEvents(
      [
        `Program ${QUEUE_PROGRAM} invoke [1]`,
        "Program data: mocked",
        `Program ${QUEUE_PROGRAM} success`,
      ],
      {
        queueProgramAddress: QUEUE_PROGRAM,
        shareDecimals: 6,
        assetDecimals: 6,
      }
    );

    expect(mocks.parseLifecycleEvents).toHaveBeenCalledWith(["Program data: mocked"]);

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      kind: "withdrawalRequested",
      requestAddress: REQUEST,
      shares: "2.5",
      assets: "2.4875",
      maturityTimestamp: "1800000060",
    });
    expect(events[1]).toMatchObject({ kind: "withdrawalCancelled", sharesReturned: "2.5" });
    expect(events[2]).toMatchObject({
      kind: "withdrawalFulfilled",
      sharesBurned: "2.5",
      assetsPaid: "2.4875",
      excessReturned: "0.0025",
    });
  });

  it("rejects matching event bytes emitted by another program or nested CPI", () => {
    const foreignProgram = "11111111111111111111111111111111";
    mocks.parseLifecycleEvents.mockReturnValue([]);

    parseVedaWithdrawalLifecycleEvents(
      [
        `Program ${foreignProgram} invoke [1]`,
        "Program data: forged-foreign",
        `Program ${foreignProgram} success`,
        `Program ${QUEUE_PROGRAM} invoke [1]`,
        "Program data: trusted",
        `Program ${foreignProgram} invoke [2]`,
        "Program data: forged-cpi",
        `Program ${foreignProgram} success`,
        `Program ${QUEUE_PROGRAM} success`,
      ],
      {
        queueProgramAddress: QUEUE_PROGRAM,
        shareDecimals: 6,
        assetDecimals: 6,
      }
    );

    expect(mocks.parseLifecycleEvents).toHaveBeenCalledWith(["Program data: trusted"]);
  });
});
