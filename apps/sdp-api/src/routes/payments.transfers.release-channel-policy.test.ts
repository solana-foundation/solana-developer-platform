import assert from "node:assert/strict";
import { type PolicyRule, type SdpReleaseChannel, SOL_MINT } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import { createPostgresPolicyRepository } from "@/db/repositories";
import app from "@/index";
import { createTenantScope } from "@/lib/tenant-scope";
import {
  walletApprovalRequestResponseSchema,
  walletApprovalRequestsResponseSchema,
} from "@/openapi/schemas/custody";
import { walletPolicyEvaluationDetailSchema } from "@/openapi/schemas/payments";
import { enforceWalletOperationPolicy } from "@/services/policy/enforcement.service";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { env } from "@/test/helpers/env";
import {
  installPaymentsRouteTestHooks,
  TEST_API_KEY,
  TEST_CUSTODY_WALLET_ID,
  TEST_ORG,
  TEST_PROJECT,
  TEST_USER,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import {
  listTransferRows,
  seedCustodyWalletFixture,
  seedWalletControlProfile,
} from "@/test/helpers/payments-transfers";

// Release channels that exclude Policies skip evaluation (ADR 0005); `experimental`
// runs it. Each case seeds a rule that would stop the transfer and checks the
// rule still applies on `experimental` and is skipped, and audited, on `stable`.

const responseSchema = <T extends z.ZodType>(data: T) => z.object({ data });
const evaluationsHttpResponseSchema = responseSchema(z.array(walletPolicyEvaluationDetailSchema));
const approvalListHttpResponseSchema = responseSchema(walletApprovalRequestsResponseSchema);
const approvalHttpResponseSchema = responseSchema(walletApprovalRequestResponseSchema);
const dryRunHttpResponseSchema = responseSchema(
  z.object({ decision: z.string(), reason: z.string(), criteria: z.array(z.unknown()) })
);
const approvalErrorSchema = z.object({
  error: z.object({ details: z.object({ approvalRequestId: z.string() }) }),
});

const TRANSFER = {
  sourceCustodyWalletId: TEST_CUSTODY_WALLET_ID,
  destination: TEST_SOLANA_ADDRESSES.wallet2,
  token: "SOL",
  amount: "0.1",
};

const API_KEY_HEADERS = { Authorization: `Bearer ${TEST_API_KEY.raw}` };

function onChannel(releaseChannel: SdpReleaseChannel) {
  return { ...env, SDP_RELEASE_CHANNEL: releaseChannel };
}

async function postTransferOn(
  releaseChannel: SdpReleaseChannel,
  headers: Record<string, string> = {},
  transfer: typeof TRANSFER = TRANSFER
): Promise<Response> {
  return app.request(
    "/v1/payments/transfers",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...API_KEY_HEADERS, ...headers },
      body: JSON.stringify(transfer),
    },
    onChannel(releaseChannel)
  );
}

/** The wallet's evaluation audit trail, read where the audit route is served. */
async function listWalletOperationStatuses(): Promise<string[]> {
  const result = await getDb(env)
    .prepare("SELECT status FROM wallet_operations WHERE organization_id = ? ORDER BY created_at")
    .bind(TEST_ORG.id)
    .all<{ status: string }>();
  return result.results.map((row) => row.status);
}

async function listEvaluations() {
  const response = await app.request(
    `/v1/payments/wallets/${TEST_WALLET_ID}/policies/evaluations`,
    { headers: API_KEY_HEADERS },
    onChannel("experimental")
  );
  expect(response.status).toBe(200);
  return evaluationsHttpResponseSchema.parse(await response.json()).data;
}

async function listApprovalRequests(releaseChannel: SdpReleaseChannel) {
  const response = await app.request(
    "/v1/wallets/approval-requests",
    { headers: API_KEY_HEADERS },
    onChannel(releaseChannel)
  );
  expect(response.status).toBe(200);
  return approvalListHttpResponseSchema.parse(await response.json()).data.approvalRequests;
}

async function seedApiKeySpendCap(): Promise<void> {
  const repo = createPostgresPolicyRepository(
    getDb(env),
    createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
  );
  const profile = await repo.createApiKeyControlProfile({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    apiKeyId: TEST_API_KEY.id,
    name: "Key spend cap",
  });
  assert(profile);
  const revision = await repo.createApiKeyControlProfileRevision({
    profileId: profile.id,
    rules: [
      {
        id: "key-daily-cap",
        kind: "velocity",
        scope: "api_key",
        window: "P1D",
        max: "0.05",
        assets: ["SOL", SOL_MINT],
      },
    ],
    defaultAction: "allow",
    createdBy: TEST_USER.id,
  });
  assert(revision);
  await repo.activateApiKeyControlProfileRevision({
    profileId: profile.id,
    revisionId: revision.id,
  });
}

const UNBOUND_CUSTODY_WALLET_ID = "cwlt_release_channel_unbound";
const UNBOUND_WALLET_ID = "wal_release_channel_unbound";

/**
 * Seed a second custody wallet the test key can otherwise reach, and bind the
 * key's policy to the first wallet only, so the binding is all that keeps the
 * key off the second wallet.
 */
async function seedPolicyBindingToFirstWallet(): Promise<void> {
  await seedCustodyWalletFixture({
    id: UNBOUND_CUSTODY_WALLET_ID,
    walletId: UNBOUND_WALLET_ID,
    publicKey: TEST_SOLANA_ADDRESSES.wallet3,
    label: "Unbound wallet",
  });
  const repo = createPostgresPolicyRepository(
    getDb(env),
    createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
  );
  const profile = await repo.createApiKeyControlProfile({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    apiKeyId: TEST_API_KEY.id,
    name: "Bound wallet controls",
  });
  assert(profile);
  const revision = await repo.createApiKeyControlProfileRevision({
    profileId: profile.id,
    rules: [],
    defaultAction: "allow",
    createdBy: TEST_USER.id,
  });
  assert(revision);
  await repo.activateApiKeyControlProfileRevision({
    profileId: profile.id,
    revisionId: revision.id,
  });
  const binding = await repo.upsertApiKeyWalletPolicyBinding({
    apiKeyId: TEST_API_KEY.id,
    bindingScope: "selected",
    walletId: TEST_WALLET_ID,
    custodyWalletId: TEST_CUSTODY_WALLET_ID,
    apiKeyControlProfileId: profile.id,
  });
  assert(binding);
}

const BINDING_REFUSAL = "API key policy binding is not configured for the requested wallet";
const bindingErrorSchema = z.object({ error: z.object({ message: z.string() }) });

async function seedApprover(): Promise<Record<string, string>> {
  const approverUserId = "usr_release_channel_approver";
  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(approverUserId, "release-channel-approver@example.com"),
    getDb(env)
      .prepare(`INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES (?, ?, ?, 'admin', 'active')`)
      .bind("om_release_channel_approver", TEST_ORG.id, approverUserId),
    getDb(env)
      .prepare(`INSERT INTO project_members (id, project_id, user_id, role)
         VALUES (?, ?, ?, 'admin')`)
      .bind("pm_release_channel_approver", TEST_PROJECT.id, approverUserId),
  ]);
  return {
    Authorization: `Bearer ${await signSeededClerkMember(env, getDb(env), approverUserId, TEST_ORG.id)}`,
    "x-project-id": TEST_PROJECT.id,
  };
}

const DENY_PAYMENTS: PolicyRule = {
  id: "block-payments",
  kind: "operation_family",
  families: ["payment"],
  action: "deny",
};

const APPROVE_PAYMENTS: PolicyRule = {
  id: "approve-payment-execution",
  kind: "approval",
  operationTypes: ["payment_transfer_execute"],
};

describe("Payments routes — transfer policy by release channel", () => {
  installPaymentsRouteTestHooks();

  it("stable: a deny rule does not apply and the skip is audited", async () => {
    await seedWalletControlProfile({ rules: [DENY_PAYMENTS] });

    const response = await postTransferOn("stable");

    expect(response.status).toBe(200);
    expect(await listTransferRows()).toHaveLength(1);
    const [evaluation] = await listEvaluations();
    expect(evaluation).toMatchObject({
      decision: "allow",
      reasonCode: "policies_module_excluded",
      matchedRules: [],
      requiresApproval: false,
      approvalRequestId: null,
      policyRevisions: { wallet: { evaluatedRevisionId: null } },
      walletOperation: { operationType: "payment_transfer_execute", status: "evaluated" },
      evaluationContext: {
        operation: { apiKeyId: TEST_API_KEY.id },
        walletPolicy: { profileId: null, revisionId: null, decision: "allow" },
        apiKeyPolicy: { profileId: null, revisionId: null, decision: "allow" },
      },
    });
  });

  it("experimental: the same deny rule still refuses the transfer", async () => {
    await seedWalletControlProfile({ rules: [DENY_PAYMENTS] });

    const response = await postTransferOn("experimental");

    expect(response.status).toBe(403);
    expect(await listTransferRows()).toHaveLength(0);
    const [evaluation] = await listEvaluations();
    expect(evaluation).toMatchObject({ decision: "deny", reasonCode: "wallet_policy_match" });
  });

  it("stable: a dry-run answers allow without reading any rule", async () => {
    await seedWalletControlProfile({ rules: [DENY_PAYMENTS] });

    const stable = await postTransferOn("stable", { "Dry-Run": "true" });
    const experimental = await postTransferOn("experimental", { "Dry-Run": "true" });

    expect(stable.status).toBe(200);
    expect(dryRunHttpResponseSchema.parse(await stable.json()).data).toMatchObject({
      decision: "allow",
      criteria: [],
    });
    expect(dryRunHttpResponseSchema.parse(await experimental.json()).data.decision).toBe("deny");
  });

  it("stable: an approval rule creates no approval request", async () => {
    await seedWalletControlProfile({ rules: [APPROVE_PAYMENTS] });

    const stable = await postTransferOn("stable");
    expect(stable.status).toBe(200);
    expect(await listApprovalRequests("stable")).toEqual([]);

    const experimental = await postTransferOn("experimental");
    expect(experimental.status).toBe(202);
    expect(await listApprovalRequests("experimental")).toHaveLength(1);
  });

  it("stable: an exhausted API key spend cap does not apply", async () => {
    await seedApiKeySpendCap();

    const experimental = await postTransferOn("experimental");
    expect(experimental.status).toBe(403);

    const stable = await postTransferOn("stable");
    expect(stable.status).toBe(200);
    expect(await listTransferRows()).toHaveLength(1);
    const [latest] = await listEvaluations();
    expect(latest).toMatchObject({
      decision: "allow",
      reasonCode: "policies_module_excluded",
      policyRevisions: { apiKey: { evaluatedRevisionId: null } },
    });
  });

  it("stable: approval requests opened earlier can still be rejected and approved", async () => {
    await seedWalletControlProfile({ rules: [APPROVE_PAYMENTS] });
    const approverHeaders = await seedApprover();
    const opened: string[] = [];
    for (const idempotencyKey of ["release-channel-reject", "release-channel-approve"]) {
      const held = await postTransferOn("experimental", { "Idempotency-Key": idempotencyKey });
      expect(held.status).toBe(202);
      opened.push(approvalErrorSchema.parse(await held.json()).error.details.approvalRequestId);
    }
    const [rejectId, approveId] = opened;
    assert(rejectId !== undefined && approveId !== undefined);

    const decide = (approvalRequestId: string, decision: "reject" | "approve") =>
      app.request(
        `/v1/wallets/approval-requests/${approvalRequestId}/${decision}`,
        { method: "POST", headers: approverHeaders },
        onChannel("stable")
      );

    const rejected = await decide(rejectId, "reject");
    expect(rejected.status).toBe(200);
    expect(
      approvalHttpResponseSchema.parse(await rejected.json()).data.approvalRequest
    ).toMatchObject({ status: "rejected", operation: { status: "canceled" } });

    const approved = await decide(approveId, "approve");
    expect(approved.status).toBe(200);
    expect(
      approvalHttpResponseSchema.parse(await approved.json()).data.approvalRequest
    ).toMatchObject({
      status: "approved",
      operation: { status: "completed", executionError: null },
    });
    const transfers = await listTransferRows();
    expect(transfers).toHaveLength(1);
    expect(transfers[0]?.status).toBe("confirmed");
    // The approval authorizes the replay: it resumes the held operation rather
    // than recording a fresh, unevaluated one.
    const evaluations = await listEvaluations();
    expect(evaluations.map((evaluation) => evaluation.approvalRequestId).sort()).toEqual(
      [...opened].sort()
    );
  });

  describe("an API key policy binding still restricts wallets", () => {
    const FROM_UNBOUND = { ...TRANSFER, sourceCustodyWalletId: UNBOUND_CUSTODY_WALLET_ID };

    for (const releaseChannel of ["experimental", "stable"] as const) {
      it(`${releaseChannel}: a transfer from a wallet outside the key's bindings is refused`, async () => {
        await seedPolicyBindingToFirstWallet();

        const response = await postTransferOn(releaseChannel, {}, FROM_UNBOUND);

        expect(response.status).toBe(403);
        expect(bindingErrorSchema.parse(await response.json()).error.message).toBe(BINDING_REFUSAL);
        expect(await listTransferRows()).toHaveLength(0);
        // The refused attempt stays in the operation ledger, the same on every channel.
        expect(await listWalletOperationStatuses()).toEqual(["failed"]);
      });

      it(`${releaseChannel}: a dry run predicts the same binding refusal`, async () => {
        await seedPolicyBindingToFirstWallet();

        const response = await postTransferOn(releaseChannel, { "Dry-Run": "true" }, FROM_UNBOUND);

        expect(response.status).toBe(403);
        expect(bindingErrorSchema.parse(await response.json()).error.message).toBe(BINDING_REFUSAL);
        expect(await listWalletOperationStatuses()).toEqual([]);
      });
    }

    it("stable: a transfer from the bound wallet is allowed and the skip is audited", async () => {
      await seedPolicyBindingToFirstWallet();

      const response = await postTransferOn("stable");

      expect(response.status).toBe(200);
      expect(await listTransferRows()).toHaveLength(1);
      const [evaluation] = await listEvaluations();
      expect(evaluation).toMatchObject({
        decision: "allow",
        reasonCode: "policies_module_excluded",
        walletOperation: { operationType: "payment_transfer_execute", status: "evaluated" },
      });
    });

    // No stable route records an operation without a custody wallet (the
    // modules that do, such as earn and issuance, are excluded there), so this
    // drives the choke point directly against the same database.
    it("stable: an operation with no custody wallet is refused once the key has bindings", async () => {
      await seedPolicyBindingToFirstWallet();

      await expect(
        enforceWalletOperationPolicy(
          onChannel("stable"),
          createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id }),
          {
            organizationId: TEST_ORG.id,
            projectId: TEST_PROJECT.id,
            custodyWalletId: null,
            walletId: TEST_WALLET_ID,
            apiKeyId: TEST_API_KEY.id,
            operationFamily: "payment",
            operationType: "payment_transfer_execute",
            asset: "SOL",
            amount: "0.1",
            destination: TEST_SOLANA_ADDRESSES.wallet2,
            legs: [],
          }
        )
      ).rejects.toMatchObject({ code: "FORBIDDEN", message: BINDING_REFUSAL });
    });
  });
});
