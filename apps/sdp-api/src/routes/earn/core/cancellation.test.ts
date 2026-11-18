import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationRecord } from "@/db/repositories/operations.repository";
import type { AppContext } from "@/routes/earn/context";
import { env } from "@/test/helpers/env";
import {
  authorizeEarnOperationCancellation,
  prepareEarnOperationCancellation,
} from "./cancellation";

const { request, retainedBuild, position, resolveSource, buildCancel, resolveFee } = vi.hoisted(
  () => ({
    request: vi.fn(),
    retainedBuild: vi.fn(),
    position: vi.fn(),
    resolveSource: vi.fn(),
    buildCancel: vi.fn(),
    resolveFee: vi.fn(),
  })
);
vi.mock("@/db/repositories/earn-vault-withdrawal-requests.repository", () => ({
  createPostgresEarnVaultWithdrawalRequestsRepository: () => ({
    getById: request,
    getWalletTransaction: retainedBuild,
  }),
}));
vi.mock("@/db/repositories/earn-movements.repository", () => ({
  createPostgresEarnMovementsRepository: () => ({ getPositionById: position }),
}));
vi.mock("./prepare", () => ({
  earnOperationActor: () => ({
    organizationId: "organization",
    projectId: "project",
    environment: "sandbox",
    auth: { userId: "manager", apiKeyId: null },
  }),
  resolveStrategySource: resolveSource,
}));
vi.mock("@/services/earn/strategy-queued-operations.service", () => ({
  prepareQueuedStrategyCancellation: buildCancel,
}));
vi.mock("@/services/earn/vault-sponsorship", () => ({ resolveVaultSponsorship: resolveFee }));

// Only fields consumed by cancellation are supplied; no fixture enters runtime.
const record = {
  actionPurpose: "execute",
  scope: { organizationId: "organization", projectId: "project", environment: "sandbox" },
  source: { walletId: "wallet" },
  operation: {
    resourceRef: { kind: "earn.withdrawal_request", id: "request" },
    intent: { kind: "earn.withdraw", feePayer: undefined },
  },
} as unknown as OperationRecord;
const context = { env } as unknown as AppContext;
const requestRow = {
  id: "request",
  project_id: "project",
  position_id: "position",
  provider: "hastra",
  organization_id: "organization",
  custody_wallet_id: "wallet",
  owner_address: "owner",
  vault_address: "reference",
  token_mint: "token",
  share_mint: "share",
  request_address: "request-address",
  mechanism: "operator_redemption",
  shares: "10",
  intermediate_mint: "intermediate",
  intermediate_amount: "2000",
};
beforeEach(() => {
  vi.clearAllMocks();
  request.mockResolvedValue(requestRow);
  position.mockResolvedValue({
    ...requestRow,
    id: "position",
    kind: "vault_direct",
    owner_address: null,
  });
  resolveSource.mockResolvedValue({
    source: { walletId: "wallet" },
    ownerAddress: "owner",
    wallet: { id: "wallet" },
  });
  resolveFee.mockResolvedValue({ kind: "wallet-pays" });
  buildCancel.mockResolvedValue({
    id: "cancel-build",
    unsignedTransaction: "AQ==",
    lastValidBlockHeight: "100",
  });
  retainedBuild.mockResolvedValue({
    project_id: "project",
    environment: "sandbox",
    action: "cancel",
    custody_wallet_id: "wallet",
    owner_address: "owner",
    withdrawal_request_id: "request",
  });
});

describe("operation cancellation planning", () => {
  it("authorizes exact source before preparing unsigned manager recovery", async () => {
    const authorized = await authorizeEarnOperationCancellation(context, record);
    if (authorized === null) throw new Error("Missing cancellation authorization");
    expect(buildCancel).not.toHaveBeenCalled();
    const prepared = await prepareEarnOperationCancellation(context, authorized, record);
    expect(buildCancel).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        actor: expect.objectContaining({ userId: "manager" }),
        custodyWalletId: "wallet",
        fee: { kind: "wallet-pays" },
        requestAddress: "request-address",
      })
    );
    expect(prepared).toMatchObject({
      nextAction: { type: "submit" },
      buildRef: { kind: "earn.queued_transaction", id: "cancel-build" },
      terms: { estimate: { mint: "intermediate", value: "2000" }, minimum: null },
    });
  });

  it("rejects sibling project requests before source resolution or planning", async () => {
    request.mockResolvedValue({ ...requestRow, project_id: "sibling" });
    await expect(authorizeEarnOperationCancellation(context, record)).rejects.toThrow(
      "Earn withdrawal request"
    );
    expect(resolveSource).not.toHaveBeenCalled();
    expect(buildCancel).not.toHaveBeenCalled();
  });

  it("returns an unsigned owner-authorized cancellation without custody sponsorship", async () => {
    const walletRecord = { ...record, source: { ownerAddress: "owner" } };
    request.mockResolvedValue({ ...requestRow, custody_wallet_id: null });
    position.mockResolvedValue({
      ...requestRow,
      id: "position",
      kind: "vault_direct",
      custody_wallet_id: null,
    });
    resolveSource.mockResolvedValue({
      source: { ownerAddress: "owner" },
      ownerAddress: "owner",
      wallet: null,
    });
    const authorized = await authorizeEarnOperationCancellation(context, walletRecord);
    if (authorized === null) throw new Error("Missing cancellation authorization");
    const prepared = await prepareEarnOperationCancellation(context, authorized, walletRecord);
    expect(prepared.nextAction).toEqual({
      type: "sign_transaction",
      transaction: "AQ==",
      lastValidBlockHeight: "100",
      expiresAt: null,
    });
    expect(resolveFee).not.toHaveBeenCalled();
  });

  it("rejects a request outside the operation's immutable source", async () => {
    await expect(
      authorizeEarnOperationCancellation(context, {
        ...record,
        source: { walletId: "other-wallet" },
      })
    ).rejects.toThrow("Earn withdrawal source");
    expect(resolveSource).not.toHaveBeenCalled();
  });

  it("rejects request metadata that does not belong to its position", async () => {
    position.mockResolvedValue({ ...requestRow, kind: "vault_direct", token_mint: "other-token" });
    await expect(authorizeEarnOperationCancellation(context, record)).rejects.toThrow(
      "Earn withdrawal position"
    );
    expect(resolveSource).not.toHaveBeenCalled();
  });

  it("keeps an already reviewed cancellation action without preparing another", async () => {
    expect(
      await authorizeEarnOperationCancellation(context, { ...record, actionPurpose: "cancel" })
    ).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("refreshes the retained cancellation build instead of the original withdrawal intent", async () => {
    const refreshRecord = {
      ...record,
      actionPurpose: "cancel" as const,
      operation: {
        ...record.operation,
        resourceRef: { kind: "custody.proposal", id: "declined-proposal" },
        buildRef: { kind: "earn.queued_transaction", id: "cancel-build" },
      },
    };
    const authorized = await authorizeEarnOperationCancellation(context, refreshRecord, {
      includePrepared: true,
    });
    expect(retainedBuild).toHaveBeenCalledWith({
      organizationId: "organization",
      transactionId: "cancel-build",
    });
    expect(request).toHaveBeenCalledWith({
      organizationId: "organization",
      environment: "sandbox",
      withdrawalRequestId: "request",
    });
    if (authorized === null) throw new Error("Missing refreshed cancellation");
    expect(
      await prepareEarnOperationCancellation(context, authorized, refreshRecord)
    ).toMatchObject({
      buildRef: { kind: "earn.queued_transaction" },
      terms: { estimate: { mint: "intermediate", value: "2000" } },
    });
  });

  it("refuses a retained cancellation build outside the immutable source", async () => {
    retainedBuild.mockResolvedValue({
      project_id: "project",
      environment: "sandbox",
      action: "cancel",
      custody_wallet_id: "different-wallet",
      owner_address: "owner",
      withdrawal_request_id: "request",
    });
    await expect(
      authorizeEarnOperationCancellation(
        context,
        {
          ...record,
          actionPurpose: "cancel",
          operation: {
            ...record.operation,
            resourceRef: null,
            buildRef: { kind: "earn.queued_transaction", id: "cancel-build" },
          },
        },
        { includePrepared: true }
      )
    ).rejects.toThrow("Prepared Earn cancellation");
    expect(request).not.toHaveBeenCalled();
  });
});
