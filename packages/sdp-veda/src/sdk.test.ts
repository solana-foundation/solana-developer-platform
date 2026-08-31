import { wellKnownMint } from "@sdp/types";
import type { VedaDeployment } from "@sdp/types/veda-programs";
import { address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toClusterConfig } from "./programs";
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
    buildDeposit: vi.fn(),
    buildWithdraw: vi.fn(),
  },
  validateDeployment: vi.fn(),
  readMintDecimals: vi.fn(),
}));

vi.mock("@vedatech/svm-sdk", () => ({
  createVedaClient: () => ({
    validateDeployment: mocks.validateDeployment,
    vault: () => mocks.vault,
  }),
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
// The RPC client is only handed to the (mocked) SDK; keep it inert.
vi.mock("./rpc", () => ({ createVedaRpc: vi.fn(() => ({})) }));

import {
  buildVedaDepositPlan,
  buildVedaWithdrawPlan,
  previewVedaDeposit,
  previewVedaWithdraw,
  readVedaPosition,
  resetVedaCompatibilityCache,
} from "./sdk";

const USDC_DEVNET = wellKnownMint("USDC", "devnet") as string;
const USDC_MAINNET = wellKnownMint("USDC", "mainnet-beta") as string;
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const VAULT = address("7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx");
const OWNER = address("11111111111111111111111111111112");

const DEPLOYMENT: VedaDeployment = {
  vaultProgramAddress: "5J76xGGXn5op9S48pMqWV6Ex48ZxsKsRs4bGeDzSHEVc",
  queueProgramAddress: "Cchro8d7bN5Xfk77z9hJKxREJwSAjpz5K2seK4iNN396",
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
    mocks.vault.getUserPosition.mockResolvedValue({
      shares: 2_500_000n,
      unlockTimestamp: BigInt(Math.floor(Date.now() / 1000) + 3_600),
    });

    const position = await readVedaPosition(runtime, config, { vault: VAULT, owner: OWNER });

    expect(position.shares).toBe("2.5");
    expect(position.withdrawableShares).toBe("0");
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
