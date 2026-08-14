import type { PolicyDefaultAction, PolicyRule } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createPostgresPolicyRepository } from "@/db/repositories";
import app from "@/index";
import { createTenantScope } from "@/lib/tenant-scope";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  installPaymentsRouteTestHooks,
  seedCachedKey,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";

const APPROVER_USER_ID = "usr_signer_check_approver";
const APPROVER_SESSION_ID = "sess_signer_check_approver";

interface ApprovedOperationBody {
  data: {
    approvalRequest: {
      status: string;
      operation: {
        status: string;
        executionError: string | null;
      };
    };
  };
}

async function seedWalletControlProfile(params: {
  rules: PolicyRule[];
  defaultAction?: PolicyDefaultAction;
}): Promise<void> {
  const repo = createPostgresPolicyRepository(
    getDb(env),
    createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
  );
  const profile = await repo.createWalletControlProfile({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    custodyWalletId: TEST_CUSTODY_WALLET_ID,
    name: "Signer check controls",
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

async function seedApproverSession(): Promise<void> {
  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(APPROVER_USER_ID, "signer-check-approver@example.com"),
    getDb(env)
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES (?, ?, ?, 'admin', 'active')`
      )
      .bind("om_signer_check_approver", TEST_ORG.id, APPROVER_USER_ID),
    getDb(env)
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES (?, ?, ?, 'admin')`
      )
      .bind("pm_signer_check_approver", TEST_PROJECT.id, APPROVER_USER_ID),
    getDb(env)
      .prepare(
        `INSERT INTO sessions (id, user_id, organization_id, auth_method, expires_at)
         VALUES (?, ?, ?, 'session', ?)`
      )
      .bind(APPROVER_SESSION_ID, APPROVER_USER_ID, TEST_ORG.id, "2099-01-01T00:00:00.000Z"),
  ]);
}

/**
 * Mirror the dashboard signer-check flow's key lifecycle: the minted key is
 * revoked right after the request and its short expiry elapses before the
 * approval is reviewed.
 */
describe("Approved signer check replay memo", () => {
  installPaymentsRouteTestHooks();

  it("replays an approved signer check against the memo the approvers saw", async () => {
    await seedApproverSession();
    await seedWalletControlProfile({
      rules: [
        { id: "approve-signer-check", kind: "approval", operationTypes: ["custody_signer_check"] },
      ],
    });
    await seedCachedKey({
      signingWalletId: TEST_WALLET_ID,
      walletBindings: [{ walletId: TEST_WALLET_ID, permissions: ["wallets:write"] }],
    });
    await getDb(env)
      .prepare("UPDATE api_keys SET signing_wallet_id = ? WHERE id = ?")
      .bind(TEST_WALLET_ID, TEST_API_KEY.id)
      .run();

    const pendingResponse = await app.request(
      "/v1/wallets/signer-check",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({ walletId: TEST_WALLET_ID }),
      },
      env
    );
    expect(pendingResponse.status).toBe(202);
    const pendingBody = (await pendingResponse.json()) as {
      error: { details: { approvalRequestId: string } };
    };
    const { approvalRequestId } = pendingBody.error.details;
    expect(approvalRequestId).toMatch(/^appr_/);

    // Without memo reuse the replay mints a second memo and the stored
    // operation no longer matches the replayed action, so approval can never
    // execute.
    const approvedResponse = await app.request(
      `/v1/wallets/approval-requests/${approvalRequestId}/approve`,
      {
        method: "POST",
        headers: {
          Cookie: `sdp_session=${APPROVER_SESSION_ID}`,
          "x-project-id": TEST_PROJECT.id,
        },
      },
      env
    );
    expect(approvedResponse.status).toBe(200);
    const approvedBody = (await approvedResponse.json()) as ApprovedOperationBody;
    expect(approvedBody.data.approvalRequest).toMatchObject({
      status: "approved",
      operation: {
        status: "completed",
        executionError: null,
      },
    });
  });

  it("refuses a legacy caller-supplied memo on replay instead of publishing it", async () => {
    await seedApproverSession();
    await seedWalletControlProfile({
      rules: [
        { id: "approve-signer-check", kind: "approval", operationTypes: ["custody_signer_check"] },
      ],
    });
    await seedCachedKey({
      signingWalletId: TEST_WALLET_ID,
      walletBindings: [{ walletId: TEST_WALLET_ID, permissions: ["wallets:write"] }],
    });
    await getDb(env)
      .prepare("UPDATE api_keys SET signing_wallet_id = ? WHERE id = ?")
      .bind(TEST_WALLET_ID, TEST_API_KEY.id)
      .run();

    const pendingResponse = await app.request(
      "/v1/wallets/signer-check",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({ walletId: TEST_WALLET_ID }),
      },
      env
    );
    expect(pendingResponse.status).toBe(202);
    const pendingBody = (await pendingResponse.json()) as {
      error: { details: { approvalRequestId: string; walletOperationId: string } };
    };
    const { approvalRequestId, walletOperationId } = pendingBody.error.details;

    // An approval filed by the old handler, which took the memo from the body.
    await getDb(env)
      .prepare(
        `UPDATE wallet_operations
            SET raw_payload = jsonb_set(raw_payload::jsonb, '{memo}', '"attacker chosen text"')
          WHERE id = ?`
      )
      .bind(walletOperationId)
      .run();

    const approvedResponse = await app.request(
      `/v1/wallets/approval-requests/${approvalRequestId}/approve`,
      {
        method: "POST",
        headers: {
          Cookie: `sdp_session=${APPROVER_SESSION_ID}`,
          "x-project-id": TEST_PROJECT.id,
        },
      },
      env
    );
    expect(approvedResponse.status).toBe(200);
    const approvedBody = (await approvedResponse.json()) as ApprovedOperationBody;
    expect(approvedBody.data.approvalRequest.operation.status).not.toBe("completed");
    expect(approvedBody.data.approvalRequest.operation.executionError).toContain(
      "does not match replayed action"
    );
  });
});
