import type {
  EarnVaultQueuedWithdrawalRequestLookup,
  EarnVaultTransactionPlan,
} from "@sdp/earn/types";
import { runInClusterScope } from "@sdp/rpc/scope";
import { VedaVaultDirectClient } from "@sdp/veda/client";
import { blockhash } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import type { EarnVaultWithdrawalRequestRow } from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import * as withdrawalRepositories from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import { env } from "@/test/helpers/env";
import * as executionRegistry from "./execution-registry";
import {
  prepareQueuedStrategyRecovery,
  prepareStrategyWithdrawalChoices,
} from "./strategy-queued-operations.service";
import {
  assertExpiredStrategyEscrow,
  assertStrategyRecoverySource,
  readExpiredStrategyWithdrawalRecoveries,
} from "./strategy-withdrawal-recovery.service";
import * as vaultExecution from "./vault-execution.service";
import {
  buildCurrentRedemptionRelease,
  buildWalletQueuedWithdrawalRecovery,
} from "./vault-queued-withdraw.service";

let mocks: ReturnType<typeof spyOnCollaborators>;

function spyOnCollaborators() {
  const repository = withdrawalRepositories.createPostgresEarnVaultWithdrawalRequestsRepository(
    getDb(env)
  );
  vi.spyOn(
    withdrawalRepositories,
    "createPostgresEarnVaultWithdrawalRequestsRepository"
  ).mockReturnValue(repository);
  const client = new VedaVaultDirectClient(
    async () => {
      throw new Error("Unexpected provider RPC lookup");
    },
    async () => {
      throw new Error("Unexpected provider execution");
    }
  );
  const resolve = vi
    .fn<typeof executionRegistry.resolveVaultQueuedWithdrawClient>()
    .mockReturnValue(client);
  vi.spyOn(executionRegistry, "resolveEarnExecutionClient").mockImplementation(resolve);
  vi.spyOn(executionRegistry, "resolveVaultQueuedWithdrawClient").mockImplementation(resolve);
  return {
    resolve,
    findOldestExpiredEscrow: vi.spyOn(repository, "findOldestExpiredEscrow"),
    getById: vi.spyOn(repository, "getById"),
    advanceRequest: vi.spyOn(repository, "advanceRequest"),
    createWalletTransaction: vi.mocked(vi.spyOn(repository, "createWalletTransaction"), {
      partial: true,
    }),
    read: vi.spyOn(client, "readQueuedWithdrawalRequest"),
    withdrawalOptions: vi.spyOn(client, "getWithdrawalOptions"),
    quoteWithdrawal: vi.spyOn(client, "quoteVaultWithdrawal"),
    build: vi.spyOn(client, "buildQueuedWithdrawalCancel"),
    simulate: vi.spyOn(vaultExecution, "simulateVaultPlan"),
    compile: vi.spyOn(vaultExecution, "compileUnsignedVaultTransaction"),
  };
}

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
} satisfies EarnVaultTransactionPlan;

beforeEach(() => {
  mocks = spyOnCollaborators();
  mocks.findOldestExpiredEscrow.mockImplementation(async (input: { after?: { id: string } }) =>
    input.after === undefined ? request() : null
  );
  mocks.getById.mockResolvedValue(request());
  mocks.advanceRequest.mockResolvedValue(request());
  mocks.createWalletTransaction.mockImplementation(async (input: { id: string }) => ({
    id: input.id,
  }));
  mocks.read.mockResolvedValue(lookup());
  mocks.build.mockResolvedValue(plan);
  mocks.simulate.mockImplementation(async ({ plan }) => ({
    ok: true,
    prepared: {
      plan,
      lookupTables: {},
      blockhash: blockhash("11111111111111111111111111111111"),
      lastValidBlockHeight: 100n,
    },
  }));
  mocks.compile.mockReturnValue({ bytes: Uint8Array.of(1), lastValidBlockHeight: "100" });
});

afterEach(() => {
  vi.restoreAllMocks();
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
    mocks.findOldestExpiredEscrow.mockResolvedValueOnce(request()).mockResolvedValueOnce(null);
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

  it("skips stale requests and reads each candidate once before offering live escrow", async () => {
    const closed = request({ id: "closed", request_address: "closed_address" });
    const unexpired = request({ id: "unexpired", request_address: "unexpired_address" });
    const recoverable = request({ id: "recoverable", request_address: "recoverable_address" });
    const proof = lookup();
    proof.requestAddress = recoverable.request_address;
    proof.request.requestAddress = recoverable.request_address;
    const unexpiredProof = lookup();
    mocks.findOldestExpiredEscrow
      .mockResolvedValueOnce(closed)
      .mockResolvedValueOnce(unexpired)
      .mockResolvedValueOnce(recoverable);
    mocks.read
      .mockResolvedValueOnce({
        requestAddress: closed.request_address,
        status: "closedOrUnknown",
        request: null,
      })
      .mockResolvedValueOnce({
        ...unexpiredProof,
        requestAddress: unexpired.request_address,
        status: "fulfillable",
        request: {
          ...unexpiredProof.request,
          requestAddress: unexpired.request_address,
          status: "fulfillable",
        },
      })
      .mockResolvedValueOnce(proof);

    await expect(
      inScope(() => readExpiredStrategyWithdrawalRecoveries(env, { actor, position }))
    ).resolves.toEqual([{ request: recoverable, proof }]);
    expect(mocks.findOldestExpiredEscrow).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ after: undefined })
    );
    expect(mocks.findOldestExpiredEscrow).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ after: { createdAt: closed.created_at, id: closed.id } })
    );
    expect(mocks.findOldestExpiredEscrow).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ after: { createdAt: unexpired.created_at, id: unexpired.id } })
    );
    expect(mocks.read).toHaveBeenCalledTimes(3);
    expect(mocks.read.mock.calls.map(([, input]) => input.requestAddress)).toEqual([
      closed.request_address,
      unexpired.request_address,
      recoverable.request_address,
    ]);
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "bounds stale escrow reads when later candidates remain: %s",
    async (hasMore) => {
      mocks.findOldestExpiredEscrow
        .mockResolvedValueOnce(request({ id: "stale_1" }))
        .mockResolvedValueOnce(request({ id: "stale_2" }))
        .mockResolvedValueOnce(request({ id: "stale_3" }))
        .mockResolvedValueOnce(hasMore ? request({ id: "later" }) : null);
      const closed = {
        requestAddress: "request_address",
        status: "closedOrUnknown",
        request: null,
      } as const;
      mocks.read
        .mockResolvedValueOnce(closed)
        .mockResolvedValueOnce(closed)
        .mockResolvedValueOnce(closed);

      const recovery = inScope(() =>
        readExpiredStrategyWithdrawalRecoveries(env, { actor, position })
      );
      if (hasMore) {
        await expect(recovery).rejects.toMatchObject({
          code: "SERVICE_UNAVAILABLE",
          statusCode: 503,
        });
      } else {
        await expect(recovery).resolves.toEqual([]);
      }
      expect(mocks.read).toHaveBeenCalledTimes(3);
      expect(mocks.findOldestExpiredEscrow).toHaveBeenCalledTimes(4);
      expect(mocks.advanceRequest).not.toHaveBeenCalled();
      expect(mocks.build).not.toHaveBeenCalled();
    }
  );

  function deferRecoveryCandidates(): void {
    mocks.findOldestExpiredEscrow
      .mockResolvedValueOnce(request({ id: "stale_1" }))
      .mockResolvedValueOnce(request({ id: "stale_2" }))
      .mockResolvedValueOnce(request({ id: "stale_3" }))
      .mockResolvedValueOnce(request({ id: "later" }));
    mocks.read.mockResolvedValue({
      requestAddress: "request_address",
      status: "closedOrUnknown",
      request: null,
    });
  }

  function configureShareWithdrawal(instant: boolean): void {
    mocks.withdrawalOptions.mockResolvedValue({
      instant,
      providerOrder: false,
      queued: false,
      withdrawAuthority: null,
      queueState: null,
      queueAsset: null,
      parRedemption: null,
    });
    mocks.quoteWithdrawal.mockResolvedValue({
      assetsOut: "9.9",
      assetDecimals: 6,
      blockingIssues: [],
    });
  }

  it("keeps the direct share route when escrow recovery discovery is deferred", async () => {
    deferRecoveryCandidates();
    configureShareWithdrawal(true);

    const choices = await inScope(() =>
      prepareStrategyWithdrawalChoices(env, {
        position,
        shares: "10",
        recovery: { actor },
      })
    );
    expect(choices.options.map((option) => option.id)).toEqual(["direct"]);
    expect(mocks.read).toHaveBeenCalledTimes(3);
    expect(mocks.findOldestExpiredEscrow).toHaveBeenCalledTimes(4);
    expect(mocks.quoteWithdrawal).toHaveBeenCalledTimes(1);
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.advanceRequest).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps deferred recovery retryable when no other route survives, with shares: %s",
    async (hasShares) => {
      deferRecoveryCandidates();
      configureShareWithdrawal(false);

      await expect(
        inScope(() =>
          prepareStrategyWithdrawalChoices(env, {
            position,
            shares: hasShares ? "10" : undefined,
            recovery: { actor },
          })
        )
      ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", statusCode: 503 });
      expect(mocks.read).toHaveBeenCalledTimes(3);
      expect(mocks.findOldestExpiredEscrow).toHaveBeenCalledTimes(4);
      expect(mocks.quoteWithdrawal).not.toHaveBeenCalled();
      expect(mocks.build).not.toHaveBeenCalled();
    }
  );

  it.each(["provider", "source", "proof"] as const)(
    "fails closed on a recovery %s failure even with an available share route",
    async (failure) => {
      configureShareWithdrawal(true);
      let code: "PROVIDER_UNAVAILABLE" | "CONFLICT";
      switch (failure) {
        case "provider":
          mocks.read.mockRejectedValue(
            Object.assign(new Error("Withdrawal request is unreadable"), {
              code: "REQUEST_UNREADABLE",
            })
          );
          code = "PROVIDER_UNAVAILABLE";
          break;
        case "source":
          mocks.findOldestExpiredEscrow.mockResolvedValue(request({ owner_address: "foreign" }));
          code = "CONFLICT";
          break;
        case "proof": {
          const changed = lookup();
          changed.request.nonce = "8";
          mocks.read.mockResolvedValue(changed);
          code = "CONFLICT";
          break;
        }
        default: {
          const exhaustive: never = failure;
          throw new Error(`Unexpected recovery failure: ${exhaustive}`);
        }
      }

      await expect(
        inScope(() =>
          prepareStrategyWithdrawalChoices(env, {
            position,
            shares: "10",
            recovery: { actor },
          })
        )
      ).rejects.toMatchObject({ code });
      expect(mocks.quoteWithdrawal).not.toHaveBeenCalled();
      expect(mocks.build).not.toHaveBeenCalled();
    }
  );

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

describe("current redemption release preparation", () => {
  const releaseRequest = () =>
    request({
      provider: "hastra",
      mechanism: "operator_redemption",
      status: "pending",
      intermediate_mint: "wylds",
      intermediate_amount: "9.9",
    });
  const releasePosition = { ...position, provider: "hastra" };
  const releasePlan = { ...plan, cluster: "devnet" as const, accepted: undefined };

  it("stores identity metadata without binding historical amounts or request A", async () => {
    const historical = releaseRequest();
    await inScope(() =>
      buildCurrentRedemptionRelease(env, {
        actor,
        position: releasePosition,
        request: historical,
        plan: releasePlan,
        custodyWalletId: position.custodyWalletId,
      })
    );
    const built = mocks.createWalletTransaction.mock.calls[0]?.[0];
    expect(built).toMatchObject({
      action: "cancel",
      mechanism: "operator_redemption",
      operationOnly: true,
      positionId: position.id,
      requestAddress: "request_address",
      intermediateMint: "wylds",
      shareDecimals: 6,
      assetDecimals: 6,
    });
    for (const field of ["withdrawalRequestId", "shares", "quotedAssets", "intermediateAmount"])
      expect(built).not.toHaveProperty(field);
    expect(historical).toEqual(releaseRequest());
    expect(mocks.advanceRequest).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.simulate).toHaveBeenCalledTimes(1);
  });

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
    { mechanism: "solver_queue" as const },
  ])("refuses a substituted request identity: %j", async (changed) => {
    await expect(
      inScope(() =>
        buildCurrentRedemptionRelease(env, {
          actor,
          position: releasePosition,
          request: { ...releaseRequest(), ...changed },
          plan: releasePlan,
          custodyWalletId: position.custodyWalletId,
        })
      )
    ).rejects.toThrow("authorized position and source");
    expect(mocks.createWalletTransaction).not.toHaveBeenCalled();
    expect(mocks.simulate).not.toHaveBeenCalled();
  });

  it.each([
    { cluster: "mainnet-beta" as const },
    { assetIdentity: { depositTokenMint: "foreign", shareMint: position.shareMint } },
    { assetIdentity: { depositTokenMint: position.tokenMint, shareMint: "foreign" } },
  ])("refuses a builder outside the reviewed instrument: %j", async (changed) => {
    await expect(
      inScope(() =>
        buildCurrentRedemptionRelease(env, {
          actor,
          position: releasePosition,
          request: releaseRequest(),
          plan: { ...releasePlan, ...changed },
          custodyWalletId: position.custodyWalletId,
        })
      )
    ).rejects.toThrow("authorized position and source");
    expect(mocks.createWalletTransaction).not.toHaveBeenCalled();
  });

  it("refuses failed simulation before exposing a release transaction", async () => {
    mocks.simulate.mockResolvedValue({
      ok: false,
      error: "changed current request",
      fault: "caller",
      logs: [],
    });
    await expect(
      inScope(() =>
        buildCurrentRedemptionRelease(env, {
          actor,
          position: releasePosition,
          request: releaseRequest(),
          plan: releasePlan,
          custodyWalletId: position.custodyWalletId,
        })
      )
    ).rejects.toThrow("simulation failed");
    expect(mocks.createWalletTransaction).not.toHaveBeenCalled();
  });
});
