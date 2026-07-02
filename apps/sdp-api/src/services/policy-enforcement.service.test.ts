import type { PolicyDefaultAction, PolicyRule } from "@sdp/types";
import { describe, expect, it, vi } from "vitest";
import type {
  ActiveApiKeyControlProfileResult,
  ActiveWalletControlProfileResult,
  ApprovalRequestRow,
  CreatePolicyEvaluationInput,
  CreateWalletOperationInput,
  PolicyRepository,
  WalletOperationRow,
} from "@/db/repositories";
import { WalletPolicyEnforcementService } from "./policy-enforcement.service";

const baseOperation: CreateWalletOperationInput = {
  organizationId: "org_1",
  projectId: "prj_1",
  custodyWalletId: "cw_1",
  walletId: "wal_1",
  apiKeyId: "key_1",
  actor: { type: "api_key", id: "key_1", apiKeyId: "key_1" },
  operationFamily: "payment",
  operationType: "payment_transfer",
  asset: "USDC",
  amount: "25.00",
  destination: "recipient_1",
  rawPayload: { requestId: "req_1" },
};

function walletProfile(
  rules: PolicyRule[],
  defaultAction: PolicyDefaultAction = "allow"
): ActiveWalletControlProfileResult {
  return {
    profile: {
      id: "wcp_1",
      organization_id: "org_1",
      project_id: "prj_1",
      custody_wallet_id: "cw_1",
      name: "Wallet controls",
      status: "active",
      active_revision_id: "wcpr_1",
      created_by: "usr_1",
      created_at: "2026-06-18T00:00:00.000Z",
      updated_at: "2026-06-18T00:00:00.000Z",
      activated_at: "2026-06-18T00:00:00.000Z",
      archived_at: null,
    },
    revision: {
      id: "wcpr_1",
      profile_id: "wcp_1",
      revision_number: 1,
      rules: rules as unknown as Record<string, unknown>[],
      default_action: defaultAction,
      created_by: "usr_1",
      created_at: "2026-06-18T00:00:00.000Z",
      activated_at: "2026-06-18T00:00:00.000Z",
    },
  };
}

function apiKeyProfile(
  rules: PolicyRule[],
  defaultAction: PolicyDefaultAction = "allow"
): ActiveApiKeyControlProfileResult {
  return {
    profile: {
      id: "akcp_1",
      organization_id: "org_1",
      project_id: "prj_1",
      api_key_id: "key_1",
      name: "API key controls",
      status: "active",
      active_revision_id: "akcpr_1",
      created_by: "usr_1",
      created_at: "2026-06-18T00:00:00.000Z",
      updated_at: "2026-06-18T00:00:00.000Z",
      activated_at: "2026-06-18T00:00:00.000Z",
      archived_at: null,
    },
    revision: {
      id: "akcpr_1",
      profile_id: "akcp_1",
      revision_number: 1,
      rules: rules as unknown as Record<string, unknown>[],
      default_action: defaultAction,
      created_by: "usr_1",
      created_at: "2026-06-18T00:00:00.000Z",
      activated_at: "2026-06-18T00:00:00.000Z",
    },
  };
}

function createRepository(options: {
  walletPolicy?: ActiveWalletControlProfileResult | null;
  apiKeyPolicy?: ActiveApiKeyControlProfileResult | null;
  evaluationError?: Error;
  policyEvaluationError?: Error;
  approvalStatusUpdateError?: Error;
  existingApprovalRequestStatus?: ApprovalRequestRow["status"];
  statusUpdateFailures?: number;
  statusUpdateError?: Error;
}) {
  const operations: WalletOperationRow[] = [];
  const approvalRequests: ApprovalRequestRow[] = [];
  let statusUpdateFailuresRemaining = options.statusUpdateFailures ?? 0;

  const repository = {
    createWalletOperation: vi.fn(async (input: CreateWalletOperationInput) => {
      const row: WalletOperationRow = {
        id: `wop_${operations.length + 1}`,
        organization_id: input.organizationId,
        project_id: input.projectId,
        custody_wallet_id: input.custodyWalletId ?? null,
        wallet_id: input.walletId,
        api_key_id: input.apiKeyId ?? null,
        source: input.source ?? "api",
        operation_family: input.operationFamily,
        operation_type: input.operationType,
        asset: input.asset ?? null,
        amount: input.amount ?? null,
        destination: input.destination ?? null,
        raw_payload: {
          ...(input.rawPayload ?? {}),
          ...(input.actor !== undefined ? { actor: input.actor } : {}),
          ...(input.context ? { context: input.context } : {}),
          ...(input.providerExtensions ? { providerExtensions: input.providerExtensions } : {}),
        },
        idempotency_key: input.idempotencyKey ?? null,
        status: input.status ?? "created",
        created_at: "2026-06-18T00:00:00.000Z",
        updated_at: "2026-06-18T00:00:00.000Z",
      };
      operations.push(row);
      return row;
    }),
    getWalletOperationById: vi.fn(async (walletOperationId: string) => {
      return operations.find((operation) => operation.id === walletOperationId) ?? null;
    }),
    updateWalletOperationStatus: vi.fn(async (walletOperationId: string, status: string) => {
      if (statusUpdateFailuresRemaining > 0) {
        statusUpdateFailuresRemaining -= 1;
        throw options.statusUpdateError ?? new Error("status update failed");
      }
      const operation = operations.find((row) => row.id === walletOperationId);
      if (!operation) return null;
      operation.status = status as WalletOperationRow["status"];
      operation.updated_at = "2026-06-18T00:01:00.000Z";
      return operation;
    }),
    createPolicyEvaluation: vi.fn(async (input: CreatePolicyEvaluationInput) => {
      if (options.policyEvaluationError) {
        throw options.policyEvaluationError;
      }

      return {
        id: "peval_1",
        wallet_operation_id: input.walletOperationId,
        wallet_policy_revision_id: input.walletPolicyRevisionId ?? null,
        api_key_policy_revision_id: input.apiKeyPolicyRevisionId ?? null,
        decision: input.decision,
        reason_code: input.reasonCode,
        reason: input.reason ?? null,
        matched_rules: input.matchedRules ?? [],
        evaluation_context: input.evaluationContext,
        requires_approval: input.requiresApproval ?? false,
        approval_request_id: input.approvalRequestId ?? null,
        created_at: "2026-06-18T00:00:00.000Z",
      };
    }),
    createApprovalRequest: vi.fn(async (input) => {
      const existing = approvalRequests.find(
        (request) => request.wallet_operation_id === input.walletOperationId
      );
      if (existing) return existing;

      if (options.existingApprovalRequestStatus) {
        const row: ApprovalRequestRow = {
          id: "appr_existing",
          organization_id: input.organizationId,
          project_id: input.projectId,
          wallet_operation_id: input.walletOperationId,
          approval_group_id: input.approvalGroupId ?? null,
          status: options.existingApprovalRequestStatus,
          provider: input.provider ?? null,
          provider_reference: input.providerReference ?? null,
          provider_payload: input.providerPayload ?? {},
          requested_by: input.requestedBy ?? null,
          resolved_by: "usr_previous",
          expires_at: input.expiresAt ?? null,
          resolved_at: "2026-06-18T00:02:00.000Z",
          created_at: "2026-06-18T00:00:00.000Z",
          updated_at: "2026-06-18T00:02:00.000Z",
        };
        approvalRequests.push(row);
        return row;
      }

      const row: ApprovalRequestRow = {
        id: `appr_${approvalRequests.length + 1}`,
        organization_id: input.organizationId,
        project_id: input.projectId,
        wallet_operation_id: input.walletOperationId,
        approval_group_id: input.approvalGroupId ?? null,
        status: "pending",
        provider: input.provider ?? null,
        provider_reference: input.providerReference ?? null,
        provider_payload: input.providerPayload ?? {},
        requested_by: input.requestedBy ?? null,
        resolved_by: null,
        expires_at: input.expiresAt ?? null,
        resolved_at: null,
        created_at: "2026-06-18T00:00:00.000Z",
        updated_at: "2026-06-18T00:00:00.000Z",
      };
      approvalRequests.push(row);
      return row;
    }),
    updateApprovalRequestStatus: vi.fn(async (input) => {
      if (options.approvalStatusUpdateError) {
        throw options.approvalStatusUpdateError;
      }

      const request = approvalRequests.find(
        (row) => row.id === input.approvalRequestId && row.organization_id === input.organizationId
      );
      if (!request) return null;
      if (request.status !== "pending") return request;

      request.status = input.status;
      request.resolved_by = input.resolvedBy ?? null;
      const resolvedAt = input.resolvedAt ?? "2026-06-18T00:02:00.000Z";
      request.resolved_at = resolvedAt;
      request.updated_at = resolvedAt;

      const operation = operations.find((row) => row.id === request.wallet_operation_id);
      if (
        operation &&
        input.operationStatus &&
        (operation.status === "pending_approval" ||
          (input.operationStatus === "failed" && operation.status === "created"))
      ) {
        operation.status = input.operationStatus;
        operation.updated_at = request.updated_at;
      }

      return request;
    }),
    listPolicyEvaluationsForOperation: vi.fn(async () => []),
    getActiveWalletControlProfileByCustodyWalletId: vi.fn(async () => options.walletPolicy ?? null),
    getActiveApiKeyControlProfileByApiKeyId: vi.fn(async () => options.apiKeyPolicy ?? null),
    getApiKeyWalletPolicyBindingResolution: vi.fn(async () => {
      if (options.evaluationError) {
        throw options.evaluationError;
      }
      return {
        total_binding_count: 0,
        binding: null,
      };
    }),
  } as unknown as PolicyRepository;

  return repository;
}

describe("WalletPolicyEnforcementService", () => {
  it("records default-allow operations and marks them evaluated", async () => {
    const repository = createRepository({});
    const service = new WalletPolicyEnforcementService(repository);

    const result = await service.enforce(baseOperation);

    expect(result.evaluation).toMatchObject({
      walletOperationId: "wop_1",
      decision: "allow",
      reasonCode: "implicit_default_allow",
    });
    expect(result.operation).toMatchObject({
      id: "wop_1",
      status: "evaluated",
    });
    expect(repository.createWalletOperation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "created" })
    );
    expect(repository.updateWalletOperationStatus).toHaveBeenCalledWith("wop_1", "evaluated");
  });

  it("marks the operation failed when the terminal status update throws", async () => {
    const repository = createRepository({
      statusUpdateFailures: 1,
      statusUpdateError: new Error("status update unavailable"),
    });
    const service = new WalletPolicyEnforcementService(repository);

    await expect(service.enforce(baseOperation)).rejects.toThrow("status update unavailable");
    expect(repository.updateWalletOperationStatus).toHaveBeenNthCalledWith(1, "wop_1", "evaluated");
    expect(repository.updateWalletOperationStatus).toHaveBeenNthCalledWith(2, "wop_1", "failed");
  });

  it("throws a deterministic forbidden response for denied operations", async () => {
    const repository = createRepository({
      walletPolicy: walletProfile([
        { id: "destinations", kind: "destination", allowlist: ["recipient_allowed"] },
      ]),
    });
    const service = new WalletPolicyEnforcementService(repository);

    await expect(service.enforce(baseOperation)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: {
        walletOperationId: "wop_1",
        policyEvaluationId: "peval_1",
        decision: "deny",
        reasonCode: "wallet_policy_match",
      },
    });
    expect(repository.updateWalletOperationStatus).toHaveBeenCalledWith("wop_1", "failed");
  });

  it("pauses approval-required operations before provider execution", async () => {
    const repository = createRepository({
      walletPolicy: walletProfile([
        { id: "large-payment-approval", kind: "approval", families: ["payment"] },
      ]),
    });
    const service = new WalletPolicyEnforcementService(repository);

    await expect(service.enforce(baseOperation)).rejects.toMatchObject({
      code: "SIGNING_PENDING",
      details: {
        walletOperationId: "wop_1",
        policyEvaluationId: "peval_1",
        decision: "approval_required",
        requiresApproval: true,
      },
    });
    expect(repository.updateWalletOperationStatus).toHaveBeenCalledWith(
      "wop_1",
      "pending_approval"
    );
    expect(repository.createApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        walletOperationId: "wop_1",
        approvalGroupId: null,
        requestedBy: "key_1",
      })
    );
    expect(repository.createPolicyEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalRequestId: "appr_1",
      })
    );
  });

  it("creates approval requests for manual review decisions", async () => {
    const repository = createRepository({
      walletPolicy: walletProfile([], "review"),
    });
    const service = new WalletPolicyEnforcementService(repository);

    await expect(service.enforce(baseOperation)).rejects.toMatchObject({
      code: "SIGNING_PENDING",
      details: {
        walletOperationId: "wop_1",
        decision: "review",
        requiresApproval: false,
        approvalRequestId: "appr_1",
      },
    });

    expect(repository.createApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        walletOperationId: "wop_1",
        requestedBy: "key_1",
      })
    );
    expect(repository.updateWalletOperationStatus).toHaveBeenCalledWith(
      "wop_1",
      "pending_approval"
    );
  });

  it("does not reuse terminal approval requests for a new pending decision", async () => {
    const repository = createRepository({
      walletPolicy: walletProfile([
        { id: "large-payment-approval", kind: "approval", families: ["payment"] },
      ]),
      existingApprovalRequestStatus: "failed",
    });
    const service = new WalletPolicyEnforcementService(repository);

    await expect(service.enforce(baseOperation)).rejects.toThrow(
      "Wallet operation approval request is no longer pending"
    );

    expect(repository.createPolicyEvaluation).not.toHaveBeenCalled();
    expect(repository.updateApprovalRequestStatus).not.toHaveBeenCalled();
    expect(repository.updateWalletOperationStatus).toHaveBeenCalledWith("wop_1", "failed");
    expect(repository.updateWalletOperationStatus).not.toHaveBeenCalledWith(
      "wop_1",
      "pending_approval"
    );
  });

  it("stores provider-native approval metadata when present", async () => {
    const repository = createRepository({
      walletPolicy: walletProfile([
        {
          id: "provider-approval",
          kind: "approval",
          families: ["payment"],
          action: "provider_approval_required",
          approvalGroupId: "apg_1",
        },
      ]),
    });
    const service = new WalletPolicyEnforcementService(repository);

    await expect(
      service.enforce({
        ...baseOperation,
        providerExtensions: {
          provider: "fireblocks",
          providerReference: "fb_tx_1",
          approvalWindow: "24h",
        },
      })
    ).rejects.toMatchObject({
      code: "SIGNING_PENDING",
      details: {
        decision: "provider_approval_required",
        approvalRequestId: "appr_1",
      },
    });

    expect(repository.createApprovalRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalGroupId: "apg_1",
        provider: "fireblocks",
        providerReference: "fb_tx_1",
        providerPayload: {
          provider: "fireblocks",
          providerReference: "fb_tx_1",
          approvalWindow: "24h",
        },
      })
    );
  });

  it("approves and cancels approval requests idempotently", async () => {
    const repository = createRepository({
      walletPolicy: walletProfile([
        { id: "large-payment-approval", kind: "approval", families: ["payment"] },
      ]),
    });
    const service = new WalletPolicyEnforcementService(repository);

    await expect(service.enforce(baseOperation)).rejects.toMatchObject({
      code: "SIGNING_PENDING",
    });

    await expect(
      service.approveApprovalRequest("org_1", "appr_1", "usr_approver")
    ).resolves.toMatchObject({
      status: "approved",
      resolved_by: "usr_approver",
    });
    await expect(
      service.approveApprovalRequest("org_1", "appr_1", "usr_approver")
    ).resolves.toMatchObject({
      status: "approved",
      resolved_by: "usr_approver",
    });

    const secondRepository = createRepository({
      walletPolicy: walletProfile([
        { id: "large-payment-approval", kind: "approval", families: ["payment"] },
      ]),
    });
    const secondService = new WalletPolicyEnforcementService(secondRepository);

    await expect(secondService.enforce(baseOperation)).rejects.toMatchObject({
      code: "SIGNING_PENDING",
    });
    await expect(
      secondService.cancelApprovalRequest("org_1", "appr_1", "usr_approver")
    ).resolves.toMatchObject({
      status: "canceled",
      resolved_by: "usr_approver",
    });
    await expect(
      secondService.cancelApprovalRequest("org_1", "appr_1", "usr_approver")
    ).resolves.toMatchObject({
      status: "canceled",
      resolved_by: "usr_approver",
    });
  });

  it("rejects conflicting approval request terminal transitions", async () => {
    const repository = createRepository({
      walletPolicy: walletProfile([
        { id: "large-payment-approval", kind: "approval", families: ["payment"] },
      ]),
    });
    const service = new WalletPolicyEnforcementService(repository);

    await expect(service.enforce(baseOperation)).rejects.toMatchObject({
      code: "SIGNING_PENDING",
    });
    await service.cancelApprovalRequest("org_1", "appr_1", "usr_approver");

    await expect(
      service.approveApprovalRequest("org_1", "appr_1", "usr_approver")
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Approval request is already canceled",
    });

    const secondRepository = createRepository({
      walletPolicy: walletProfile([
        { id: "large-payment-approval", kind: "approval", families: ["payment"] },
      ]),
    });
    const secondService = new WalletPolicyEnforcementService(secondRepository);

    await expect(secondService.enforce(baseOperation)).rejects.toMatchObject({
      code: "SIGNING_PENDING",
    });
    await secondService.approveApprovalRequest("org_1", "appr_1", "usr_approver");

    await expect(
      secondService.cancelApprovalRequest("org_1", "appr_1", "usr_approver")
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Approval request is already approved",
    });
  });

  it("fails approval requests and wallet operations together when recording the evaluation fails", async () => {
    const repository = createRepository({
      walletPolicy: walletProfile([
        { id: "large-payment-approval", kind: "approval", families: ["payment"] },
      ]),
      policyEvaluationError: new Error("evaluation write unavailable"),
    });
    const service = new WalletPolicyEnforcementService(repository);

    await expect(service.enforce(baseOperation)).rejects.toThrow("evaluation write unavailable");

    expect(repository.updateApprovalRequestStatus).toHaveBeenCalledWith({
      organizationId: "org_1",
      approvalRequestId: "appr_1",
      status: "failed",
      operationStatus: "failed",
    });
    expect(repository.updateWalletOperationStatus).not.toHaveBeenCalledWith("wop_1", "failed");
  });

  it("surfaces approval cleanup failures without hiding the original error", async () => {
    const repository = createRepository({
      walletPolicy: walletProfile([
        { id: "large-payment-approval", kind: "approval", families: ["payment"] },
      ]),
      policyEvaluationError: new Error("evaluation write unavailable"),
      approvalStatusUpdateError: new Error("approval cleanup unavailable"),
    });
    const service = new WalletPolicyEnforcementService(repository);

    await expect(service.enforce(baseOperation)).rejects.toThrow(
      "Wallet operation policy enforcement failed (evaluation write unavailable) and approval cleanup failed (approval cleanup unavailable)"
    );

    expect(repository.updateApprovalRequestStatus).toHaveBeenCalledWith({
      organizationId: "org_1",
      approvalRequestId: "appr_1",
      status: "failed",
      operationStatus: "failed",
    });
  });

  it("lets an API key policy narrow an otherwise allowed wallet operation", async () => {
    const repository = createRepository({
      walletPolicy: walletProfile([], "allow"),
      apiKeyPolicy: apiKeyProfile([
        { id: "api-key-destination", kind: "destination", blocklist: ["recipient_1"] },
      ]),
    });
    const service = new WalletPolicyEnforcementService(repository);

    await expect(service.enforce(baseOperation)).rejects.toMatchObject({
      code: "FORBIDDEN",
      details: {
        decision: "deny",
        reasonCode: "api_key_policy_match",
      },
    });
    expect(repository.updateWalletOperationStatus).toHaveBeenCalledWith("wop_1", "failed");
  });

  it("marks the operation failed when policy evaluation throws", async () => {
    const repository = createRepository({
      evaluationError: new Error("policy resolver unavailable"),
    });
    const service = new WalletPolicyEnforcementService(repository);

    await expect(service.enforce(baseOperation)).rejects.toThrow("policy resolver unavailable");
    expect(repository.updateWalletOperationStatus).toHaveBeenCalledWith("wop_1", "failed");
  });
});
