import { SOL_MINT } from "@sdp/types";
import { address, createNoopSigner } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import { createPostgresPolicyRepository } from "@/db/repositories";
import { generatePaymentTransferId } from "@/db/repositories/payments.repository";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import app from "@/index";
import { AppError } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import {
  walletApprovalRequestResponseSchema,
  walletApprovalRequestsResponseSchema,
} from "@/openapi/schemas/custody";
import { walletPolicyResponseSchema } from "@/openapi/schemas/payments";
import { SigningService } from "@/services/domain/signing.service";
import { applyRampSettlementEvent } from "@/services/payments/ramp-settlements";
import { recoverApprovedWalletOperations } from "@/services/policy/approved-operation-replay";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import {
  createOrgSignerForCustodyWalletMock,
  installPaymentsRouteTestHooks,
  seedCachedKey,
  sendTransactionMock,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import {
  countTransferRows,
  listTransferRows,
  postTransfer,
  readErrorResponse,
  readTransferResponse,
  readTransferRow,
  seedConfigOwnedDuplicateProviderWallet,
  seedConnectionOwnedDuplicateProviderWallet,
  seedSelectedApiKeyWalletBindings,
  seedWalletControlProfile,
} from "@/test/helpers/payments-transfers";
import { required } from "@/test/helpers/required";

const TEST_DUPLICATE_CUSTODY_WALLET_ID = "cwlt_payments_duplicate_test";

const TEST_ALIAS_AUTHORIZED_CUSTODY_WALLET_ID = "cwlt_payments_alias_authorized_test";

const responseSchema = <T extends z.ZodType>(data: T) => z.object({ data });

const walletPolicyHttpResponseSchema = responseSchema(walletPolicyResponseSchema);

const walletApprovalHttpResponseSchema = responseSchema(walletApprovalRequestResponseSchema);

const walletApprovalListHttpResponseSchema = responseSchema(walletApprovalRequestsResponseSchema);

const dryRunResponseSchema = responseSchema(
  z.object({
    decision: z.string(),
    walletPolicyRevisionId: z.string().nullable(),
    criteria: z.array(z.unknown()),
  })
);

const approvalErrorDetailsSchema = z.object({
  approvalRequestId: z.string(),
  walletOperationId: z.string(),
});

async function seedExactIdProviderAliasWallet(): Promise<void> {
  const configId = "cust_cfg_payments_alias_authorized_test";
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: configId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        provider: "privy",
        configEncrypted: "test-config",
        status: "active",
      },
    ],
    wallets: [
      {
        id: TEST_ALIAS_AUTHORIZED_CUSTODY_WALLET_ID,
        owner: { kind: "config", custodyConfigId: configId },
        walletId: TEST_CUSTODY_WALLET_ID,
        publicKey: TEST_SOLANA_ADDRESSES.wallet1,
        label: "Alias-authorized wallet",
        purpose: "transfer",
        status: "active",
      },
    ],
  });
}

describe("Payments routes — transfer policy", () => {
  installPaymentsRouteTestHooks();
  it("describes an unknown exact source without rejecting SDP Wallet IDs", async () => {
    const response = await postTransfer(
      {
        sourceCustodyWalletId: "cwlt_missing",
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      },
      {}
    );
    expect(response.status).toBe(404);
    const body = await readErrorResponse(response);
    expect(body.error).toEqual({
      code: "NOT_FOUND",
      message: "Wallet not found. Verify the wallet identifier supplied to this endpoint.",
    });
  });
  it("activates immutable wallet control profile revisions from wallet policy updates", async () => {
    const rules = [
      {
        id: "deny-issuance",
        kind: "operation_family",
        family: "issuance",
        action: "deny",
      },
      {
        id: "approval-for-payments",
        kind: "approval",
        families: ["payment"],
        action: "approval_required",
      },
      {
        id: "deny-payment-execution",
        kind: "operation_type",
        operationType: "payment_transfer_execute",
        action: "deny",
      },
      {
        id: "approve-usdc",
        kind: "asset",
        asset: "USDC",
        action: "approval_required",
      },
    ];
    const updateRes = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/policies`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          defaultAction: "allow",
          commitMessage: "  Restrict raw signing and large transfers.  ",
          rules,
        }),
      },
      env
    );
    expect(updateRes.status).toBe(200);
    const updateBody = walletPolicyHttpResponseSchema.parse(await updateRes.json());
    expect(updateBody.data.policy.walletId).toBe(TEST_WALLET_ID);
    expect(updateBody.data.policy.defaultAction).toBe("allow");
    expect(updateBody.data.policy.rules).toEqual(rules);
    expect(updateBody.data.policy.controlProfile).toMatchObject({
      status: "active",
      revisionNumber: 1,
      commitMessage: "Restrict raw signing and large transfers.",
      providerMappingStatus: "not_applicable",
    });
    const revisionRows = await getDb(env)
      .prepare(`SELECT revision_number, default_action, commit_message, rules
         FROM wallet_control_profile_revisions
         ORDER BY revision_number ASC`)
      .all<{
        revision_number: number;
        default_action: string;
        commit_message: string | null;
        rules: unknown;
      }>();
    expect(revisionRows.results).toHaveLength(1);
    expect(revisionRows.results[0]).toMatchObject({
      revision_number: 1,
      default_action: "allow",
      commit_message: "Restrict raw signing and large transfers.",
    });
    const secondRes = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/policies`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          defaultAction: "allow",
          rules: [
            {
              id: "deny-issuance",
              kind: "operation_family",
              family: "issuance",
              action: "deny",
            },
          ],
        }),
      },
      env
    );
    expect(secondRes.status).toBe(200);
    const secondBody = walletPolicyHttpResponseSchema.parse(await secondRes.json());
    expect(required(secondBody.data.policy.controlProfile).id).toBe(
      required(updateBody.data.policy.controlProfile).id
    );
    expect(required(secondBody.data.policy.controlProfile).revisionNumber).toBe(2);
    const getRes = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/policies`,
      {
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );
    expect(getRes.status).toBe(200);
    const getBody = walletPolicyHttpResponseSchema.parse(await getRes.json());
    expect(getBody.data.policy.controlProfile).toMatchObject({
      id: required(updateBody.data.policy.controlProfile).id,
      revisionNumber: 2,
    });
    expect(getBody.data.policy.rules).toEqual([
      {
        id: "deny-issuance",
        kind: "operation_family",
        family: "issuance",
        action: "deny",
      },
    ]);
  });
  it("rejects invalid public wallet policy rule values", async () => {
    const updateRes = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/policies`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          defaultAction: "allow",
          rules: [{ kind: "operation_type", operationType: "" }],
        }),
      },
      env
    );
    expect(updateRes.status).toBe(400);
    const body = await readErrorResponse(updateRes);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Invalid request body");
    expect(body.error.message).toContain(
      "operation type must be one of the supported wallet operation types"
    );
    expect(body.error.message).toContain("→ at rules[0].operationType");
  });
  it("rejects wallet policy payloads with duplicate rule ids", async () => {
    const updateRes = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/policies`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          defaultAction: "allow",
          rules: [
            { id: "duplicated", kind: "always", action: "deny" },
            { id: "duplicated", kind: "operation_family", families: ["ramp"], action: "allow" },
          ],
        }),
      },
      env
    );
    expect(updateRes.status).toBe(400);
    const body = await readErrorResponse(updateRes);
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Duplicate rule id: duplicated");
  });
  it("dry-runs a gated transfer with zero writes and full rule criteria", async () => {
    await seedWalletControlProfile({
      rules: [
        {
          id: "approve-payment-execution",
          kind: "approval",
          operationTypes: ["payment_transfer_execute"],
        },
        {
          id: "block-ramp",
          kind: "operation_family",
          families: ["ramp"],
          action: "deny",
        },
      ],
    });
    const response = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      },
      { dryRun: true }
    );
    expect(response.status).toBe(200);
    const body = dryRunResponseSchema.parse(await response.json());
    expect(body.data.decision).toBe("approval_required");
    expect(body.data.walletPolicyRevisionId).toMatch(/^wcpr_/);
    expect(body.data.criteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "approve-payment-execution",
          matched: true,
          action: "approval_required",
        }),
        expect.objectContaining({ ruleId: "block-ramp", matched: false, action: null }),
      ])
    );
    for (const table of ["wallet_operations", "approval_requests", "payment_transfers"]) {
      const row = await getDb(env).prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
        count: number | string;
      }>();
      expect(row === null ? 0 : Number(row.count)).toBe(0);
    }
  });
  it("answers a dry-run with the verdict even when an Idempotency-Key matches a recorded transfer", async () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Idempotency-Key": "idem-dry-run-replay",
    };
    const transferBody = JSON.stringify({
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "0.1",
    });
    const first = await postTransfer(JSON.parse(transferBody), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    expect(first.status).toBe(200);
    const dryRun = await postTransfer(JSON.parse(transferBody), { dryRun: true });
    expect(dryRun.status).toBe(200);
    const dryRunBody = dryRunResponseSchema.parse(await dryRun.json());
    expect(dryRunBody.data.decision).toBe("allow");
    expect(dryRunBody.data).toHaveProperty("criteria");
  });
  it("denies a dry-run when the requested exact wallet only matches an authorized Provider ID", async () => {
    await seedExactIdProviderAliasWallet();
    await seedSelectedApiKeyWalletBindings([
      {
        walletId: TEST_CUSTODY_WALLET_ID,
        custodyWalletId: TEST_ALIAS_AUTHORIZED_CUSTODY_WALLET_ID,
        permissions: ["payments:write"],
      },
    ]);
    const response = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      },
      { dryRun: true }
    );
    expect(response.status).toBe(403);
  });
  it("denies a completed replay when exact access only matches a Provider ID alias", async () => {
    await seedSelectedApiKeyWalletBindings([
      {
        walletId: TEST_WALLET_ID,
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        permissions: ["payments:write"],
      },
    ]);
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Idempotency-Key": "exact-id-provider-alias-replay",
    };
    const body = JSON.stringify({
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "0.1",
    });
    const first = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    expect(first.status).toBe(200);
    await seedExactIdProviderAliasWallet();
    await seedSelectedApiKeyWalletBindings([
      {
        walletId: TEST_CUSTODY_WALLET_ID,
        custodyWalletId: TEST_ALIAS_AUTHORIZED_CUSTODY_WALLET_ID,
        permissions: ["payments:write"],
      },
    ]);
    const replay = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    expect(replay.status).toBe(403);
  });
  it("admits runtime execution only for new transfers", async () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Idempotency-Key": "runtime-admission-transfer-replay",
    };
    const body = JSON.stringify({
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "0.1",
    });
    const first = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    expect(first.status).toBe(200);
    const admission = vi.spyOn(SigningService.prototype, "admitRuntimeExecution").mockRejectedValue(
      new AppError("CONFLICT", "Custody wallet is unavailable", {
        reason: "runtime_execution_unavailable",
      })
    );
    try {
      const dryRun = await postTransfer(JSON.parse(body), { dryRun: true });
      const replay = await postTransfer(JSON.parse(body), {
        idempotencyKey: headers["Idempotency-Key"],
      });
      const fresh = await postTransfer(JSON.parse(body), {});
      expect(dryRun.status).toBe(200);
      expect(replay.status).toBe(200);
      expect(fresh.status).toBe(409);
      expect(admission).toHaveBeenCalledOnce();
    } finally {
      admission.mockRestore();
    }
  });
  it("replays a completed transfer after its exact wallet is deactivated", async () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Idempotency-Key": "deactivated-wallet-transfer-replay",
    };
    const body = JSON.stringify({
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "0.1",
    });
    const first = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    expect(first.status).toBe(200);
    const firstBody = await readTransferResponse(first);
    await seedSelectedApiKeyWalletBindings([
      {
        walletId: TEST_WALLET_ID,
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        permissions: ["payments:write"],
      },
    ]);
    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
      .bind(TEST_CUSTODY_WALLET_ID)
      .run();
    createOrgSignerForCustodyWalletMock.mockClear();
    const replay = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    expect(replay.status).toBe(200);
    const replayBody = await readTransferResponse(replay);
    expect(replayBody.data).toEqual(firstBody.data);
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
  });
  it("denies a completed transfer replay for a duplicate exact wallet outside the key binding", async () => {
    await seedConfigOwnedDuplicateProviderWallet();
    createOrgSignerForCustodyWalletMock.mockResolvedValue(
      createNoopSigner(address(TEST_SOLANA_ADDRESSES.wallet3))
    );
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Idempotency-Key": "duplicate-exact-wallet-transfer-replay",
    };
    const body = JSON.stringify({
      sourceCustodyWalletId: TEST_DUPLICATE_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "0.1",
    });
    const first = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    expect(first.status).toBe(200);
    await seedSelectedApiKeyWalletBindings([
      {
        walletId: TEST_WALLET_ID,
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        permissions: ["payments:write"],
      },
    ]);
    createOrgSignerForCustodyWalletMock.mockClear();
    const replay = await postTransfer(JSON.parse(body), {
      idempotencyKey: headers["Idempotency-Key"],
    });
    expect(replay.status).toBe(403);
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
  });
  it("rejects an invalid body before evaluating a dry-run", async () => {
    const response = await Reflect.apply(postTransfer, undefined, [
      { sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID },
      { dryRun: true },
    ]);
    expect(response.status).toBe(400);
  });
  // Greptile (#2267): the replay check reads wallet access fresh, as the
  // handler does, so a binding removed while the auth cache still holds it
  // cannot read the stored response.
  it("refuses a replay once a selected-wallet key loses its binding", async () => {
    await seedWalletControlProfile({
      rules: [
        {
          id: "approve-payment-execution",
          kind: "approval",
          operationTypes: ["payment_transfer_execute"],
        },
      ],
    });
    await getDb(env)
      .prepare(`INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
         VALUES ('akw_selected_replay_revoked', ?, ?, '["*"]')`)
      .bind(TEST_API_KEY.id, TEST_WALLET_ID)
      .run();
    await seedCachedKey({
      walletScope: "selected",
      signingWalletId: TEST_WALLET_ID,
      signingWalletIds: [TEST_WALLET_ID],
      walletBindings: [
        { walletId: TEST_WALLET_ID, custodyWalletId: TEST_CUSTODY_WALLET_ID, permissions: ["*"] },
      ],
    });
    const body = {
      sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "0.1",
    };
    const idempotencyKey = "selected-replay-revoked";
    expect((await postTransfer(body, { idempotencyKey })).status).toBe(202);

    await getDb(env)
      .prepare("DELETE FROM api_key_wallet_permissions WHERE id = 'akw_selected_replay_revoked'")
      .run();
    const retry = await postTransfer(body, { idempotencyKey });
    expect(retry.status).toBe(403);
    expect(retry.headers.get("Idempotent-Replayed")).toBeNull();
  });

  it("replays a selected-wallet API key approval exactly once", async () => {
    const approverUserId = "usr_test_ungrouped_payment_approver";
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(approverUserId, "ungrouped-payment-approver@example.com"),
      getDb(env)
        .prepare(`INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES (?, ?, ?, 'member', 'active')`)
        .bind("om_ungrouped_payment_approver", TEST_ORG.id, approverUserId),
      getDb(env)
        .prepare(`INSERT INTO project_members (id, project_id, user_id, role)
           VALUES (?, ?, ?, 'admin')`)
        .bind("pm_ungrouped_payment_approver", TEST_PROJECT.id, approverUserId),
    ]);
    await seedWalletControlProfile({
      rules: [
        {
          id: "approve-payment-execution",
          kind: "approval",
          operationTypes: ["payment_transfer_execute"],
        },
      ],
    });
    await getDb(env)
      .prepare(`INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
         VALUES ('akw_selected_approval_replay', ?, ?, '["*"]')`)
      .bind(TEST_API_KEY.id, TEST_WALLET_ID)
      .run();
    await seedCachedKey({
      walletScope: "selected",
      signingWalletId: TEST_WALLET_ID,
      signingWalletIds: [TEST_WALLET_ID],
      walletBindings: [
        {
          walletId: TEST_WALLET_ID,
          custodyWalletId: TEST_CUSTODY_WALLET_ID,
          permissions: ["*"],
        },
      ],
    });
    const apiHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
    };
    const adminHeaders = {
      Authorization: `Bearer ${await signSeededClerkMember(env, getDb(env), approverUserId, TEST_ORG.id)}`,
      "x-project-id": TEST_PROJECT.id,
    };
    const pendingResponse = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      },
      {}
    );
    expect(pendingResponse.status).toBe(202);
    const pendingBody = await readErrorResponse(pendingResponse);
    const { approvalRequestId, walletOperationId } = approvalErrorDetailsSchema.parse(
      pendingBody.error.details
    );
    expect(approvalRequestId).toMatch(/^appr_/);
    expect(walletOperationId).toMatch(/^wop_/);
    const pendingOperation = await createPostgresPolicyRepository(
      getDb(env),
      createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
    ).getWalletOperationById(walletOperationId);
    expect(pendingOperation).toMatchObject({
      custody_wallet_id: TEST_CUSTODY_WALLET_ID,
      wallet_id: TEST_WALLET_ID,
      raw_payload: {
        source: TEST_WALLET_ID,
        executionRequest: {
          body: { source: TEST_WALLET_ID },
        },
      },
    });
    expect(required(pendingOperation).raw_payload).not.toHaveProperty("sourceCustodyWalletId");
    const executionRequest = z
      .object({
        executionRequest: z.object({ body: z.record(z.string(), z.unknown()) }).optional(),
      })
      .parse(required(pendingOperation).raw_payload).executionRequest;
    expect(required(executionRequest).body).not.toHaveProperty("sourceCustodyWalletId");
    expect(await countTransferRows()).toBe(0);
    const approvalPath = `/v1/wallets/approval-requests/${approvalRequestId}/approve`;
    const apiKeyApproval = await app.request(
      approvalPath,
      { method: "POST", headers: apiHeaders },
      env
    );
    expect(apiKeyApproval.status).toBe(403);
    const memberApproval = await app.request(
      approvalPath,
      { method: "POST", headers: adminHeaders },
      env
    );
    expect(memberApproval.status).toBe(403);
    await getDb(env)
      .prepare("UPDATE organization_members SET role = 'admin' WHERE id = ?")
      .bind("om_ungrouped_payment_approver")
      .run();
    const approve = () => app.request(approvalPath, { method: "POST", headers: adminHeaders }, env);
    const approvedResponse = await approve();
    expect(approvedResponse.status).toBe(200);
    const approvedBody = walletApprovalHttpResponseSchema.parse(await approvedResponse.json());
    expect(approvedBody.data.approvalRequest).toMatchObject({
      status: "approved",
      operation: {
        status: "completed",
        executionError: null,
      },
    });
    expect(approvedBody.data.approvalRequest.operation.executionStartedAt).toBeTruthy();
    expect(approvedBody.data.approvalRequest.operation.executionCompletedAt).toBeTruthy();
    const transfers = await listTransferRows();
    expect(transfers).toHaveLength(1);
    expect(required(transfers[0]).status).toBe("confirmed");
    const fencedOperation = await getDb(env)
      .prepare("SELECT execution_effect_started_at FROM wallet_operations WHERE id = ?")
      .bind(walletOperationId)
      .first<{
        execution_effect_started_at: string | null;
      }>();
    expect(required(fencedOperation).execution_effect_started_at).toBeTruthy();
    const replayedApproval = await approve();
    expect(replayedApproval.status).toBe(200);
    expect(await countTransferRows()).toBe(1);
  });
  it.each([
    ["under the same Idempotency-Key", 1, "pay-same-intent"],
    // Omitted: postTransfer sends a fresh key per call, so two different keys.
    ["under two different Idempotency-Keys", 2, undefined],
  ] as const)(
    "approving two requests opened %s executes the payment as %i transfer(s)",
    async (_label, expectedTransfers, idempotencyKey) => {
      const approverUserId = "usr_test_same_key_payment_approver";
      await getDb(env).batch([
        getDb(env)
          .prepare(
            "INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
          )
          .bind(approverUserId, "same-key-payment-approver@example.com"),
        getDb(env)
          .prepare(`INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES (?, ?, ?, 'admin', 'active')`)
          .bind("om_same_key_payment_approver", TEST_ORG.id, approverUserId),
        getDb(env)
          .prepare(`INSERT INTO project_members (id, project_id, user_id, role)
           VALUES (?, ?, ?, 'admin')`)
          .bind("pm_same_key_payment_approver", TEST_PROJECT.id, approverUserId),
      ]);
      await seedWalletControlProfile({
        rules: [
          {
            id: "approve-payment-execution",
            kind: "approval",
            operationTypes: ["payment_transfer_execute"],
          },
        ],
      });
      const payment = {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      };
      const first = await postTransfer(payment, { idempotencyKey });
      const retry = await postTransfer(payment, { idempotencyKey });
      expect(first.status).toBe(202);
      expect(retry.status).toBe(202);
      const firstApproval = approvalErrorDetailsSchema.parse(
        (await readErrorResponse(first)).error.details
      ).approvalRequestId;
      const retryApproval = approvalErrorDetailsSchema.parse(
        (await readErrorResponse(retry)).error.details
      ).approvalRequestId;
      // The same key replays the held 202 rather than opening a second
      // approval (APE-568); different keys are two payments.
      if (idempotencyKey === undefined) {
        expect(retryApproval).not.toBe(firstApproval);
      } else {
        expect(retryApproval).toBe(firstApproval);
        expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
      }
      expect(await countTransferRows()).toBe(0);
      const adminHeaders = {
        Authorization: `Bearer ${await signSeededClerkMember(env, getDb(env), approverUserId, TEST_ORG.id)}`,
        "x-project-id": TEST_PROJECT.id,
      };
      for (const approvalRequestId of new Set([firstApproval, retryApproval])) {
        const approved = await app.request(
          `/v1/wallets/approval-requests/${approvalRequestId}/approve`,
          { method: "POST", headers: adminHeaders },
          env
        );
        expect(approved.status).toBe(200);
      }
      const transfers = await listTransferRows();
      expect(transfers).toHaveLength(expectedTransfers);
    }
  );
  it("fails an approved Payments replay whose route does not match its operation type", async () => {
    await seedWalletControlProfile({
      rules: [
        {
          id: "approve-payment-path-tamper",
          kind: "approval",
          operationTypes: ["payment_transfer_execute"],
        },
      ],
    });
    const pendingResponse = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      },
      {}
    );
    expect(pendingResponse.status).toBe(202);
    const pendingBody = await readErrorResponse(pendingResponse);
    const { approvalRequestId, walletOperationId } = approvalErrorDetailsSchema.parse(
      pendingBody.error.details
    );
    await getDb(env)
      .prepare(`UPDATE wallet_operations
         SET raw_payload = jsonb_set(
           raw_payload,
           '{executionRequest,path}',
           '"/v1/payments/transfer-batches"'::jsonb
         )
         WHERE id = ?`)
      .bind(walletOperationId)
      .run();
    const repository = createPostgresPolicyRepository(
      getDb(env),
      createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
    );
    await repository.updateApprovalRequestStatus({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      approvalRequestId,
      status: "approved",
      operationStatus: "executing",
      resolvedBy: TEST_API_KEY.id,
    });
    expect(await recoverApprovedWalletOperations(env)).toBe(1);
    expect(await repository.getWalletOperationById(walletOperationId)).toMatchObject({
      status: "failed",
      execution_error: "Approved wallet operation does not match persisted wallet identity",
    });
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    expect(await countTransferRows()).toBe(0);
  });
  it("denies a cached selected-wallet binding after its Provider ID becomes ambiguous", async () => {
    await seedSelectedApiKeyWalletBindings([
      {
        walletId: TEST_WALLET_ID,
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        permissions: ["payments:write"],
      },
    ]);
    await getDb(env).batch([
      getDb(env)
        .prepare(`INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted,
              encryption_version, status)
           VALUES ('cust_cfg_cached_binding_duplicate', ?, ?, 'privy', 'test-config',
                   'sdp-custody-encryption-v1', 'active')`)
        .bind(TEST_ORG.id, TEST_PROJECT.id),
      getDb(env)
        .prepare(`INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, status)
           VALUES (?, 'cust_cfg_cached_binding_duplicate', ?, ?, 'active')`)
        .bind(TEST_DUPLICATE_CUSTODY_WALLET_ID, TEST_WALLET_ID, TEST_SOLANA_ADDRESSES.wallet3),
    ]);
    const response = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      },
      {}
    );
    expect(response.status).toBe(403);
    expect(await countTransferRows()).toBe(0);
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    expect(sendTransactionMock).not.toHaveBeenCalled();
  });
  it("executes the exact Config-owned wallet when a Connection duplicates its Provider ID", async () => {
    await seedConnectionOwnedDuplicateProviderWallet();
    const response = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      },
      {}
    );
    expect(response.status).toBe(200);
    const body = await readTransferResponse(response);
    expect(body.data.transfer).toMatchObject({
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      providerWalletId: TEST_WALLET_ID,
    });
    const row = await readTransferRow(body.data.transfer.id);
    expect(row).toMatchObject({
      custody_wallet_id: TEST_CUSTODY_WALLET_ID,
      wallet_id: TEST_WALLET_ID,
      source_address: TEST_SOLANA_ADDRESSES.wallet1,
    });
    expect(createOrgSignerForCustodyWalletMock).toHaveBeenCalledOnce();
    expect(createOrgSignerForCustodyWalletMock).toHaveBeenCalledWith(
      env,
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_CUSTODY_WALLET_ID
    );
  });
  it("fails a selected-wallet approval replay when its wallet ID becomes ambiguous", async () => {
    await getDb(env)
      .prepare(`INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
         VALUES ('akw_ambiguous_payment_replay', ?, ?, '["*"]')`)
      .bind(TEST_API_KEY.id, TEST_WALLET_ID)
      .run();
    await seedWalletControlProfile({
      rules: [
        {
          id: "approve-ambiguous-payment-replay",
          kind: "approval",
          operationTypes: ["payment_transfer_execute"],
        },
      ],
    });
    await seedCachedKey({
      walletScope: "selected",
      signingWalletId: TEST_WALLET_ID,
      signingWalletIds: [TEST_WALLET_ID],
      walletBindings: [
        {
          walletId: TEST_WALLET_ID,
          custodyWalletId: TEST_CUSTODY_WALLET_ID,
          permissions: ["*"],
        },
      ],
    });
    const pendingResponse = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      },
      {}
    );
    expect(pendingResponse.status).toBe(202);
    const pendingBody = await readErrorResponse(pendingResponse);
    const { approvalRequestId, walletOperationId } = approvalErrorDetailsSchema.parse(
      pendingBody.error.details
    );
    const operationBeforeReplay = await getDb(env)
      .prepare("SELECT custody_wallet_id FROM wallet_operations WHERE id = ?")
      .bind(walletOperationId)
      .first<{
        custody_wallet_id: string | null;
      }>();
    expect(required(operationBeforeReplay).custody_wallet_id).toBe(TEST_CUSTODY_WALLET_ID);
    const repository = createPostgresPolicyRepository(
      getDb(env),
      createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
    );
    await repository.updateApprovalRequestStatus({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      approvalRequestId,
      status: "approved",
      operationStatus: "executing",
      resolvedBy: TEST_API_KEY.id,
    });
    await getDb(env).batch([
      getDb(env)
        .prepare(`INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted,
              encryption_version, status)
           VALUES ('cust_cfg_ambiguous_payment_replay', ?, ?, 'privy', 'test-config',
                   'sdp-custody-encryption-v1', 'active')`)
        .bind(TEST_ORG.id, TEST_PROJECT.id),
      getDb(env).prepare(`INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, status)
         VALUES ('cwlt_ambiguous_payment_replay', 'cust_cfg_ambiguous_payment_replay',
                 '${TEST_WALLET_ID}', '${TEST_SOLANA_ADDRESSES.wallet3}', 'active')`),
    ]);
    expect(await recoverApprovedWalletOperations(env)).toBe(1);
    const execution = await getDb(env)
      .prepare(`SELECT status, execution_error, execution_effect_started_at
         FROM wallet_operations
         WHERE id = ?`)
      .bind(walletOperationId)
      .first<{
        status: string;
        execution_error: string | null;
        execution_effect_started_at: string | null;
      }>();
    expect(execution).toMatchObject({
      status: "failed",
      execution_error: "API key is not authorized for the requested wallet",
      execution_effect_started_at: null,
    });
    expect(await countTransferRows()).toBe(0);
    expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
    expect(sendTransactionMock).not.toHaveBeenCalled();
  });
  it("replays a Clerk-requested transfer once as its requester after another Clerk admin approves", async () => {
    const approverUserId = "usr_test_human_replay_approver";
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(approverUserId, "human-replay-approver@example.com"),
      getDb(env)
        .prepare(`INSERT INTO organization_members (id, organization_id, user_id, role, status)
          VALUES (?, ?, ?, 'admin', 'active'), (?, ?, ?, 'admin', 'active')`)
        .bind(
          "om_test_human_requester",
          TEST_ORG.id,
          TEST_USER.id,
          "om_test_human_approver",
          TEST_ORG.id,
          approverUserId
        ),
      getDb(env)
        .prepare(`INSERT INTO project_members (id, project_id, user_id, role)
          VALUES (?, ?, ?, 'admin')`)
        .bind("pm_test_human_approver", TEST_PROJECT.id, approverUserId),
    ]);
    await seedWalletControlProfile({
      rules: [
        {
          id: "approve-human-transfer",
          kind: "approval",
          operationTypes: ["payment_transfer_execute"],
        },
      ],
    });
    const requesterToken = await signSeededClerkMember(env, getDb(env), TEST_USER.id, TEST_ORG.id);
    const approverToken = await signSeededClerkMember(env, getDb(env), approverUserId, TEST_ORG.id);
    const pending = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      },
      { auth: { kind: "clerk", token: requesterToken } }
    );
    expect(pending.status).toBe(202);
    const { approvalRequestId, walletOperationId } = approvalErrorDetailsSchema.parse(
      (await readErrorResponse(pending)).error.details
    );
    const readOperation = () =>
      getDb(env)
        .prepare(
          "SELECT status, execution_attempts, raw_payload FROM wallet_operations WHERE id = ?"
        )
        .bind(walletOperationId)
        .first<{
          status: string;
          execution_attempts: number;
          raw_payload: { actor: { userId: string } };
        }>();
    expect(await readOperation()).toMatchObject({
      status: "pending_approval",
      execution_attempts: 0,
      raw_payload: { actor: { userId: TEST_USER.id } },
    });
    expect(await countTransferRows()).toBe(0);
    expect(sendTransactionMock).not.toHaveBeenCalled();
    const approvalPath = `/v1/wallets/approval-requests/${approvalRequestId}/approve`;
    const approve = () =>
      app.request(
        approvalPath,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${approverToken}`, "x-project-id": TEST_PROJECT.id },
        },
        env
      );
    const approved = await approve();
    expect(approved.status).toBe(200);
    expect(
      walletApprovalHttpResponseSchema.parse(await approved.json()).data.approvalRequest
    ).toMatchObject({
      status: "approved",
      resolvedBy: approverUserId,
      operation: { status: "completed" },
    });
    expect((await approve()).status).toBe(200);
    expect(await readOperation()).toMatchObject({
      status: "completed",
      execution_attempts: 1,
      raw_payload: { actor: { userId: TEST_USER.id } },
    });
    expect(sendTransactionMock).toHaveBeenCalledOnce();
    const transfers = await listTransferRows();
    expect(transfers).toHaveLength(1);
    const audit = await getDb(env)
      .prepare(`SELECT user_id, api_key_id FROM audit_logs
        WHERE organization_id = ? AND resource_type = 'payment_transfer'
          AND resource_id = ? AND action = 'transfer' AND status = 'success'`)
      .bind(TEST_ORG.id, required(transfers[0]).id)
      .all<{ user_id: string; api_key_id: string | null }>();
    expect(audit.results).toEqual([{ user_id: TEST_USER.id, api_key_id: null }]);
  });
  it("requires the configured approval-group member to approve execution", async () => {
    const approvalGroupId = "apg_payment_execution";
    const approverUserId = "usr_test_payment_approver";
    const outsiderUserId = "usr_test_payment_outsider";
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(approverUserId, "payment-approver@example.com"),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(outsiderUserId, "payment-outsider@example.com"),
      getDb(env)
        .prepare(`INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES (?, ?, ?, 'member', 'active')`)
        .bind("om_payment_outsider", TEST_ORG.id, outsiderUserId),
      getDb(env)
        .prepare(`INSERT INTO project_members (id, project_id, user_id, role)
           VALUES (?, ?, ?, 'developer')`)
        .bind("pm_payment_outsider", TEST_PROJECT.id, outsiderUserId),
      getDb(env)
        .prepare(`INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES (?, ?, ?, 'admin', 'active')`)
        .bind("om_payment_approver", TEST_ORG.id, TEST_USER.id),
      getDb(env)
        .prepare(`INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES (?, ?, ?, 'admin', 'active')`)
        .bind("om_payment_separate_approver", TEST_ORG.id, approverUserId),
      getDb(env)
        .prepare(`INSERT INTO project_members (id, project_id, user_id, role)
           VALUES (?, ?, ?, 'admin')`)
        .bind("pm_payment_separate_approver", TEST_PROJECT.id, approverUserId),
      getDb(env)
        .prepare(`INSERT INTO approval_groups (id, organization_id, project_id, name, status, created_by)
           VALUES (?, ?, ?, 'Payment approvers', 'active', ?)`)
        .bind(approvalGroupId, TEST_ORG.id, TEST_PROJECT.id, TEST_USER.id),
      getDb(env)
        .prepare(`INSERT INTO approval_group_members (id, approval_group_id, user_id, role)
           VALUES (?, ?, ?, 'approver')`)
        .bind("agm_payment_approver", approvalGroupId, TEST_USER.id),
      getDb(env)
        .prepare(`INSERT INTO approval_group_members (id, approval_group_id, user_id, role)
           VALUES (?, ?, ?, 'approver')`)
        .bind("agm_payment_separate_approver", approvalGroupId, approverUserId),
    ]);
    await seedWalletControlProfile({
      rules: [
        {
          id: "group-approve-payment-execution",
          kind: "approval",
          operationTypes: ["payment_transfer_execute"],
          approvalGroupId,
        },
      ],
    });
    const apiHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
    };
    const pendingResponse = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      },
      {}
    );
    const pendingBody = await readErrorResponse(pendingResponse);
    const pendingDetails = approvalErrorDetailsSchema.parse(pendingBody.error.details);
    const approvalPath = `/v1/wallets/approval-requests/${pendingDetails.approvalRequestId}/approve`;
    const ownerClerkHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await signSeededClerkMember(env, getDb(env), TEST_USER.id, TEST_ORG.id)}`,
      "x-project-id": TEST_PROJECT.id,
    };
    const approverClerkHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await signSeededClerkMember(env, getDb(env), approverUserId, TEST_ORG.id)}`,
      "x-project-id": TEST_PROJECT.id,
    };
    const detailPath = `/v1/wallets/approval-requests/${pendingDetails.approvalRequestId}`;
    const ownerRead = walletApprovalHttpResponseSchema.parse(
      await (await app.request(detailPath, { headers: ownerClerkHeaders }, env)).json()
    );
    expect(ownerRead.data.approvalRequest).toMatchObject({
      viewerIsRequester: true,
      viewerCanDecide: false,
    });
    const approverRead = walletApprovalHttpResponseSchema.parse(
      await (await app.request(detailPath, { headers: approverClerkHeaders }, env)).json()
    );
    expect(approverRead.data.approvalRequest).toMatchObject({
      viewerIsRequester: false,
      viewerCanDecide: true,
    });
    const outsiderClerkHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${await signSeededClerkMember(env, getDb(env), outsiderUserId, TEST_ORG.id)}`,
      "x-project-id": TEST_PROJECT.id,
    };
    const outsiderRead = await app.request(detailPath, { headers: outsiderClerkHeaders }, env);
    expect(outsiderRead.status).toBe(200);
    expect(
      walletApprovalHttpResponseSchema.parse(await outsiderRead.json()).data.approvalRequest
    ).toMatchObject({ viewerIsRequester: false, viewerCanDecide: false });
    const outsiderDecision = await app.request(
      approvalPath,
      { method: "POST", headers: outsiderClerkHeaders },
      env
    );
    expect(outsiderDecision.status).toBe(403);
    expect(await outsiderDecision.json()).toMatchObject({
      error: { message: "Approval request must be decided by an active approval-group member" },
    });
    const listed = walletApprovalListHttpResponseSchema.parse(
      await (
        await app.request("/v1/wallets/approval-requests", { headers: apiHeaders }, env)
      ).json()
    );
    expect(
      listed.data.approvalRequests.find((item) => item.id === pendingDetails.approvalRequestId)
    ).toMatchObject({ viewerIsRequester: true, viewerCanDecide: false });
    const apiKeyDecision = await app.request(
      approvalPath,
      { method: "POST", headers: apiHeaders },
      env
    );
    expect(apiKeyDecision.status).toBe(403);
    const ownerDecision = await app.request(
      approvalPath,
      {
        method: "POST",
        headers: ownerClerkHeaders,
      },
      env
    );
    expect(ownerDecision.status).toBe(403);
    expect(await ownerDecision.json()).toMatchObject({
      error: { message: "Approval requests must be decided by a different principal" },
    });
    const memberDecision = await app.request(
      approvalPath,
      {
        method: "POST",
        headers: approverClerkHeaders,
      },
      env
    );
    expect(memberDecision.status).toBe(200);
    const memberBody = walletApprovalHttpResponseSchema.parse(await memberDecision.json());
    expect(memberBody.data.approvalRequest).toMatchObject({
      status: "approved",
      operation: { status: "completed" },
    });
    const selfRequested = await postTransfer(
      {
        sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.2",
      },
      { auth: { kind: "clerk", token: ownerClerkHeaders.Authorization.slice("Bearer ".length) } }
    );
    expect(selfRequested.status).toBe(202);
    const selfRequestedBody = await readErrorResponse(selfRequested);
    const selfRequestedDetails = approvalErrorDetailsSchema.parse(selfRequestedBody.error.details);
    const selfApproval = await app.request(
      `/v1/wallets/approval-requests/${selfRequestedDetails.approvalRequestId}/approve`,
      { method: "POST", headers: ownerClerkHeaders },
      env
    );
    expect(selfApproval.status).toBe(403);
    const mixedAuthSelfApproval = await app.request(
      `/v1/wallets/approval-requests/${selfRequestedDetails.approvalRequestId}/approve`,
      { method: "POST", headers: apiHeaders },
      env
    );
    expect(mixedAuthSelfApproval.status).toBe(403);
    expect(await mixedAuthSelfApproval.json()).toMatchObject({
      error: { message: "Approval requests must be decided by a different principal" },
    });
    const mixedAuthSelfCancel = await app.request(
      `/v1/wallets/approval-requests/${selfRequestedDetails.approvalRequestId}/cancel`,
      { method: "POST", headers: apiHeaders },
      env
    );
    expect(mixedAuthSelfCancel.status).toBe(200);
  });
  it.each([
    {
      name: "still awaiting this deposit",
      event: null,
      executionError: null,
      transferStatus: "settling",
    },
    {
      name: "failed by the provider",
      event: { kind: "failed", error: "Deposit timeout" },
      executionError: "Ramp transfer is no longer awaiting payment (status: failed)",
      transferStatus: "failed",
    },
    {
      name: "moved to a new deposit address",
      event: {
        kind: "awaiting_payment",
        cryptoDeposit: { destinationAddress: TEST_SOLANA_ADDRESSES.wallet3, amount: "1" },
      },
      executionError: "Transfer does not match the off-ramp deposit instruction",
      transferStatus: "awaiting_payment",
    },
  ] as const)(
    "approves a held off-ramp deposit whose sale was $name",
    async ({ event, executionError, transferStatus }) => {
      const approverUserId = "usr_test_offramp_deposit_approver";
      await getDb(env).batch([
        getDb(env)
          .prepare(
            "INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
          )
          .bind(approverUserId, "offramp-deposit-approver@example.com"),
        getDb(env)
          .prepare(`INSERT INTO organization_members (id, organization_id, user_id, role, status)
             VALUES (?, ?, ?, 'admin', 'active')`)
          .bind("om_offramp_deposit_approver", TEST_ORG.id, approverUserId),
        getDb(env)
          .prepare(`INSERT INTO project_members (id, project_id, user_id, role)
             VALUES (?, ?, ?, 'admin')`)
          .bind("pm_offramp_deposit_approver", TEST_PROJECT.id, approverUserId),
      ]);
      await seedWalletControlProfile({
        rules: [
          {
            id: "approve-offramp-deposit",
            kind: "approval",
            operationTypes: ["payment_transfer_execute"],
          },
        ],
      });
      const transferId = generatePaymentTransferId();
      const tenant = createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id });
      await createPostgresPaymentsRepository(getDb(env), tenant).createTransfer({
        id: transferId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        custodyWalletId: TEST_CUSTODY_WALLET_ID,
        walletId: TEST_WALLET_ID,
        counterpartyId: null,
        sourceAddress: TEST_SOLANA_ADDRESSES.wallet1,
        destinationAddress: null,
        token: SOL_MINT,
        amount: "1",
        memo: null,
        type: "offramp",
        direction: "outbound",
        status: "awaiting_payment",
        provider: "moonpay",
        providerReference: "moonpay-held-deposit",
        deliveryMode: "hosted",
        fiatCurrency: "USD",
        fiatAmount: "100",
        providerData: {
          cryptoDeposit: { destinationAddress: TEST_SOLANA_ADDRESSES.wallet2, amount: "1" },
        },
        serializedTx: null,
        signature: null,
        slot: null,
        initiatedByKeyId: TEST_API_KEY.id,
        idempotencyKey: null,
        idempotencyFingerprint: null,
      });
      const held = await postTransfer(
        {
          transferId,
          sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: "SOL",
          amount: "1",
        },
        {}
      );
      expect(held.status).toBe(202);
      const { approvalRequestId } = approvalErrorDetailsSchema.parse(
        (await readErrorResponse(held)).error.details
      );
      expect(await readTransferRow(transferId)).toMatchObject({
        status: "awaiting_payment",
        signature: null,
      });
      if (event !== null) {
        await applyRampSettlementEvent(env, {
          provider: "moonpay",
          reference: "moonpay-held-deposit",
          ...event,
        });
      }
      const approved = await app.request(
        `/v1/wallets/approval-requests/${approvalRequestId}/approve`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await signSeededClerkMember(env, getDb(env), approverUserId, TEST_ORG.id)}`,
            "x-project-id": TEST_PROJECT.id,
          },
        },
        env
      );
      expect(approved.status).toBe(200);
      const approvedBody = walletApprovalHttpResponseSchema.parse(await approved.json());
      expect(approvedBody.data.approvalRequest).toMatchObject({
        status: "approved",
        operation: {
          status: executionError === null ? "completed" : "failed",
          executionError,
        },
      });
      const row = await readTransferRow(transferId);
      expect(row.status).toBe(transferStatus);
      if (executionError === null) {
        expect(row.signature).toBeTruthy();
        expect(row.destination_address).toBe(TEST_SOLANA_ADDRESSES.wallet2);
      } else {
        expect(row.signature).toBeNull();
      }
    }
  );
});
