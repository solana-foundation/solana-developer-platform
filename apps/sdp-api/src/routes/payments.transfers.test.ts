import type * as feePaymentAdapters from "@sdp/payments/fee-payment";
import type * as solanaRpc from "@sdp/rpc/solana";
import { type PolicyDefaultAction, type PolicyRule, SOL_MINT } from "@sdp/types";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPostgresPolicyRepository } from "@/db/repositories";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import app from "@/index";
import { buildPaymentTransferFingerprint } from "@/lib/idempotency";
import { createTenantScope } from "@/lib/tenant-scope";
import { recoverApprovedWalletOperations } from "@/services/policy/approved-operation-replay";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  createFeePaymentAdapterMock,
  createOrgSignerMock,
  createRpcMock,
  DEVNET_USDC_MINT,
  getRecentBlockhashMock,
  installPaymentsRouteTestHooks,
  mockRecurringActivationRpc,
  mockTokenSupplyDecimalsOnce,
  seedCachedKey,
  sendAndConfirmTransactionMock,
  TEST_API_KEY,
  TEST_CONFIG_ID,
  TEST_CUSTODY_WALLET_ID,
  TEST_KORA_FEE_PAYER,
  TEST_ORG,
  TEST_PROJECT,
  TEST_SPONSORSHIP_PROVIDER_CONFIG,
  TEST_USER,
  TEST_WALLET_ID,
  updateSeededWalletPublicKey,
} from "@/test/helpers/payments-routes";

const TEST_ADDITIONAL_CUSTODY_WALLET_ID = "cwlt_payments_additional_test";

const TEST_ADDITIONAL_WALLET_ID = "wal_payments_additional_test";

const TEST_MAGICBLOCK_API_BASE_URL = "https://payments.magicblock.test";

const TEST_MAGICBLOCK_SPONSOR_FEE_PAYER = "CrankS2fXgMGvQJ3VBrZmRfGrfogDY6pq5YcgkPEpSNf";

function buildMagicBlockTestTransactionBase64(params?: {
  feePayer?: string;
  source?: string;
  destination?: string;
  additionalSigner?: string;
}): string {
  const feePayer = address(params?.feePayer ?? params?.source ?? TEST_SOLANA_ADDRESSES.wallet1);
  const source = address(params?.source ?? TEST_SOLANA_ADDRESSES.wallet1);
  const destination = address(params?.destination ?? TEST_SOLANA_ADDRESSES.wallet2);
  const instructions = [
    getTransferSolInstruction({
      source: createNoopSigner(source),
      destination,
      amount: 1n,
    }),
  ];

  if (params?.additionalSigner) {
    instructions.push(
      getTransferSolInstruction({
        source: createNoopSigner(address(params.additionalSigner)),
        destination: source,
        amount: 1n,
      })
    );
  }

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N" as Parameters<
            typeof setTransactionMessageLifetimeUsingBlockhash
          >[0]["blockhash"],
          lastValidBlockHeight: 1000n,
        },
        m
      ),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );

  return getBase64EncodedWireTransaction(compileTransaction(message));
}

function mockMagicBlockAdditionalSignerResponse(
  sourceAddress: string,
  additionalSignerAddress: string
) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        kind: "transfer",
        version: "v0",
        transactionBase64: buildMagicBlockTestTransactionBase64({
          source: sourceAddress,
          additionalSigner: additionalSignerAddress,
        }),
        sendTo: "base",
        recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
        lastValidBlockHeight: 123456,
        instructionCount: 4,
        requiredSigners: [sourceAddress, additionalSignerAddress],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    )
  );
}

async function requestMagicBlockPrivateTransfer(): Promise<Response> {
  return app.request(
    "/v1/payments/transfers",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
      },
      body: JSON.stringify({
        source: TEST_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: DEVNET_USDC_MINT,
        amount: "1",
        privateTransfer: {
          provider: "magicblock",
          magicBlock: {},
        },
      }),
    },
    env
  );
}

async function seedAdditionalCustodyWallet(publicKey: string): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_wallets
         (id, custody_config_id, wallet_id, public_key, label, purpose, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      TEST_ADDITIONAL_CUSTODY_WALLET_ID,
      TEST_CONFIG_ID,
      TEST_ADDITIONAL_WALLET_ID,
      publicKey,
      "Additional Payments Wallet",
      "transfer",
      "active"
    )
    .run();
}

async function seedWalletControlProfile(params: {
  rules: PolicyRule[];
  defaultAction?: PolicyDefaultAction;
  custodyWalletId?: string;
}): Promise<void> {
  const repo = createPostgresPolicyRepository(
    getDb(env),
    createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
  );
  const profile = await repo.createWalletControlProfile({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    custodyWalletId: params.custodyWalletId ?? TEST_CUSTODY_WALLET_ID,
    name: "Payment controls",
    createdBy: TEST_USER.id,
  });

  if (!profile) {
    throw new Error("Failed to create wallet control profile");
  }

  const revision = await repo.createWalletControlProfileRevision({
    profileId: profile.id,
    rules: params.rules,
    defaultAction: params.defaultAction,
    createdBy: TEST_USER.id,
  });

  if (!revision) {
    throw new Error("Failed to create wallet control profile revision");
  }

  await repo.activateWalletControlProfileRevision({
    profileId: profile.id,
    revisionId: revision.id,
  });
}

describe("Payments routes — transfers", () => {
  installPaymentsRouteTestHooks();

  it("activates immutable wallet control profile revisions from wallet policy updates", async () => {
    await getDb(env)
      .prepare("UPDATE custody_configs SET project_id = ? WHERE id = ?")
      .bind(TEST_PROJECT.id, TEST_CONFIG_ID)
      .run();

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
    const updateBody = (await updateRes.json()) as {
      data: {
        policy: {
          walletId: string;
          defaultAction?: string;
          rules?: unknown[];
          controlProfile?: {
            id: string;
            status: string;
            revisionId: string;
            revisionNumber: number;
            providerMappingStatus: string;
          };
        };
      };
    };
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
      .prepare(
        `SELECT revision_number, default_action, commit_message, rules
         FROM wallet_control_profile_revisions
         ORDER BY revision_number ASC`
      )
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
    const secondBody = (await secondRes.json()) as typeof updateBody;
    expect(secondBody.data.policy.controlProfile?.id).toBe(
      updateBody.data.policy.controlProfile?.id
    );
    expect(secondBody.data.policy.controlProfile?.revisionNumber).toBe(2);

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
    const getBody = (await getRes.json()) as typeof updateBody;
    expect(getBody.data.policy.controlProfile).toMatchObject({
      id: updateBody.data.policy.controlProfile?.id,
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
    const body = (await updateRes.json()) as {
      error: { code: string; message: string; details?: { errors?: Record<string, string[]> } };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Invalid request body");
    expect(body.error.details?.errors?.rules).toContain(
      "operation type must be one of the supported wallet operation types"
    );
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
    const body = (await updateRes.json()) as {
      error: { code: string; message: string; details?: { errors?: Record<string, string[]> } };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.details?.errors?.rules).toContain("Duplicate rule id: duplicated");
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

    const response = await app.request(
      "/v1/payments/transfers",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Dry-Run": "true",
        },
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: "SOL",
          amount: "0.1",
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        decision: string;
        criteria: Array<{ ruleId: string | null; matched: boolean; action: string | null }>;
        walletPolicyRevisionId: string | null;
      };
    };
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
      const row = await getDb(env)
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .first<{ count: number | string }>();
      expect(Number(row?.count ?? 0)).toBe(0);
    }
  });

  it("answers a dry-run with the verdict even when an Idempotency-Key matches a recorded transfer", async () => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
      "Idempotency-Key": "idem-dry-run-replay",
    };
    const transferBody = JSON.stringify({
      source: TEST_WALLET_ID,
      destination: TEST_SOLANA_ADDRESSES.wallet2,
      token: "SOL",
      amount: "0.1",
    });

    const first = await app.request(
      "/v1/payments/transfers",
      { method: "POST", headers, body: transferBody },
      env
    );
    expect(first.status).toBe(200);

    const dryRun = await app.request(
      "/v1/payments/transfers",
      { method: "POST", headers: { ...headers, "Dry-Run": "true" }, body: transferBody },
      env
    );
    expect(dryRun.status).toBe(200);
    const dryRunBody = (await dryRun.json()) as { data: { decision: string; criteria: unknown } };
    expect(dryRunBody.data.decision).toBe("allow");
    expect(dryRunBody.data).toHaveProperty("criteria");
  });

  it("rejects an invalid body before evaluating a dry-run", async () => {
    const response = await app.request(
      "/v1/payments/transfers",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Dry-Run": "true",
        },
        body: JSON.stringify({ source: TEST_WALLET_ID }),
      },
      env
    );

    expect(response.status).toBe(400);
  });

  it("executes an approved transfer exactly once after leaving it pending", async () => {
    const sessionId = "ses_ungrouped_payment_approver";
    const approverUserId = "usr_ungrouped_payment_approver";
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(approverUserId, "ungrouped-payment-approver@example.com"),
      getDb(env)
        .prepare(
          `INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES (?, ?, ?, 'member', 'active')`
        )
        .bind("om_ungrouped_payment_approver", TEST_ORG.id, approverUserId),
      getDb(env)
        .prepare(
          `INSERT INTO project_members (id, project_id, user_id, role)
           VALUES (?, ?, ?, 'admin')`
        )
        .bind("pm_ungrouped_payment_approver", TEST_PROJECT.id, approverUserId),
      getDb(env)
        .prepare(
          `INSERT INTO sessions (id, user_id, organization_id, auth_method, expires_at)
           VALUES (?, ?, ?, 'session', ?)`
        )
        .bind(sessionId, approverUserId, TEST_ORG.id, "2099-01-01T00:00:00.000Z"),
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
    const apiHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
    };
    const adminHeaders = {
      Cookie: `sdp_session=${sessionId}`,
      "x-project-id": TEST_PROJECT.id,
    };

    const pendingResponse = await app.request(
      "/v1/payments/transfers",
      {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: "SOL",
          amount: "0.1",
        }),
      },
      env
    );
    expect(pendingResponse.status).toBe(202);
    const pendingBody = (await pendingResponse.json()) as {
      error: { details: { approvalRequestId: string; walletOperationId: string } };
    };
    const { approvalRequestId, walletOperationId } = pendingBody.error.details;
    expect(approvalRequestId).toMatch(/^appr_/);
    expect(walletOperationId).toMatch(/^wop_/);

    const beforeApproval = await getDb(env)
      .prepare("SELECT COUNT(*) AS count FROM payment_transfers")
      .first<{ count: number | string }>();
    expect(Number(beforeApproval?.count ?? 0)).toBe(0);

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
    const approvedBody = (await approvedResponse.json()) as {
      data: {
        approvalRequest: {
          status: string;
          operation: {
            status: string;
            executionStartedAt: string | null;
            executionCompletedAt: string | null;
            executionError: string | null;
          };
        };
      };
    };
    expect(approvedBody.data.approvalRequest).toMatchObject({
      status: "approved",
      operation: {
        status: "completed",
        executionError: null,
      },
    });
    expect(approvedBody.data.approvalRequest.operation.executionStartedAt).toBeTruthy();
    expect(approvedBody.data.approvalRequest.operation.executionCompletedAt).toBeTruthy();

    const transfers = await getDb(env)
      .prepare("SELECT status FROM payment_transfers")
      .all<{ status: string }>();
    expect(transfers.results).toEqual([{ status: "confirmed" }]);
    const fencedOperation = await getDb(env)
      .prepare("SELECT execution_effect_started_at FROM wallet_operations WHERE id = ?")
      .bind(walletOperationId)
      .first<{ execution_effect_started_at: string | null }>();
    expect(fencedOperation?.execution_effect_started_at).toBeTruthy();

    const replayedApproval = await approve();
    expect(replayedApproval.status).toBe(200);
    const transferCount = await getDb(env)
      .prepare("SELECT COUNT(*) AS count FROM payment_transfers")
      .first<{ count: number | string }>();
    expect(Number(transferCount?.count ?? 0)).toBe(1);
  });

  it("recovers an expired execution claim with a fenced retry", async () => {
    await seedWalletControlProfile({
      rules: [
        {
          id: "approve-payment-recovery",
          kind: "approval",
          operationTypes: ["payment_transfer_execute"],
        },
      ],
    });
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_API_KEY.raw}`,
    };
    const pendingResponse = await app.request(
      "/v1/payments/transfers",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: "SOL",
          amount: "0.1",
        }),
      },
      env
    );
    const pendingBody = (await pendingResponse.json()) as {
      error: { details: { approvalRequestId: string; walletOperationId: string } };
    };
    const { approvalRequestId, walletOperationId } = pendingBody.error.details;
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
    const interrupted = await repository.claimWalletOperationExecution(
      walletOperationId,
      "interrupted-attempt"
    );
    expect(interrupted?.execution_attempts).toBe(1);
    await getDb(env)
      .prepare(
        `UPDATE wallet_operations
         SET execution_lease_expires_at = '2000-01-01T00:00:00.000Z'
         WHERE id = ?`
      )
      .bind(walletOperationId)
      .run();

    // The stale worker must lose terminal-write authority as soon as its lease
    // expires, even before recovery replaces its attempt ID.
    expect(
      await repository.completeWalletOperationExecution({
        walletOperationId,
        executionAttemptId: "interrupted-attempt",
        status: "failed",
        error: "stale worker",
      })
    ).toBeNull();
    expect(await repository.getWalletOperationById(walletOperationId)).toMatchObject({
      status: "executing",
      execution_attempt_id: "interrupted-attempt",
    });

    expect(await recoverApprovedWalletOperations(env)).toBe(1);
    const recovered = await repository.getWalletOperationById(walletOperationId);
    expect(recovered).toMatchObject({
      status: "completed",
      execution_attempts: 2,
      execution_error: null,
      execution_lease_expires_at: null,
    });
    expect(recovered?.execution_attempt_id).not.toBe("interrupted-attempt");

    const transferCount = await getDb(env)
      .prepare("SELECT COUNT(*) AS count FROM payment_transfers")
      .first<{ count: number | string }>();
    expect(Number(transferCount?.count ?? 0)).toBe(1);
  });

  it("fails recovery closed for an incomplete idempotent transfer", async () => {
    await seedWalletControlProfile({
      rules: [
        {
          id: "approve-payment-incomplete-replay",
          kind: "approval",
          operationTypes: ["payment_transfer_execute"],
        },
      ],
    });
    const idempotencyKey = "approved-incomplete-transfer";
    const pendingResponse = await app.request(
      "/v1/payments/transfers",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: "SOL",
          amount: "0.1",
        }),
      },
      env
    );
    expect(pendingResponse.status).toBe(202);
    const pendingBody = (await pendingResponse.json()) as {
      error: { details: { approvalRequestId: string; walletOperationId: string } };
    };
    const { approvalRequestId, walletOperationId } = pendingBody.error.details;
    const scope = createTenantScope({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
    });
    const policyRepository = createPostgresPolicyRepository(getDb(env), scope);
    await policyRepository.updateApprovalRequestStatus({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      approvalRequestId,
      status: "approved",
      operationStatus: "executing",
      resolvedBy: TEST_API_KEY.id,
    });
    await policyRepository.claimWalletOperationExecution(walletOperationId, "interrupted-attempt");

    const stranded = await createPostgresPaymentsRepository(getDb(env), scope).createTransfer({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      walletId: TEST_WALLET_ID,
      counterpartyId: null,
      sourceAddress: TEST_SOLANA_ADDRESSES.wallet1,
      destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
      token: SOL_MINT,
      amount: "0.1",
      memo: null,
      type: "transfer",
      direction: "outbound",
      status: "processing",
      provider: null,
      providerReference: null,
      deliveryMode: null,
      fiatCurrency: null,
      fiatAmount: null,
      providerData: {},
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: TEST_API_KEY.id,
      idempotencyKey,
      idempotencyFingerprint: buildPaymentTransferFingerprint({
        sourceAddress: TEST_SOLANA_ADDRESSES.wallet1,
        destinationAddress: TEST_SOLANA_ADDRESSES.wallet2,
        token: SOL_MINT,
        amount: "0.1",
        memo: undefined,
        type: "transfer",
      }),
    });
    if (!stranded) {
      throw new Error("Expected the stranded transfer fixture to be created");
    }
    expect(stranded).toMatchObject({ status: "processing", signature: null });
    await getDb(env)
      .prepare(
        `UPDATE wallet_operations
         SET execution_lease_expires_at = '2000-01-01T00:00:00.000Z'
         WHERE id = ?`
      )
      .bind(walletOperationId)
      .run();

    expect(await recoverApprovedWalletOperations(env)).toBe(1);
    const recovered = await policyRepository.getWalletOperationById(walletOperationId);
    expect(recovered).toMatchObject({
      status: "failed",
      execution_attempts: 2,
    });
    expect(recovered?.execution_effect_started_at).toBeTruthy();
    expect(recovered?.execution_error).toContain(
      "Approved transfer execution is incomplete and requires manual reconciliation"
    );

    const unchanged = await getDb(env)
      .prepare("SELECT status, signature FROM payment_transfers WHERE id = ?")
      .bind(stranded.id)
      .first<{ status: string; signature: string | null }>();
    expect(unchanged).toEqual({ status: "processing", signature: null });
  });

  it("requires manual reconciliation when an expired execution crossed its effect fence", async () => {
    await seedWalletControlProfile({
      rules: [
        {
          id: "approve-payment-ambiguous-recovery",
          kind: "approval",
          operationTypes: ["payment_transfer_execute"],
        },
      ],
    });
    const pendingResponse = await app.request(
      "/v1/payments/transfers",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: "SOL",
          amount: "0.1",
        }),
      },
      env
    );
    const pendingBody = (await pendingResponse.json()) as {
      error: { details: { approvalRequestId: string; walletOperationId: string } };
    };
    const { approvalRequestId, walletOperationId } = pendingBody.error.details;
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
    await repository.claimWalletOperationExecution(walletOperationId, "ambiguous-attempt");
    expect(
      await repository.beginWalletOperationExecutionEffect(walletOperationId, "ambiguous-attempt")
    ).toBe(true);
    const firstEffect = await repository.getWalletOperationById(walletOperationId);
    expect(
      await repository.beginWalletOperationExecutionEffect(walletOperationId, "ambiguous-attempt")
    ).toBe(true);
    const repeatedEffect = await repository.getWalletOperationById(walletOperationId);
    expect(repeatedEffect?.execution_effect_started_at).toBe(
      firstEffect?.execution_effect_started_at
    );
    await getDb(env)
      .prepare(
        `UPDATE wallet_operations
         SET execution_lease_expires_at = '2000-01-01T00:00:00.000Z'
         WHERE id = ?`
      )
      .bind(walletOperationId)
      .run();

    expect(await recoverApprovedWalletOperations(env)).toBe(0);
    const reconciled = await repository.getWalletOperationById(walletOperationId);
    expect(reconciled).toMatchObject({
      status: "failed",
      execution_attempt_id: "ambiguous-attempt",
      execution_attempts: 1,
      execution_lease_expires_at: null,
    });
    expect(reconciled?.execution_effect_started_at).toBeTruthy();
    expect(reconciled?.execution_completed_at).toBeTruthy();
    expect(reconciled?.execution_error).toContain("manual reconciliation");

    const transferCount = await getDb(env)
      .prepare("SELECT COUNT(*) AS count FROM payment_transfers")
      .first<{ count: number | string }>();
    expect(Number(transferCount?.count ?? 0)).toBe(0);
  });

  it("requires the configured approval-group member to approve execution", async () => {
    const approvalGroupId = "apg_payment_execution";
    const ownerSessionId = "ses_payment_request_owner";
    const approverSessionId = "ses_payment_approver";
    const approverUserId = "usr_payment_approver";
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(approverUserId, "payment-approver@example.com"),
      getDb(env)
        .prepare(
          `INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES (?, ?, ?, 'admin', 'active')`
        )
        .bind("om_payment_approver", TEST_ORG.id, TEST_USER.id),
      getDb(env)
        .prepare(
          `INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES (?, ?, ?, 'admin', 'active')`
        )
        .bind("om_payment_separate_approver", TEST_ORG.id, approverUserId),
      getDb(env)
        .prepare(
          `INSERT INTO project_members (id, project_id, user_id, role)
           VALUES (?, ?, ?, 'admin')`
        )
        .bind("pm_payment_approver", TEST_PROJECT.id, TEST_USER.id),
      getDb(env)
        .prepare(
          `INSERT INTO project_members (id, project_id, user_id, role)
           VALUES (?, ?, ?, 'admin')`
        )
        .bind("pm_payment_separate_approver", TEST_PROJECT.id, approverUserId),
      getDb(env)
        .prepare(
          `INSERT INTO sessions (id, user_id, organization_id, auth_method, expires_at)
           VALUES (?, ?, ?, 'session', ?)`
        )
        .bind(ownerSessionId, TEST_USER.id, TEST_ORG.id, "2099-01-01T00:00:00.000Z"),
      getDb(env)
        .prepare(
          `INSERT INTO sessions (id, user_id, organization_id, auth_method, expires_at)
           VALUES (?, ?, ?, 'session', ?)`
        )
        .bind(approverSessionId, approverUserId, TEST_ORG.id, "2099-01-01T00:00:00.000Z"),
      getDb(env)
        .prepare(
          `INSERT INTO approval_groups (id, organization_id, project_id, name, status, created_by)
           VALUES (?, ?, ?, 'Payment approvers', 'active', ?)`
        )
        .bind(approvalGroupId, TEST_ORG.id, TEST_PROJECT.id, TEST_USER.id),
      getDb(env)
        .prepare(
          `INSERT INTO approval_group_members (id, approval_group_id, user_id, role)
           VALUES (?, ?, ?, 'approver')`
        )
        .bind("agm_payment_approver", approvalGroupId, TEST_USER.id),
      getDb(env)
        .prepare(
          `INSERT INTO approval_group_members (id, approval_group_id, user_id, role)
           VALUES (?, ?, ?, 'approver')`
        )
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
    const pendingResponse = await app.request(
      "/v1/payments/transfers",
      {
        method: "POST",
        headers: apiHeaders,
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: "SOL",
          amount: "0.1",
        }),
      },
      env
    );
    const pendingBody = (await pendingResponse.json()) as {
      error: { details: { approvalRequestId: string } };
    };
    const approvalPath = `/v1/wallets/approval-requests/${pendingBody.error.details.approvalRequestId}/approve`;
    const ownerSessionHeaders = {
      "Content-Type": "application/json",
      Cookie: `sdp_session=${ownerSessionId}`,
      "x-project-id": TEST_PROJECT.id,
    };
    const approverSessionHeaders = {
      "Content-Type": "application/json",
      Cookie: `sdp_session=${approverSessionId}`,
      "x-project-id": TEST_PROJECT.id,
    };

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
        headers: ownerSessionHeaders,
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
        headers: approverSessionHeaders,
      },
      env
    );
    expect(memberDecision.status).toBe(200);
    const memberBody = (await memberDecision.json()) as {
      data: { approvalRequest: { status: string; operation: { status: string } } };
    };
    expect(memberBody.data.approvalRequest).toMatchObject({
      status: "approved",
      operation: { status: "completed" },
    });

    const selfRequested = await app.request(
      "/v1/payments/transfers",
      {
        method: "POST",
        headers: ownerSessionHeaders,
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: "SOL",
          amount: "0.2",
        }),
      },
      env
    );
    expect(selfRequested.status).toBe(202);
    const selfRequestedBody = (await selfRequested.json()) as {
      error: { details: { approvalRequestId: string } };
    };
    const selfApproval = await app.request(
      `/v1/wallets/approval-requests/${selfRequestedBody.error.details.approvalRequestId}/approve`,
      { method: "POST", headers: ownerSessionHeaders },
      env
    );
    expect(selfApproval.status).toBe(403);
    const mixedAuthSelfApproval = await app.request(
      `/v1/wallets/approval-requests/${selfRequestedBody.error.details.approvalRequestId}/approve`,
      { method: "POST", headers: apiHeaders },
      env
    );
    expect(mixedAuthSelfApproval.status).toBe(403);
    expect(await mixedAuthSelfApproval.json()).toMatchObject({
      error: { message: "Approval requests must be decided by a different principal" },
    });
    const mixedAuthSelfCancel = await app.request(
      `/v1/wallets/approval-requests/${selfRequestedBody.error.details.approvalRequestId}/cancel`,
      { method: "POST", headers: apiHeaders },
      env
    );
    expect(mixedAuthSelfCancel.status).toBe(200);
  });

  it("blocks create transfer to a destination outside the control-profile allowlist", async () => {
    await seedWalletControlProfile({
      rules: [
        {
          id: "destination-allowlist",
          kind: "destination",
          allowlist: [TEST_SOLANA_ADDRESSES.wallet2],
          action: "allow",
        },
      ],
    });

    const res = await app.request(
      "/v1/payments/transfers",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet3,
          token: "SOL",
          amount: "0.7",
        }),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; details: { decision: string; reason: string } };
    };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.details.decision).toBe("deny");
    expect(body.error.details.reason).toContain(
      `Destination ${TEST_SOLANA_ADDRESSES.wallet3} is not allowed by policy.`
    );

    const transfers = await getDb(env).prepare("SELECT id FROM payment_transfers").all<{
      id: string;
    }>();
    expect(transfers.results).toHaveLength(0);

    const operation = await getDb(env)
      .prepare("SELECT status, operation_family, operation_type FROM wallet_operations")
      .first<{ status: string; operation_family: string; operation_type: string }>();
    expect(operation).toMatchObject({
      status: "failed",
      operation_family: "payment",
      operation_type: "payment_transfer_execute",
    });

    const evaluation = await getDb(env)
      .prepare("SELECT decision FROM policy_evaluations")
      .first<{ decision: string }>();
    expect(evaluation?.decision).toBe("deny");
  });

  it("creates a transfer to a destination on the control-profile allowlist", async () => {
    await seedWalletControlProfile({
      rules: [
        {
          id: "destination-allowlist",
          kind: "destination",
          allowlist: [TEST_SOLANA_ADDRESSES.wallet2],
          action: "allow",
        },
      ],
    });

    const res = await app.request(
      "/v1/payments/transfers",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: "SOL",
          amount: "0.7",
        }),
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { transfer: { id: string; status: string } };
    };
    expect(body.data.transfer.status).toBe("confirmed");

    const evaluation = await getDb(env)
      .prepare("SELECT decision FROM policy_evaluations")
      .first<{ decision: string }>();
    expect(evaluation?.decision).toBe("allow");
  });

  it("blocks create transfer with zero amount before creating a transfer record", async () => {
    const res = await app.request(
      "/v1/payments/transfers",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: "SOL",
          amount: "0",
        }),
      },
      env
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: { errors?: Record<string, string[]> } };
    };
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("Invalid request body");
    expect(body.error.details?.errors?.amount).toContain("Amount must be greater than zero");

    const transfers = await getDb(env).prepare("SELECT id FROM payment_transfers").all<{
      id: string;
    }>();
    expect(transfers.results).toHaveLength(0);
  });

  describe("execute transfer — happy path", () => {
    it("rejects MagicBlock execution when gasless sponsorship is explicitly disabled", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      try {
        const res = await app.request(
          "/v1/payments/transfers",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TEST_API_KEY.raw}`,
            },
            body: JSON.stringify({
              source: TEST_WALLET_ID,
              destination: TEST_SOLANA_ADDRESSES.wallet2,
              token: DEVNET_USDC_MINT,
              amount: "1",
              privateTransfer: {
                provider: "magicblock",
                magicBlock: {
                  gasless: false,
                },
              },
            }),
          },
          env
        );

        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("BAD_REQUEST");
        expect(body.error.message).toContain("requires gasless transactions");
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("executes a MagicBlock private transfer that settles to base balance", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      await seedCachedKey({
        walletBindings: [{ walletId: TEST_WALLET_ID, permissions: ["payments:write"] }],
      });
      createRpcMock.mockReturnValueOnce({
        getTokenSupply: () => ({
          send: async () => ({ value: { decimals: 6 } }),
        }),
        getFeeForMessage: () => ({ send: async () => ({ value: 5000n }) }),
      } as unknown as ReturnType<typeof solanaRpc.createRpc>);
      createOrgSignerMock.mockResolvedValueOnce(sourceSigner);
      const signAndSendMock = vi
        .fn()
        .mockResolvedValue(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
        );
      createFeePaymentAdapterMock.mockReturnValue({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
        signAsFeePayer: vi.fn(),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "transfer",
            version: "v0",
            transactionBase64: buildMagicBlockTestTransactionBase64({
              source: sourceSigner.address,
            }),
            sendTo: "base",
            recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
            lastValidBlockHeight: 123456,
            instructionCount: 3,
            requiredSigners: [sourceSigner.address, sourceSigner.address],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );

      try {
        const res = await app.request(
          "/v1/payments/transfers",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TEST_API_KEY.raw}`,
            },
            body: JSON.stringify({
              source: TEST_WALLET_ID,
              destination: TEST_SOLANA_ADDRESSES.wallet2,
              token: DEVNET_USDC_MINT,
              amount: "1",
              privateTransfer: {
                provider: "magicblock",
                magicBlock: {
                  split: 2,
                  minDelayMs: "0",
                  maxDelayMs: "1000",
                },
              },
            }),
          },
          env
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          data: {
            transfer: { status: string; signature: string | null; type: string };
            privateTransfer: { magicBlock: { kind: string; version: string } };
          };
        };
        expect(body.data.transfer).toMatchObject({
          status: "confirmed",
          signature:
            "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy",
          type: "transfer_confidential",
        });
        expect(body.data.privateTransfer.magicBlock).toMatchObject({
          kind: "transfer",
          version: "v0",
        });
        expect(signAndSendMock).toHaveBeenCalledTimes(1);
        expect(sendAndConfirmTransactionMock).not.toHaveBeenCalled();
        const [, init] = fetchSpy.mock.calls[0] ?? [];
        const providerPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(providerPayload).toMatchObject({
          from: sourceSigner.address,
          visibility: "private",
          fromBalance: "base",
          toBalance: "base",
          split: 2,
          minDelayMs: "0",
          maxDelayMs: "1000",
          gasless: true,
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("does not re-run MagicBlock preparation on an idempotent replay", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      createRpcMock.mockReturnValue({
        getTokenSupply: () => ({ send: async () => ({ value: { decimals: 6 } }) }),
        getFeeForMessage: () => ({ send: async () => ({ value: 5000n }) }),
      } as unknown as ReturnType<typeof solanaRpc.createRpc>);
      createOrgSignerMock.mockResolvedValue(sourceSigner);
      const signAndSendMock = vi
        .fn()
        .mockResolvedValue(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
        );
      createFeePaymentAdapterMock.mockReturnValueOnce({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
        signAsFeePayer: vi.fn(),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            kind: "transfer",
            version: "v0",
            transactionBase64: buildMagicBlockTestTransactionBase64({
              source: sourceSigner.address,
            }),
            sendTo: "base",
            recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
            lastValidBlockHeight: 123456,
            instructionCount: 3,
            requiredSigners: [sourceSigner.address, sourceSigner.address],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      try {
        const headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Idempotency-Key": "confidential-replay-key",
        };
        const body = JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: DEVNET_USDC_MINT,
          amount: "1",
          privateTransfer: {
            provider: "magicblock",
            magicBlock: { split: 2, minDelayMs: "0", maxDelayMs: "1000" },
          },
        });

        const first = await app.request(
          "/v1/payments/transfers",
          { method: "POST", headers, body },
          env
        );
        const second = await app.request(
          "/v1/payments/transfers",
          { method: "POST", headers, body },
          env
        );

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        const firstBody = (await first.json()) as {
          data: { transfer: { id: string }; privateTransfer: unknown };
        };
        const secondBody = (await second.json()) as {
          data: { transfer: { id: string }; privateTransfer: unknown };
        };
        expect(secondBody.data.transfer.id).toBe(firstBody.data.transfer.id);
        expect(secondBody.data.privateTransfer).toEqual(firstBody.data.privateTransfer);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(signAndSendMock).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("rejects a confidential replay when magicBlock options differ", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      createRpcMock.mockReturnValue({
        getTokenSupply: () => ({ send: async () => ({ value: { decimals: 6 } }) }),
        getFeeForMessage: () => ({ send: async () => ({ value: 5000n }) }),
      } as unknown as ReturnType<typeof solanaRpc.createRpc>);
      createOrgSignerMock.mockResolvedValue(sourceSigner);
      const signAndSendMock = vi
        .fn()
        .mockResolvedValue(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
        );
      createFeePaymentAdapterMock.mockReturnValue({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
        signAsFeePayer: vi.fn(),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            kind: "transfer",
            version: "v0",
            transactionBase64: buildMagicBlockTestTransactionBase64({
              source: sourceSigner.address,
            }),
            sendTo: "base",
            recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
            lastValidBlockHeight: 123456,
            instructionCount: 3,
            requiredSigners: [sourceSigner.address, sourceSigner.address],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      try {
        const headers = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
          "Idempotency-Key": "confidential-opts-key",
        };
        const bodyA = JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: DEVNET_USDC_MINT,
          amount: "1",
          privateTransfer: {
            provider: "magicblock",
            magicBlock: { split: 2, minDelayMs: "0", maxDelayMs: "1000" },
          },
        });
        const bodyB = JSON.stringify({
          source: TEST_WALLET_ID,
          destination: TEST_SOLANA_ADDRESSES.wallet2,
          token: DEVNET_USDC_MINT,
          amount: "1",
          privateTransfer: {
            provider: "magicblock",
            magicBlock: { split: 3, minDelayMs: "0", maxDelayMs: "1000" },
          },
        });
        const first = await app.request(
          "/v1/payments/transfers",
          { method: "POST", headers, body: bodyA },
          env
        );
        const conflict = await app.request(
          "/v1/payments/transfers",
          { method: "POST", headers, body: bodyB },
          env
        );
        expect(first.status).toBe(200);
        expect(conflict.status).toBe(409);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("replaces a MagicBlock gasless sponsor signer with Kora during execution", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      await seedCachedKey({
        walletBindings: [{ walletId: TEST_WALLET_ID, permissions: ["payments:write"] }],
      });
      createRpcMock.mockReturnValueOnce({
        getTokenSupply: () => ({
          send: async () => ({ value: { decimals: 6 } }),
        }),
        getFeeForMessage: () => ({ send: async () => ({ value: 5000n }) }),
      } as unknown as ReturnType<typeof solanaRpc.createRpc>);
      createOrgSignerMock.mockResolvedValueOnce(sourceSigner);
      const signAndSendMock = vi
        .fn()
        .mockResolvedValue(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
        );
      createFeePaymentAdapterMock.mockReturnValueOnce({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
        signAsFeePayer: vi.fn(),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "transfer",
            version: "v0",
            transactionBase64: buildMagicBlockTestTransactionBase64({
              feePayer: TEST_MAGICBLOCK_SPONSOR_FEE_PAYER,
              source: sourceSigner.address,
            }),
            sendTo: "base",
            recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
            lastValidBlockHeight: 123456,
            instructionCount: 5,
            requiredSigners: [TEST_MAGICBLOCK_SPONSOR_FEE_PAYER, sourceSigner.address],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );

      try {
        const res = await app.request(
          "/v1/payments/transfers",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TEST_API_KEY.raw}`,
            },
            body: JSON.stringify({
              source: TEST_WALLET_ID,
              destination: TEST_SOLANA_ADDRESSES.wallet2,
              token: DEVNET_USDC_MINT,
              amount: "5",
              privateTransfer: {
                provider: "magicblock",
                magicBlock: {},
              },
            }),
          },
          env
        );

        expect(res.status).toBe(200);
        expect(signAndSendMock).toHaveBeenCalledTimes(1);
        const [encodedTransaction] = signAndSendMock.mock.calls[0] ?? [];
        const transaction = getTransactionDecoder().decode(encodedTransaction as Uint8Array);
        const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
        expect(message.staticAccounts[0]).toBe(TEST_KORA_FEE_PAYER);
        expect(message.staticAccounts[1]).toBe(sourceSigner.address);
        expect(message.staticAccounts).not.toContain(TEST_MAGICBLOCK_SPONSOR_FEE_PAYER);
        expect(Object.keys(transaction.signatures)).toContain(TEST_KORA_FEE_PAYER);
        expect(Object.keys(transaction.signatures)).toContain(sourceSigner.address);
        expect(Object.keys(transaction.signatures)).not.toContain(
          TEST_MAGICBLOCK_SPONSOR_FEE_PAYER
        );
        const [, init] = fetchSpy.mock.calls[0] ?? [];
        const providerPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(providerPayload).toMatchObject({
          from: sourceSigner.address,
          visibility: "private",
          fromBalance: "base",
          toBalance: "base",
          gasless: true,
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("rejects an additional custody signer outside the API key wallet authorization boundary", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      const additionalSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      await seedAdditionalCustodyWallet(additionalSigner.address);
      await seedCachedKey({
        walletBindings: [{ walletId: TEST_WALLET_ID, permissions: ["payments:write"] }],
      });
      mockTokenSupplyDecimalsOnce();
      createOrgSignerMock.mockImplementation(async (_env, _organizationId, _projectId, walletId) =>
        walletId === TEST_ADDITIONAL_WALLET_ID ? additionalSigner : sourceSigner
      );

      const fetchSpy = mockMagicBlockAdditionalSignerResponse(
        sourceSigner.address,
        additionalSigner.address
      );

      try {
        const res = await requestMagicBlockPrivateTransfer();

        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("FORBIDDEN");
        expect(body.error.message).toContain("not authorized for the requested wallet");
        expect(createOrgSignerMock).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("signs with every custody signer authorized for the API key and transfer policy", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      const additionalSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      await seedAdditionalCustodyWallet(additionalSigner.address);
      await seedWalletControlProfile({
        custodyWalletId: TEST_ADDITIONAL_CUSTODY_WALLET_ID,
        rules: [
          {
            id: "additional-destination-allowlist",
            kind: "destination",
            allowlist: [TEST_SOLANA_ADDRESSES.wallet2],
            action: "allow",
          },
        ],
      });
      await seedCachedKey({
        walletBindings: [
          { walletId: TEST_WALLET_ID, permissions: ["payments:write"] },
          { walletId: TEST_ADDITIONAL_WALLET_ID, permissions: ["payments:write"] },
        ],
      });
      mockTokenSupplyDecimalsOnce();
      createOrgSignerMock.mockImplementation(async (_env, _organizationId, _projectId, walletId) =>
        walletId === TEST_ADDITIONAL_WALLET_ID ? additionalSigner : sourceSigner
      );
      const signAndSendMock = vi
        .fn()
        .mockResolvedValue(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
        );
      createFeePaymentAdapterMock.mockReturnValueOnce({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue(TEST_KORA_FEE_PAYER),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue(TEST_SPONSORSHIP_PROVIDER_CONFIG),
        signAsFeePayer: vi.fn(),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const fetchSpy = mockMagicBlockAdditionalSignerResponse(
        sourceSigner.address,
        additionalSigner.address
      );

      try {
        const res = await requestMagicBlockPrivateTransfer();

        expect(res.status).toBe(200);
        expect(createOrgSignerMock.mock.calls.map((call) => call[3])).toEqual([
          TEST_WALLET_ID,
          TEST_ADDITIONAL_WALLET_ID,
        ]);
        expect(signAndSendMock).toHaveBeenCalledTimes(1);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("rejects an authorized additional custody signer denied by its wallet policy", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      const additionalSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      await seedAdditionalCustodyWallet(additionalSigner.address);
      await seedWalletControlProfile({
        custodyWalletId: TEST_ADDITIONAL_CUSTODY_WALLET_ID,
        rules: [
          {
            id: "additional-destination-allowlist",
            kind: "destination",
            allowlist: [TEST_SOLANA_ADDRESSES.wallet3],
            action: "allow",
          },
        ],
      });
      await seedCachedKey({
        walletBindings: [
          { walletId: TEST_WALLET_ID, permissions: ["payments:write"] },
          { walletId: TEST_ADDITIONAL_WALLET_ID, permissions: ["payments:write"] },
        ],
      });
      mockTokenSupplyDecimalsOnce();
      const fetchSpy = mockMagicBlockAdditionalSignerResponse(
        sourceSigner.address,
        additionalSigner.address
      );

      try {
        const res = await requestMagicBlockPrivateTransfer();

        expect(res.status).toBe(403);
        const body = (await res.json()) as {
          error: { code: string; message: string; details: { decision: string; reason: string } };
        };
        expect(body.error.code).toBe("FORBIDDEN");
        expect(body.error.message).toBe("Wallet operation denied by policy");
        expect(body.error.details.decision).toBe("deny");
        expect(body.error.details.reason).toContain(
          `Destination ${TEST_SOLANA_ADDRESSES.wallet2} is not allowed by policy.`
        );
        expect(createOrgSignerMock).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("rejects MagicBlock execution responses routed outside base balance", async () => {
      env.MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL = TEST_MAGICBLOCK_API_BASE_URL;
      const sourceSigner = await generateKeyPairSigner();
      await updateSeededWalletPublicKey(sourceSigner.address);
      createRpcMock.mockReturnValueOnce({
        getTokenSupply: () => ({
          send: async () => ({ value: { decimals: 6 } }),
        }),
        getFeeForMessage: () => ({ send: async () => ({ value: 5000n }) }),
      } as unknown as ReturnType<typeof solanaRpc.createRpc>);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "transfer",
            version: "v0",
            transactionBase64: buildMagicBlockTestTransactionBase64({
              source: sourceSigner.address,
            }),
            sendTo: "ephemeral",
            recentBlockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N",
            lastValidBlockHeight: 123456,
            instructionCount: 3,
            requiredSigners: [sourceSigner.address],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      );

      try {
        const res = await app.request(
          "/v1/payments/transfers",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TEST_API_KEY.raw}`,
            },
            body: JSON.stringify({
              source: TEST_WALLET_ID,
              destination: TEST_SOLANA_ADDRESSES.wallet2,
              token: DEVNET_USDC_MINT,
              amount: "1",
              privateTransfer: {
                provider: "magicblock",
                magicBlock: {},
              },
            }),
          },
          env
        );

        expect(res.status).toBe(503);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("PROVIDER_UNAVAILABLE");
        expect(body.error.message).toBe(
          "MagicBlock returned a non-base submission target, which this SDP route does not support."
        );
        const [, init] = fetchSpy.mock.calls[0] ?? [];
        const providerPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(providerPayload).toMatchObject({
          from: sourceSigner.address,
          to: TEST_SOLANA_ADDRESSES.wallet2,
          visibility: "private",
          fromBalance: "base",
          toBalance: "base",
        });
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("blocks a transfer denied by an active wallet control profile before signing", async () => {
      await seedWalletControlProfile({
        rules: [{ id: "small-transfer-only", kind: "amount", max: "0.5", asset: SOL_MINT }],
      });

      const res = await app.request(
        "/v1/payments/transfers",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            source: TEST_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: "SOL",
            amount: "1",
          }),
        },
        env
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: {
          code: string;
          details: {
            walletOperationId: string;
            policyEvaluationId: string;
            decision: string;
          };
        };
      };
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.details).toMatchObject({
        decision: "deny",
      });
      expect(body.error.details.walletOperationId).toMatch(/^wop_/);
      expect(body.error.details.policyEvaluationId).toMatch(/^peval_/);
      expect(createOrgSignerMock).not.toHaveBeenCalled();

      const operation = await getDb(env)
        .prepare("SELECT status, operation_family, operation_type FROM wallet_operations")
        .first<{ status: string; operation_family: string; operation_type: string }>();
      expect(operation).toMatchObject({
        status: "failed",
        operation_family: "payment",
        operation_type: "payment_transfer_execute",
      });

      const evaluation = await getDb(env)
        .prepare("SELECT decision FROM policy_evaluations")
        .first<{ decision: string }>();
      expect(evaluation?.decision).toBe("deny");

      const transfers = await getDb(env).prepare("SELECT id FROM payment_transfers").all<{
        id: string;
      }>();
      expect(transfers.results).toHaveLength(0);
    });

    it("executes a SOL transfer and returns a confirmed transfer record", async () => {
      const res = await app.request(
        "/v1/payments/transfers",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            source: TEST_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: "SOL",
            amount: "1",
          }),
        },
        env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          transfer: { id: string; status: string; signature: string | null };
        };
      };
      expect(body.data.transfer.status).toBe("confirmed");
      expect(body.data.transfer.id).toMatch(/^xfr_/);
      expect(body.data.transfer.signature).toBeTruthy();

      const row = await getDb(env)
        .prepare("SELECT status, signature FROM payment_transfers WHERE id = ?")
        .bind(body.data.transfer.id)
        .first<{ status: string; signature: string | null }>();
      expect(row?.status).toBe("confirmed");
      expect(row?.signature).toBeTruthy();
    });

    it("replays a transfer when the same Idempotency-Key + body is retried", async () => {
      const signAndSendMock = vi
        .fn()
        .mockResolvedValue(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
        );
      createFeePaymentAdapterMock.mockReturnValue({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue({
          ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
          signerAddress: address("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        }),
        signAsFeePayer: vi.fn(),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const headers = {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "xfer-key-1",
      };
      const body = JSON.stringify({
        source: TEST_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "1",
      });

      const first = await app.request(
        "/v1/payments/transfers",
        { method: "POST", headers, body },
        env
      );
      const second = await app.request(
        "/v1/payments/transfers",
        { method: "POST", headers, body },
        env
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstJson = (await first.json()) as { data: { transfer: { id: string } } };
      const secondJson = (await second.json()) as { data: { transfer: { id: string } } };
      expect(secondJson.data.transfer.id).toBe(firstJson.data.transfer.id);
      expect(signAndSendMock).toHaveBeenCalledTimes(1);
    });

    it("replays a failed transfer on retry without submitting again", async () => {
      const signAndSendMock = vi.fn().mockRejectedValue(new Error("rpc down"));
      createFeePaymentAdapterMock.mockReturnValue({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue({
          ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
          signerAddress: address("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        }),
        signAsFeePayer: vi.fn(),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const headers = {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "failed-retry-key",
      };
      const body = JSON.stringify({
        source: TEST_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.001",
      });

      const first = await app.request(
        "/v1/payments/transfers",
        { method: "POST", headers, body },
        env
      );
      const second = await app.request(
        "/v1/payments/transfers",
        { method: "POST", headers, body },
        env
      );

      expect(first.status).toBeGreaterThanOrEqual(400);
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { data: { transfer: { status: string } } };
      expect(secondBody.data.transfer.status).toBe("failed");
      expect(signAndSendMock).toHaveBeenCalledTimes(1);
    });

    it("does not re-run policy enforcement on an idempotent replay", async () => {
      const signAndSendMock = vi
        .fn()
        .mockResolvedValue(
          "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy"
        );
      createFeePaymentAdapterMock.mockReturnValue({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue({
          ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
          signerAddress: address("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        }),
        signAsFeePayer: vi.fn(),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const headers = {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "xfer-policy-replay-key",
      };
      const body = JSON.stringify({
        source: TEST_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "1",
      });

      const countWalletOperations = async () => {
        const row = await getDb(env)
          .prepare("SELECT COUNT(*) AS count FROM wallet_operations WHERE organization_id = ?")
          .bind(TEST_ORG.id)
          .first<{ count: number }>();
        return Number(row?.count ?? 0);
      };

      const before = await countWalletOperations();

      const first = await app.request(
        "/v1/payments/transfers",
        { method: "POST", headers, body },
        env
      );
      expect(first.status).toBe(200);
      const afterFirst = await countWalletOperations();
      expect(afterFirst).toBe(before + 1);

      const second = await app.request(
        "/v1/payments/transfers",
        { method: "POST", headers, body },
        env
      );
      expect(second.status).toBe(200);
      const afterSecond = await countWalletOperations();

      const firstJson = (await first.json()) as { data: { transfer: { id: string } } };
      const secondJson = (await second.json()) as { data: { transfer: { id: string } } };
      expect(secondJson.data.transfer.id).toBe(firstJson.data.transfer.id);
      expect(afterSecond).toBe(afterFirst);
      expect(signAndSendMock).toHaveBeenCalledTimes(1);
    });

    it("rejects the same Idempotency-Key with a different body", async () => {
      const headers = {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "xfer-key-2",
      };

      const first = await app.request(
        "/v1/payments/transfers",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            source: TEST_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: "SOL",
            amount: "1",
          }),
        },
        env
      );
      expect(first.status).toBe(200);

      const conflict = await app.request(
        "/v1/payments/transfers",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            source: TEST_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: "SOL",
            amount: "2",
          }),
        },
        env
      );
      expect(conflict.status).toBe(409);
    });

    it("does not dedup when no Idempotency-Key is supplied", async () => {
      const signAndSendMock = vi
        .fn()
        .mockResolvedValueOnce(
          "3agLAsjf2Qba9W59cqxbXFoPRJFDFKB3efqYRhT6wLxaM4KwV31NVrLDjKAw22hR1GFcQc4mePSjZ6XZEHUAjN4c"
        )
        .mockResolvedValueOnce(
          "5Tzxe7r8pab72bTDx9pQHM9YEWXoQ2MchfbzdnJAj3vScaUmAAJgEE3Jx1b68u33cfWdJTKXgpUtHBZPYJxVQ1pV"
        );
      createFeePaymentAdapterMock.mockReturnValue({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue({
          ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
          signerAddress: address("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        }),
        signAsFeePayer: vi.fn(),
        signAndSend: signAndSendMock,
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const headers = {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "Content-Type": "application/json",
      };
      const body = JSON.stringify({
        source: TEST_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "1",
      });
      getRecentBlockhashMock
        .mockResolvedValueOnce({
          blockhash: "29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2" as Awaited<
            ReturnType<typeof solanaRpc.getRecentBlockhash>
          >["blockhash"],
          lastValidBlockHeight: 1000n,
        })
        .mockResolvedValueOnce({
          blockhash: "3JF3sEqM796hk5WFqA6EtmEwJQ9quALszsfJyvXNQKy3" as Awaited<
            ReturnType<typeof solanaRpc.getRecentBlockhash>
          >["blockhash"],
          lastValidBlockHeight: 1000n,
        });

      const a = await app.request("/v1/payments/transfers", { method: "POST", headers, body }, env);
      const b = await app.request("/v1/payments/transfers", { method: "POST", headers, body }, env);

      const aJson = (await a.json()) as { data: { transfer: { id: string } } };
      const bJson = (await b.json()) as { data: { transfer: { id: string } } };
      expect(bJson.data.transfer.id).not.toBe(aJson.data.transfer.id);
    });

    it("marks the transfer as failed when execution throws and returns 502", async () => {
      createFeePaymentAdapterMock.mockReturnValueOnce({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue({
          ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
          signerAddress: address("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        }),
        signAsFeePayer: vi.fn(),
        signAndSend: vi.fn().mockRejectedValue(new Error("RPC connection refused")),
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const res = await app.request(
        "/v1/payments/transfers",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            source: TEST_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: "SOL",
            amount: "1",
          }),
        },
        env
      );

      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("SOLANA_RPC_ERROR");

      const transfers = await getDb(env)
        .prepare("SELECT status, error FROM payment_transfers")
        .all<{
          status: string;
          error: string | null;
        }>();
      expect(transfers.results).toHaveLength(1);
      expect(transfers.results[0]?.status).toBe("failed");
      expect(transfers.results[0]?.error).toBeTruthy();
    });

    it("returns 400 ACCOUNT_FROZEN when the source SPL token account is frozen", async () => {
      mockRecurringActivationRpc();
      createFeePaymentAdapterMock.mockReturnValueOnce({
        providerId: "mock",
        getFeePayer: vi.fn().mockResolvedValue("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        getSponsorshipConfiguration: vi.fn().mockResolvedValue({
          ...TEST_SPONSORSHIP_PROVIDER_CONFIG,
          signerAddress: address("7iQJKBEwzBccKMvyZgnPmXfSPJB5XjN7hE2vgGYX5Kkv"),
        }),
        signAsFeePayer: vi.fn(),
        signAndSend: vi
          .fn()
          .mockRejectedValue(
            new Error(
              "Failed to sign and send transaction: RPC Error -32000: Invalid transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x11"
            )
          ),
      } as ReturnType<typeof feePaymentAdapters.createFeePaymentAdapter>);

      const res = await app.request(
        "/v1/payments/transfers",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            source: TEST_WALLET_ID,
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            token: DEVNET_USDC_MINT,
            amount: "1",
          }),
        },
        env
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("ACCOUNT_FROZEN");

      const transfers = await getDb(env)
        .prepare("SELECT status, error FROM payment_transfers")
        .all<{
          status: string;
          error: string | null;
        }>();
      expect(transfers.results).toHaveLength(1);
      expect(transfers.results[0]?.status).toBe("failed");
      expect(transfers.results[0]?.error).toBeTruthy();
    });
  });
});
