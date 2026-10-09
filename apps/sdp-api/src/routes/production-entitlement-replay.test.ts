import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import { createPostgresPolicyRepository } from "@/db/repositories";
import { createPostgresPaymentsRepository } from "@/db/repositories/payments.repository.postgres";
import app from "@/index";
import { createTenantScope } from "@/lib/tenant-scope";
import { recoverApprovedWalletOperations } from "@/services/policy/approved-operation-replay";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { insertTestCustodyConfigRow, insertTestCustodyWalletRow } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import {
  createOrgSignerForCustodyWalletMock,
  installPaymentsRouteTestHooks,
  seedCachedKey,
  TEST_API_KEY,
  TEST_ORG,
  TEST_PROJECT,
  TEST_USER,
} from "@/test/helpers/payments-routes";
import { readErrorResponse } from "@/test/helpers/payments-transfers";

/**
 * APE-351: an approval replay re-enters the API as the original actor, so it
 * must meet the same production entitlement as a live request. A production
 * API key's operation (`wallet_operations.api_key_id` set) used to replay
 * straight past it.
 */

const PRODUCTION_PROJECT_ID = `${TEST_PROJECT.id}_production`;
const PRODUCTION_CUSTODY_CONFIG_ID = "cust_cfg_payments_test_production";
const PRODUCTION_CUSTODY_WALLET_ID = "cwlt_payments_test_production";
const PRODUCTION_NOT_ENABLED = "Production is not enabled for this organization";

const approvalDetailsSchema = z.object({
  approvalRequestId: z.string(),
  walletOperationId: z.string(),
});

const productionScope = createTenantScope({
  organizationId: TEST_ORG.id,
  projectId: PRODUCTION_PROJECT_ID,
});

function policyRepository() {
  return createPostgresPolicyRepository(getDb(env), productionScope);
}

async function listProductionTransfers() {
  const result = await createPostgresPaymentsRepository(getDb(env), productionScope).listTransfers({
    organizationId: TEST_ORG.id,
    projectId: PRODUCTION_PROJECT_ID,
    sortBy: "createdAt",
    sortDirection: "desc",
    limit: 100,
    offset: 0,
  });
  return result.rows;
}

async function setProductionEntitled(entitled: boolean): Promise<void> {
  await getDb(env)
    .prepare(
      `UPDATE organizations
       SET settings = (COALESCE(NULLIF(settings, ''), '{}')::jsonb
                       || jsonb_build_object('enableProductionProject', ?::boolean))::text
       WHERE id = ?`
    )
    .bind(entitled, TEST_ORG.id)
    .run();
}

/**
 * The production project's own custody wallet: custody is project-only, so the
 * sandbox wallet cannot pay out of the production project. It carries the
 * address the payments signer mock signs as.
 */
async function seedProductionCustodyWallet(): Promise<void> {
  await getDb(env).transaction(async (tx) => {
    await insertTestCustodyConfigRow(tx, {
      id: PRODUCTION_CUSTODY_CONFIG_ID,
      organizationId: TEST_ORG.id,
      projectId: PRODUCTION_PROJECT_ID,
      provider: "local",
      configEncrypted: "test-config",
      status: "active",
    });
    await insertTestCustodyWalletRow(tx, {
      id: PRODUCTION_CUSTODY_WALLET_ID,
      owner: { kind: "config", custodyConfigId: PRODUCTION_CUSTODY_CONFIG_ID },
      walletId: "wal_payments_test_production",
      publicKey: TEST_SOLANA_ADDRESSES.wallet1,
      label: "Production Payments Wallet",
      purpose: "transfer",
      status: "active",
    });
  });
}

/** Every payment out of the seeded wallet in the production project needs approval. */
async function seedProductionApprovalPolicy(): Promise<void> {
  const repo = policyRepository();
  const profile = await repo.createWalletControlProfile({
    organizationId: TEST_ORG.id,
    projectId: PRODUCTION_PROJECT_ID,
    custodyWalletId: PRODUCTION_CUSTODY_WALLET_ID,
    name: "Production payment controls",
    createdBy: TEST_USER.id,
  });
  assert(profile);
  const revision = await repo.createWalletControlProfileRevision({
    profileId: profile.id,
    rules: [
      {
        id: "approve-payment-execution",
        kind: "approval",
        operationTypes: ["payment_transfer_execute"],
      },
    ],
    createdBy: TEST_USER.id,
  });
  assert(revision);
  await repo.activateWalletControlProfileRevision({
    profileId: profile.id,
    revisionId: revision.id,
  });
}

/** Re-home the seeded API key onto the production project. */
async function rehomeApiKeyToProduction(): Promise<void> {
  await getDb(env)
    .prepare("UPDATE api_keys SET project_id = ? WHERE id = ?")
    .bind(PRODUCTION_PROJECT_ID, TEST_API_KEY.id)
    .run();
  await seedCachedKey({ projectId: PRODUCTION_PROJECT_ID, environment: "production" });
}

async function clerkHeaders(): Promise<Record<string, string>> {
  await getDb(env)
    .prepare(
      `INSERT INTO organization_members (id, organization_id, user_id, role, status)
       VALUES (?, ?, ?, 'admin', 'active')
       ON CONFLICT DO NOTHING`
    )
    .bind("om_production_replay_user", TEST_ORG.id, TEST_USER.id)
    .run();
  return {
    Authorization: `Bearer ${await signSeededClerkMember(env, getDb(env), TEST_USER.id, TEST_ORG.id)}`,
    "x-project-id": PRODUCTION_PROJECT_ID,
  };
}

type Actor = "api_key" | "clerk";

/** Opens a policy-held production transfer as `actor` while the org is entitled. */
async function openHeldProductionTransfer(actor: Actor) {
  const headers: Record<string, string> =
    actor === "api_key" ? { Authorization: `Bearer ${TEST_API_KEY.raw}` } : await clerkHeaders();
  const response = await app.request(
    "/v1/payments/transfers",
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceCustodyWalletId: PRODUCTION_CUSTODY_WALLET_ID,
        destination: TEST_SOLANA_ADDRESSES.wallet2,
        token: "SOL",
        amount: "0.1",
      }),
    },
    env
  );
  expect(response.status).toBe(202);
  const { approvalRequestId, walletOperationId } = approvalDetailsSchema.parse(
    (await readErrorResponse(response)).error.details
  );

  const operation = await getDb(env)
    .prepare("SELECT project_id, api_key_id, status FROM wallet_operations WHERE id = ?")
    .bind(walletOperationId)
    .first<{ project_id: string | null; api_key_id: string | null; status: string }>();
  expect(operation).toMatchObject({
    project_id: PRODUCTION_PROJECT_ID,
    api_key_id: actor === "api_key" ? TEST_API_KEY.id : null,
  });
  expect(await listProductionTransfers()).toHaveLength(0);
  return { approvalRequestId, walletOperationId, headers };
}

/** Approve out of band and let the recovery sweep execute the replay. */
async function approveAndReplay(approvalRequestId: string): Promise<void> {
  await policyRepository().updateApprovalRequestStatus({
    organizationId: TEST_ORG.id,
    projectId: PRODUCTION_PROJECT_ID,
    approvalRequestId,
    status: "approved",
    operationStatus: "executing",
    resolvedBy: TEST_USER.id,
  });
  expect(await recoverApprovedWalletOperations(env)).toBe(1);
}

describe("approved-operation replay into production (APE-351)", () => {
  installPaymentsRouteTestHooks();

  async function setUp(actor: Actor) {
    await seedProductionCustodyWallet();
    await seedProductionApprovalPolicy();
    if (actor === "api_key") {
      await rehomeApiKeyToProduction();
    }
    return openHeldProductionTransfer(actor);
  }

  describe.each([
    ["a production API key", "api_key"],
    ["a Clerk dashboard user", "clerk"],
  ] as const)("an operation opened by %s", (_label, actor) => {
    it("is refused on replay once the organization loses the entitlement", async () => {
      const { approvalRequestId, walletOperationId } = await setUp(actor);

      await setProductionEntitled(false);
      createOrgSignerForCustodyWalletMock.mockClear();
      await approveAndReplay(approvalRequestId);

      const operation = await policyRepository().getWalletOperationById(walletOperationId);
      expect(operation).toMatchObject({
        status: "failed",
        execution_error: PRODUCTION_NOT_ENABLED,
        execution_result: {
          error: { code: "FORBIDDEN", message: PRODUCTION_NOT_ENABLED },
        },
      });
      expect(operation?.execution_completed_at).toBeTruthy();
      expect(operation?.execution_effect_started_at ?? null).toBeNull();
      expect(createOrgSignerForCustodyWalletMock).not.toHaveBeenCalled();
      expect(await listProductionTransfers()).toHaveLength(0);

      // Nothing is left for a later sweep to pick up and retry.
      expect(await recoverApprovedWalletOperations(env)).toBe(0);
      expect(await listProductionTransfers()).toHaveLength(0);
    });

    it("executes on replay while the organization is still entitled", async () => {
      const { approvalRequestId, walletOperationId } = await setUp(actor);

      await approveAndReplay(approvalRequestId);

      const operation = await policyRepository().getWalletOperationById(walletOperationId);
      expect(operation).toMatchObject({ status: "completed", execution_error: null });
      const transfers = await listProductionTransfers();
      expect(transfers).toHaveLength(1);
      expect(transfers[0]?.status).toBe("confirmed");
    });
  });

  it("refuses a dashboard approval of a production operation after revocation", async () => {
    const { approvalRequestId, walletOperationId, headers } = await setUp("clerk");

    await setProductionEntitled(false);
    const response = await app.request(
      `/v1/wallets/approval-requests/${approvalRequestId}/approve`,
      { method: "POST", headers },
      env
    );
    expect(response.status).toBe(403);
    expect((await readErrorResponse(response)).error).toMatchObject({
      code: "FORBIDDEN",
      message: PRODUCTION_NOT_ENABLED,
    });

    const operation = await policyRepository().getWalletOperationById(walletOperationId);
    expect(operation?.status).not.toBe("executing");
    expect(operation?.status).not.toBe("completed");
    expect(await listProductionTransfers()).toHaveLength(0);
  });
});
