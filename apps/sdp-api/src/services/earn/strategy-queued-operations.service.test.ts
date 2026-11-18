import { runInClusterScope } from "@sdp/rpc/scope";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "@/test/helpers/env";
import {
  prepareQueuedStrategyWithdrawal,
  prepareStrategyWithdrawalChoices,
  selectStrategyWithdrawalChoice,
} from "./strategy-queued-operations.service";

const { resolve, buildQueued } = vi.hoisted(() => ({ resolve: vi.fn(), buildQueued: vi.fn() }));
vi.mock("./execution-registry", async (original) => ({
  ...(await original<typeof import("./execution-registry")>()),
  resolveEarnExecutionClient: resolve,
}));
vi.mock("./vault-queued-withdraw.service", () => ({
  buildExternalQueuedWithdrawalRequest: buildQueued,
  buildExternalQueuedWithdrawalCancel: vi.fn(),
  submitExternalQueuedWithdrawalAction: vi.fn(),
}));

const position = {
  id: "position",
  provider: "veda",
  vaultAddress: "strategy-reference",
  tokenMint: "token",
  shareMint: "shares",
  ownerAddress: "owner",
};
const direct = {
  buildVaultDeposit: vi.fn(),
  readVaultPositions: vi.fn(),
  sponsoredPrograms: vi.fn(),
  buildVaultWithdrawal: vi.fn(),
  quoteVaultWithdrawal: vi.fn(async () => ({
    assetsOut: "10",
    assetDecimals: 6,
    blockingIssues: [],
  })),
};
const queued = {
  ...direct,
  getWithdrawalOptions: vi.fn(async () => ({
    instant: true,
    queued: true,
    providerOrder: false,
    withdrawAuthority: null,
    queueState: null,
    parRedemption: null,
    queueAsset: {
      assetMint: "token",
      allowWithdrawals: true,
      secondsToMaturity: 600,
      minimumSecondsToDeadline: 120,
      maximumSecondsToDeadline: 3600,
      minimumDiscountBps: 25,
      maximumDiscountBps: 100,
      minimumShares: "1",
      shareDecimals: 6,
    },
  })),
  quoteQueuedWithdrawal: vi.fn(async () => ({
    assetMint: "token",
    shares: "2",
    shareDecimals: 6,
    assets: "9.975",
    assetDecimals: 6,
    discountBps: 25,
    maturityTimestamp: "2000000000",
    deadlineTimestamp: "2000000120",
    blockingIssues: [],
  })),
  buildQueuedWithdrawalRequest: vi.fn(),
  buildQueuedWithdrawalCancel: vi.fn(),
  readQueuedWithdrawalRequests: vi.fn(),
  readQueuedWithdrawalRequest: vi.fn(),
  decodeQueuedWithdrawalLifecycleEvents: vi.fn(),
};
const par = {
  ...direct,
  getParRedemptionOptions: vi.fn(async () => ({
    intermediateMint: "intermediate",
    assetMint: "token",
    minimumShares: "1",
    minimumIntermediateAmount: "1000",
    shareDecimals: 6,
    assetDecimals: 6,
    cancelable: true,
    operatorSettled: true,
  })),
  quoteParRedemption: vi.fn(async () => ({
    shares: "0",
    shareDecimals: 6,
    intermediateMint: "intermediate",
    intermediateAmount: "2000",
    assetMint: "token",
    assets: "2000",
    assetDecimals: 6,
    blockingIssues: [],
  })),
  buildParRedemptionRequest: vi.fn(),
  buildParRedemptionCancel: vi.fn(),
  readParRedemptionRequest: vi.fn(),
  decodeParRedemptionLifecycleEvents: vi.fn(),
};
function choices(input: Parameters<typeof prepareStrategyWithdrawalChoices>[1]) {
  return runInClusterScope({ projectId: "project", environment: "sandbox" }, () =>
    prepareStrategyWithdrawalChoices(env, input)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resolve.mockReturnValue(queued);
});

describe("shared strategy withdrawal options", () => {
  it("quotes independently available direct and queue exits without silently choosing", async () => {
    const prepared = await choices({ position, shares: "2" });
    expect(prepared.options.map((option) => option.id)).toEqual(["direct", "solver_queue:25:120"]);
    expect(() => selectStrategyWithdrawalChoice(prepared)).toThrow("Choose one");
    const selected = selectStrategyWithdrawalChoice(prepared, "solver_queue:25:120");
    expect(selected.terms).toEqual({
      mechanism: "solver_queue",
      shares: "2",
      discountBps: 25,
      deadlineSeconds: 120,
    });
    expect(selected.option).toMatchObject({
      settlement: "delayed",
      estimatedSeconds: null,
      amount: { mint: "token", value: "9.975" },
      minimum: null,
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(queued.getWithdrawalOptions).toHaveBeenCalledTimes(1);
    expect(queued.quoteQueuedWithdrawal).toHaveBeenCalledTimes(1);
    expect(direct.quoteVaultWithdrawal).toHaveBeenCalledTimes(1);
    expect(buildQueued).not.toHaveBeenCalled();
  });

  it("keeps held intermediate exits independent from redeemable shares", async () => {
    resolve.mockReturnValue(par);
    const prepared = await choices({ position, intermediateAmount: "2000" });
    expect(prepared.options.map((option) => option.id)).toEqual(["operator_redemption"]);
    expect(selectStrategyWithdrawalChoice(prepared).terms).toEqual({
      mechanism: "operator_redemption",
      intermediateAmount: "2000",
    });
    expect(par.quoteParRedemption).toHaveBeenCalledWith(expect.anything(), {
      providerReference: position.vaultAddress,
      intermediateAmount: "2000",
    });
    expect(direct.quoteVaultWithdrawal).not.toHaveBeenCalled();
  });

  it("keeps Hastra direct exit disabled while preserving operator redemption", async () => {
    resolve.mockReturnValue(par);
    const prepared = await choices({ position: { ...position, provider: "hastra" }, shares: "2" });
    expect(prepared.options.map((option) => option.id)).toEqual(["operator_redemption"]);
    expect(direct.quoteVaultWithdrawal).not.toHaveBeenCalled();
  });

  it("does not advertise a queue whose minimum exceeds the requested holding", async () => {
    const prepared = await choices({ position, shares: "0.5" });
    expect(prepared.options.map((option) => option.id)).toEqual(["direct"]);
    expect(queued.quoteQueuedWithdrawal).not.toHaveBeenCalled();
  });

  it("retains an independent par route while the direct DEX quote is unavailable", async () => {
    resolve.mockReturnValue(par);
    direct.quoteVaultWithdrawal.mockRejectedValueOnce(new Error("DEX unavailable"));
    const prepared = await choices({ position, shares: "2" });
    expect(prepared.options.map((option) => option.id)).toEqual(["operator_redemption"]);
    expect(par.quoteParRedemption).toHaveBeenCalledTimes(1);
    expect(buildQueued).not.toHaveBeenCalled();
  });

  it("rejects incompatible custody sources before building", async () => {
    await expect(
      prepareQueuedStrategyWithdrawal(env, {
        actor: { organizationId: "organization", projectId: "project" },
        position: { ...position, custodyWalletId: "actual-wallet" },
        custodyWalletId: "different-wallet",
        terms: { mechanism: "solver_queue", shares: "2", discountBps: 25, deadlineSeconds: 120 },
      })
    ).rejects.toThrow("authorized position");
    expect(buildQueued).not.toHaveBeenCalled();
  });
});
