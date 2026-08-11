import type { CreateWalletOperationInput } from "@sdp/policy";
import { describe, expect, it } from "vitest";
import type { PolicyRepository, WalletOperationRow } from "@/db/repositories";
import { createTenantScope } from "@/lib/tenant-scope";
import { WalletPolicyEnforcementService } from "./enforcement.service";

const CASES = [
  ["payment", "payment_transfer_execute"],
  ["payment", "payment_transfer_batch_execute"],
  ["ramp", "ramp_onramp_quote"],
  ["ramp", "ramp_offramp_quote"],
  ["issuance", "issuance_mint_execute"],
  ["issuance", "issuance_update_authority_execute"],
  ["raw_sign", "custody_signer_check"],
] as const;

describe("approved wallet-operation type resumption", () => {
  it.each(CASES)("resumes the satisfied %s/%s gate", async (operationFamily, operationType) => {
    const input: CreateWalletOperationInput = {
      organizationId: "org_1",
      projectId: "prj_1",
      custodyWalletId: "cw_1",
      walletId: "wallet_1",
      apiKeyId: "key_1",
      operationFamily,
      operationType,
      asset: "USDC",
      amount: "1",
      destination: "destination_1",
    };
    const operation: WalletOperationRow = {
      id: "wop_1",
      organization_id: input.organizationId,
      project_id: input.projectId,
      custody_wallet_id: input.custodyWalletId ?? null,
      wallet_id: input.walletId,
      api_key_id: input.apiKeyId ?? null,
      source: "api",
      operation_family: operationFamily,
      operation_type: operationType,
      asset: input.asset ?? null,
      amount: input.amount ?? null,
      destination: input.destination ?? null,
      raw_payload: {},
      idempotency_key: "approval-replay-1",
      status: "executing",
      execution_started_at: "2026-08-04T00:00:00.000Z",
      execution_completed_at: null,
      execution_error: null,
      execution_result: null,
      execution_attempt_id: "attempt_1",
      execution_lease_expires_at: "2099-08-04T00:10:00.000Z",
      execution_effect_started_at: null,
      execution_attempts: 1,
      created_at: "2026-08-04T00:00:00.000Z",
      updated_at: "2026-08-04T00:01:00.000Z",
    };
    const repository = {
      getWalletOperationById: async () => operation,
      listPolicyEvaluationsForOperation: async () => [
        {
          id: "peval_1",
          wallet_operation_id: operation.id,
          wallet_policy_revision_id: "wcpr_1",
          api_key_policy_revision_id: null,
          decision: "approval_required" as const,
          reason_code: "wallet_policy_match",
          reason: "Approval required",
          matched_rules: [],
          evaluation_context: {
            operation: {
              family: operationFamily,
              type: operationType,
              asset: "USDC",
              amount: "1",
              destination: "destination_1",
            },
            walletPolicy: null,
            apiKeyPolicy: null,
          },
          requires_approval: true,
          approval_request_id: "appr_1",
          created_at: "2026-08-04T00:00:00.000Z",
        },
      ],
    } as unknown as PolicyRepository;

    const service = new WalletPolicyEnforcementService(
      repository,
      createTenantScope({ organizationId: "org_1", projectId: "prj_1" })
    );
    const result = await service.resumeApprovedOperation(operation.id, "attempt_1", input);

    expect(result.operation).toMatchObject({
      id: operation.id,
      operationType,
      status: "executing",
    });
    expect(result.evaluation).toMatchObject({
      decision: "allow",
      reasonCode: "approval_satisfied",
      requiresApproval: false,
    });

    for (const mutation of [
      { rawPayload: { tampered: true } },
      { context: { tampered: true } },
      { providerExtensions: { provider: "tampered" } },
    ]) {
      await expect(
        service.resumeApprovedOperation(operation.id, "attempt_1", {
          ...input,
          ...mutation,
        })
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Approved wallet operation does not match replayed action",
      });
    }
  });
});
