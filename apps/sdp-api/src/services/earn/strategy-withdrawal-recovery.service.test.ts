import type { EarnVaultQueuedWithdrawalRequestLookup } from "@sdp/earn/types";
import { runInClusterScope } from "@sdp/rpc/scope";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EarnVaultWithdrawalRequestRow } from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import { env } from "@/test/helpers/env";
import {
  prepareQueuedStrategyRecovery,
  prepareStrategyWithdrawalChoices,
} from "./strategy-queued-operations.service";
import {
  assertExpiredStrategyEscrow,
  assertStrategyRecoverySource,
  readExpiredStrategyWithdrawalRecoveries,
} from "./strategy-withdrawal-recovery.service";
import { buildWalletQueuedWithdrawalRecovery } from "./vault-queued-withdraw.service";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  findOldestExpiredEscrow: vi.fn(),
  getById: vi.fn(),
  advanceRequest: vi.fn(),
  createWalletTransaction: vi.fn(),
  read: vi.fn(),
  build: vi.fn(),
  simulate: vi.fn(),
  compile: vi.fn(),
}));
vi.mock("@/db/repositories/earn-vault-withdrawal-requests.repository", async (original) => ({
  ...(await original<
    typeof import("@/db/repositories/earn-vault-withdrawal-requests.repository")
  >()),
  createPostgresEarnVaultWithdrawalRequestsRepository: () => ({
    findOldestExpiredEscrow: mocks.findOldestExpiredEscrow,
    getById: mocks.getById,
    advanceRequest: mocks.advanceRequest,
    createWalletTransaction: mocks.createWalletTransaction,
  }),
}));
vi.mock("./execution-registry", async (original) => ({
  ...(await original<typeof import("./execution-registry")>()),
  resolveEarnExecutionClient: mocks.resolve,
  resolveVaultQueuedWithdrawClient: mocks.resolve,
}));
vi.mock("./vault-execution.service", async (original) => ({
  ...(await original<typeof import("./vault-execution.service")>()),
  simulateVaultPlan: mocks.simulate,
  compileUnsignedVaultTransaction: mocks.compile,
}));

const actor = { organizationId: "org_recovery", projectId: "prj_recovery" };
const position = {
  id: "position_recovery",
  provider: "veda",
  ownerAddress: "11111111111111111111111111111111",
  custodyWalletId: "cwlt_recovery",
  vaultAddress: "vault_recovery",
  tokenMint: "asset_recovery",
  shareMint: "shares_recovery",
};
const inScope = <T>(work: () => T): T =>
  runInClusterScope({ projectId: actor.projectId, environment: "sandbox" }, work);

function request(
  overrides: Partial<EarnVaultWithdrawalRequestRow> = {}
): EarnVaultWithdrawalRequestRow {
  return {
    id: "request_recovery",
    organization_id: actor.organizationId,
    project_id: actor.projectId,
    environment: "sandbox",
    provider: position.provider,
    position_id: position.id,
    custody_wallet_id: position.custodyWalletId,
    owner_address: position.ownerAddress,
    vault_address: position.vaultAddress,
    token_mint: position.tokenMint,
    share_mint: position.shareMint,
    request_address: "request_address",
    status: "expired_cancelable",
    mechanism: "solver_queue",
    shares: "10",
    quoted_assets: "9.9",
    share_decimals: 6,
    asset_decimals: 6,
    intermediate_mint: null,
    intermediate_amount: null,
    discount_bps: 25,
    nonce: "7",
    creation_timestamp: "1700000000",
    provider_state_observed: true,
    maturity_timestamp: "1700000060",
    deadline_timestamp: "1700000120",
    client_request_id: "original_request",
    idempotency_fingerprint: "original_fingerprint",
    creation_signature: "original_signature",
    cancel_signature: null,
    closing_signature: null,
    assets_paid: null,
    failure_reason: null,
    last_index_error: null,
    fulfilled_at: null,
    cancelled_at: null,
    created_by: null,
    initiated_by_key_id: null,
    created_at: "2026-11-01T00:00:00.000Z",
    updated_at: "2026-11-01T00:00:00.000Z",
    last_checked_at: null,
    next_check_at: null,
    ...overrides,
  };
}

function lookup(): Exclude<EarnVaultQueuedWithdrawalRequestLookup, { status: "closedOrUnknown" }> {
  return {
    requestAddress: "request_address",
    status: "expiredCancelable",
    request: {
      requestAddress: "request_address",
      providerReference: position.vaultAddress,
      owner: position.ownerAddress,
      nonce: "7",
      assetMint: position.tokenMint,
      shares: "10",
      assets: "9.9",
      creationTimestamp: "1700000000",
      maturityTimestamp: "1700000060",
      deadlineTimestamp: "1700000120",
      status: "expiredCancelable",
    },
  };
}

const plan = {
  cluster: "devnet",
  instructions: [],
  lookupTables: [],
  assetIdentity: { depositTokenMint: position.tokenMint, shareMint: position.shareMint },
  accepted: { shares: "10" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOldestExpiredEscrow.mockResolvedValue(request());
  mocks.getById.mockResolvedValue(request());
  mocks.advanceRequest.mockResolvedValue(request());
  mocks.createWalletTransaction.mockImplementation(async (input: { id: string }) => ({
    id: input.id,
  }));
  mocks.read.mockResolvedValue(lookup());
  mocks.build.mockResolvedValue(plan);
  mocks.simulate.mockResolvedValue({ ok: true, prepared: {} });
  mocks.compile.mockResolvedValue({ bytes: Uint8Array.of(1), lastValidBlockHeight: "100" });
  mocks.resolve.mockReturnValue({
    buildVaultDeposit: vi.fn(),
    readVaultPositions: vi.fn(),
    sponsoredPrograms: vi.fn(),
    getWithdrawalOptions: vi.fn(),
    quoteQueuedWithdrawal: vi.fn(),
    buildQueuedWithdrawalRequest: vi.fn(),
    buildQueuedWithdrawalCancel: mocks.build,
    readQueuedWithdrawalRequests: vi.fn(),
    readQueuedWithdrawalRequest: mocks.read,
    decodeQueuedWithdrawalLifecycleEvents: vi.fn(),
  });
});

describe("expired strategy escrow recovery", () => {
  it.each([
    { organization_id: "foreign" },
    { project_id: "foreign" },
    { environment: "production" as const },
    { position_id: "foreign" },
    { provider: "foreign" },
    { custody_wallet_id: "foreign" },
    { owner_address: "foreign" },
    { vault_address: "foreign" },
    { token_mint: "foreign" },
    { share_mint: "foreign" },
  ])("rejects source or instrument substitution: %j", (changed) => {
    expect(() =>
      inScope(() => assertStrategyRecoverySource(request(changed), actor, position))
    ).toThrow("does not match");
  });

  it.each([
    { status: "fulfilled" as const },
    { status: "cancelled" as const },
    { status: "cancelling" as const },
    { nonce: null },
    { creation_timestamp: null },
  ])("rejects unresolved or closed recorded cycles: %j", (changed) => {
    expect(() => assertExpiredStrategyEscrow(request(changed), lookup())).toThrow(
      "no proven expired"
    );
  });

  it.each([
    { nonce: "8" },
    { owner: "foreign" },
    { assetMint: "foreign" },
    { providerReference: "foreign" },
    { requestAddress: "foreign" },
    { shares: "11" },
    { assets: "10.1" },
    { creationTimestamp: "1700000001" },
    { maturityTimestamp: "1700000061" },
    { deadlineTimestamp: "1700000121" },
  ])("rejects a different live request or quantity: %j", (changed) => {
    const current = lookup();
    current.request = { ...current.request, ...changed };
    expect(() => assertExpiredStrategyEscrow(request(), current)).toThrow("identity or deadline");
  });

  it("requires actual provider expiry rather than elapsed local time", () => {
    const current = lookup();
    expect(() =>
      assertExpiredStrategyEscrow(request(), {
        ...current,
        status: "fulfillable",
        request: { ...current.request, status: "fulfillable" },
      })
    ).toThrow("no proven expired");
  });

  it("refuses an expired verdict whose matching deadline is still in the future", () => {
    const future = String(Math.floor(Date.now() / 1000) + 600);
    const current = lookup();
    current.request.deadlineTimestamp = future;
    expect(() =>
      assertExpiredStrategyEscrow(request({ deadline_timestamp: future }), current)
    ).toThrow("identity or deadline");
  });

  it("keeps caller-signed recovery scoped to the exact address source", async () => {
    const ownerPosition = { ...position, custodyWalletId: undefined };
    mocks.findOldestExpiredEscrow.mockResolvedValue(request({ custody_wallet_id: null }));
    await expect(
      inScope(() =>
        readExpiredStrategyWithdrawalRecoveries(env, {
          actor,
          position: ownerPosition,
        })
      )
    ).resolves.toHaveLength(1);
    expect(mocks.findOldestExpiredEscrow).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerAddress: position.ownerAddress,
        custodyWalletId: null,
      })
    );
  });

  it("does not manufacture recovery for closed or unavailable provider requests", async () => {
    mocks.read.mockResolvedValue({
      requestAddress: "request_address",
      status: "closedOrUnknown",
      request: null,
    });
    await expect(
      inScope(() => readExpiredStrategyWithdrawalRecoveries(env, { actor, position }))
    ).resolves.toEqual([]);
    mocks.read.mockRejectedValue(new Error("provider unavailable"));
    await expect(
      inScope(() => readExpiredStrategyWithdrawalRecoveries(env, { actor, position }))
    ).rejects.toThrow("provider unavailable");
  });

  it("advertises returned shares with no wallet balance or provider payout", async () => {
    const choices = await inScope(() =>
      prepareStrategyWithdrawalChoices(env, { position, recovery: { actor } })
    );
    expect(choices.options).toEqual([
      expect.objectContaining({
        mechanism: "recover_expired_escrow",
        amount: { mint: position.shareMint, value: "10" },
        minimum: { mint: position.shareMint, value: "10" },
      }),
    ]);
    expect(mocks.findOldestExpiredEscrow).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: actor.organizationId,
        projectId: actor.projectId,
        ownerAddress: position.ownerAddress,
        custodyWalletId: position.custodyWalletId,
        positionId: position.id,
      })
    );
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("persists a private cancellation build under the same custody source", async () => {
    await inScope(() =>
      buildWalletQueuedWithdrawalRecovery(env, {
        actor,
        position,
        request: request(),
        custodyWalletId: position.custodyWalletId,
      })
    );
    expect(mocks.build).toHaveBeenCalledWith(expect.anything(), {
      providerReference: position.vaultAddress,
      owner: position.ownerAddress,
      requestAddress: "request_address",
    });
    expect(mocks.createWalletTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cancel",
        operationOnly: true,
        withdrawalRequestId: "request_recovery",
        custodyWalletId: position.custodyWalletId,
        positionId: position.id,
        shareMint: position.shareMint,
      })
    );
  });

  it("reuses only the current planning proof and reads fresh evidence on a later preparation", async () => {
    const choices = await inScope(() =>
      prepareStrategyWithdrawalChoices(env, { position, recovery: { actor } })
    );
    const selected = choices.choices[0];
    const currentRequest = selected?.recovery;
    const currentProof = selected?.recoveryProof;
    if (currentRequest === undefined || currentProof === undefined)
      throw new Error("Expected a live recovery choice");
    await inScope(() =>
      prepareQueuedStrategyRecovery(env, {
        actor,
        position,
        request: currentRequest,
        proof: currentProof,
        custodyWalletId: position.custodyWalletId,
      })
    );
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.createWalletTransaction.mock.calls[0]?.[0]).not.toHaveProperty("proof");
    mocks.read.mockResolvedValue({
      requestAddress: "request_address",
      status: "closedOrUnknown",
      request: null,
    });
    await expect(
      inScope(() =>
        prepareStrategyWithdrawalChoices(env, {
          position,
          recovery: { actor },
        })
      )
    ).rejects.toThrow("No supported withdrawal route");
    expect(mocks.read).toHaveBeenCalledTimes(2);
  });

  it("rechecks provider truth when a selected request fills before building", async () => {
    mocks.getById.mockResolvedValue(request({ status: "fulfilled" }));
    await expect(
      inScope(() =>
        buildWalletQueuedWithdrawalRecovery(env, {
          actor,
          position,
          request: request(),
          proof: lookup(),
          custodyWalletId: position.custodyWalletId,
        })
      )
    ).rejects.toThrow("no proven expired");
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.createWalletTransaction).not.toHaveBeenCalled();
  });

  it("refuses a builder that changes the recovered share amount", async () => {
    mocks.build.mockResolvedValue({ ...plan, accepted: { shares: "11" } });
    await expect(
      inScope(() =>
        buildWalletQueuedWithdrawalRecovery(env, {
          actor,
          position,
          request: request(),
          custodyWalletId: position.custodyWalletId,
        })
      )
    ).rejects.toThrow("builder changed");
    expect(mocks.createWalletTransaction).not.toHaveBeenCalled();
  });

  it("loses safely to a concurrent fulfillment before persistence", async () => {
    mocks.advanceRequest.mockResolvedValue(null);
    await expect(
      inScope(() =>
        buildWalletQueuedWithdrawalRecovery(env, {
          actor,
          position,
          request: request(),
          custodyWalletId: position.custodyWalletId,
        })
      )
    ).rejects.toThrow("changed while preparing");
    expect(mocks.createWalletTransaction).not.toHaveBeenCalled();
  });
});
