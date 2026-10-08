import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import { createPostgresPolicyRepository } from "@/db/repositories";
import {
  type EarnMovementRow,
  generateEarnPositionId,
} from "@/db/repositories/earn-movements.repository";
import app from "@/index";
import { createTenantScope } from "@/lib/tenant-scope";
import { recoverApprovedWalletOperations } from "@/services/policy/approved-operation-replay";
import { authenticateTestClerkUser } from "@/test/helpers/clerk";
import { type EarnAuthzTenant, seedEarnApiKey, seedEarnAuthzTenant } from "@/test/helpers/earn";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const withdrawFromVault = vi.hoisted(() => vi.fn());

vi.mock("@/services/earn/vault-withdraw.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/earn/vault-withdraw.service")>()),
  withdrawFromVault,
}));
vi.mock("@sdp/types/provider-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdp/types/provider-access")>()),
  isEarnProviderSurfaced: () => true,
}));

/**
 * APE-351 x ADR 0002: a production organization that loses
 * `enableProductionProject` keeps every Earn read and every way out of a
 * position, and is refused anything that opens new exposure.
 */

const PRODUCTION_NOT_ENABLED = "Production is not enabled for this organization";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const VAULT = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
const WALLET_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const CUSTODY_WALLET_ID = "cwlt_earn_prod_entitlement";

let tenant: EarnAuthzTenant;
let apiKeyRaw: string;
let originalMarketsEnabled: string | undefined;
let originalEarnEnabled: string | undefined;

type Actor = "api_key" | "clerk";

function authHeaders(actor: Actor): Record<string, string> {
  return actor === "api_key"
    ? { Authorization: `Bearer ${apiKeyRaw}` }
    : { Authorization: `Bearer ${tenant.token}`, "x-project-id": tenant.project.id };
}

function request(
  actor: Actor,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>
): Response | Promise<Response> {
  return app.request(
    path,
    {
      method,
      headers: {
        ...authHeaders(actor),
        ...(method === "POST"
          ? { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env
  );
}

async function setProductionEntitled(entitled: boolean): Promise<void> {
  await getDb(env)
    .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
    .bind(JSON.stringify({ enableProductionProject: entitled }), tenant.org.id)
    .run();
}

async function errorMessage(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message;
}

async function expectNotEntitlementRefusal(res: Response): Promise<void> {
  const message = await errorMessage(res);
  expect(message, `HTTP ${res.status}`).not.toBe(PRODUCTION_NOT_ENABLED);
}

async function seedProductionPosition(): Promise<string> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES ('cfg_earn_prod_entitlement', ?, ?, 'privy', 'encrypted', 'active')`
      )
      .bind(tenant.org.id, tenant.project.id),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, 'cfg_earn_prod_entitlement', 'privy_earn_prod_entitlement', ?, 'active')`
      )
      .bind(CUSTODY_WALLET_ID, WALLET_ADDRESS),
  ]);
  const id = generateEarnPositionId();
  await db
    .prepare(
      `INSERT INTO earn_positions (
         id, organization_id, project_id, environment, provider, kind,
         custody_wallet_id, vault_address, share_mint, token_mint,
         provider_wallet_id, label, activated_at
       ) VALUES (?, ?, ?, 'production', 'kamino', 'vault_direct', ?, ?, ?, ?, NULL,
                 'Exit Vault', sdp_iso_now())`
    )
    .bind(id, tenant.org.id, tenant.project.id, CUSTODY_WALLET_ID, VAULT, SHARE_MINT, USDC_MINT)
    .run();
  return id;
}

function movementRow(positionId: string, requestId: string): EarnMovementRow {
  const now = new Date().toISOString();
  return {
    id: `earn_movement_${crypto.randomUUID()}`,
    organization_id: tenant.org.id,
    project_id: tenant.project.id,
    environment: "production",
    provider: "kamino",
    execution_model: "vault_direct",
    direction: "withdrawal",
    position_id: positionId,
    status: "submitted",
    failure_reason: null,
    confirmed_at: null,
    chain_finalized_at: null,
    settled_at: null,
    denomination: SHARE_MINT,
    amount_requested: "10",
    amount_settled: null,
    fee_amount: null,
    token_amount_settled: null,
    min_shares_out: null,
    shares_out: null,
    payout_token: null,
    custody_wallet_id: CUSTODY_WALLET_ID,
    owner_address: null,
    vault_address: VAULT,
    source_address: VAULT,
    destination_address: WALLET_ADDRESS,
    provider_reference: null,
    signature: `sig_${crypto.randomUUID()}`,
    signed_transaction: "AQ==",
    last_valid_block_height: "12345",
    request_id: requestId,
    idempotency_fingerprint: "{}",
    provider_data: {},
    created_by: null,
    initiated_by_key_id: null,
    created_at: now,
    updated_at: now,
    creates_share_account: false,
    share_ata_rent_funder: null,
    unknown_signature_observed_at: null,
  };
}

beforeEach(async () => {
  originalMarketsEnabled = env.MARKETS_ENABLED;
  originalEarnEnabled = env.EARN_ENABLED;
  env.MARKETS_ENABLED = "true";
  env.EARN_ENABLED = "true";
  await seedTestDatabase(env);
  await clearKVStores(env);
  vi.clearAllMocks();
  withdrawFromVault.mockImplementation(async (_env, input) => ({
    position: { id: input.positionId },
    movement: movementRow(input.positionId, input.requestId),
    replayed: false,
  }));

  tenant = await seedEarnAuthzTenant(env, "earn_prod_entitlement", {
    environment: "production",
  });
  apiKeyRaw = (
    await seedEarnApiKey(env, tenant, {
      id: "key_earn_prod_entitlement",
      permissions: ["*"],
      environment: "production",
    })
  ).raw;
  await setProductionEntitled(false);
});

afterEach(() => {
  env.MARKETS_ENABLED = originalMarketsEnabled;
  env.EARN_ENABLED = originalEarnEnabled;
  vi.restoreAllMocks();
});

describe.each([
  ["a production API key", "api_key"],
  ["a Clerk member on the production project", "clerk"],
] as const)("Earn without the production entitlement, as %s (APE-351)", (_label, actor) => {
  it("still answers GET /v1/earn/vault-positions", async () => {
    const res = await request(actor, "GET", "/v1/earn/vault-positions");
    expect(res.status).toBe(200);
  });

  it("withdraws an existing production position", async () => {
    const positionId = await seedProductionPosition();

    const res = await request(actor, "POST", "/v1/earn/vault-withdrawals", {
      positionId,
      shares: "10",
    });

    expect(res.status).toBe(200);
    expect(withdrawFromVault).toHaveBeenCalledTimes(1);
    expect(withdrawFromVault.mock.calls[0]?.[1]).toMatchObject({
      positionId,
      environment: "production",
    });
  });
});

function policyRepository() {
  return createPostgresPolicyRepository(
    getDb(env),
    createTenantScope({ organizationId: tenant.org.id, projectId: tenant.project.id })
  );
}

/** Every Earn vault withdrawal out of the seeded production wallet needs approval. */
async function seedWithdrawalApprovalPolicy(): Promise<void> {
  const repo = policyRepository();
  const profile = await repo.createWalletControlProfile({
    organizationId: tenant.org.id,
    projectId: tenant.project.id,
    custodyWalletId: CUSTODY_WALLET_ID,
    name: "Approve production vault withdrawals",
    createdBy: tenant.user.id,
  });
  if (!profile) throw new Error("Failed to create approval profile");
  const revision = await repo.createWalletControlProfileRevision({
    profileId: profile.id,
    rules: [
      { id: "approve-withdrawal", kind: "approval", operationTypes: ["earn_vault_withdrawal"] },
    ],
    createdBy: tenant.user.id,
  });
  if (!revision) throw new Error("Failed to create approval revision");
  await repo.activateWalletControlProfileRevision({
    profileId: profile.id,
    revisionId: revision.id,
  });
}

/**
 * A second org admin on the production project. The API key that opened the
 * operation was created by `tenant.user`, who therefore cannot decide it.
 */
async function seedApprover(): Promise<Record<string, string>> {
  const db = getDb(env);
  const userId = "usr_test_earn_prod_approver";
  const email = "approver@earn-authz.example.com";
  await db
    .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
    .bind(userId, email)
    .run();
  await db
    .prepare(
      "INSERT INTO project_members (id, project_id, user_id, role) VALUES (?, ?, ?, 'admin')"
    )
    .bind(`pm_${tenant.project.id}_${userId}`, tenant.project.id, userId)
    .run();
  const { headers } = await authenticateTestClerkUser(env, db, {
    userId,
    email,
    clerkUserId: "clerk_user_earn_prod_approver",
    organizationId: tenant.org.id,
    clerkOrgId: "clerk_org_earn_prod_entitlement",
    orgSlug: tenant.org.slug,
    role: "admin",
  });
  return headers(tenant.project.id);
}

function decide(
  headers: Record<string, string>,
  approvalRequestId: string,
  action: "approve" | "reject"
): Response | Promise<Response> {
  return app.request(
    `/v1/wallets/approval-requests/${approvalRequestId}/${action}`,
    { method: "POST", headers: { ...headers, "Idempotency-Key": crypto.randomUUID() } },
    env
  );
}

const heldSchema = z.object({
  error: z.object({
    details: z.object({ approvalRequestId: z.string(), walletOperationId: z.string() }),
  }),
});

/**
 * While entitled, the production API key opens a withdrawal that the policy
 * holds for approval; then the entitlement is revoked. The Clerk admin is a
 * different principal, so it may decide the request.
 */
async function holdWithdrawalThenRevoke() {
  const positionId = await seedProductionPosition();
  await seedWithdrawalApprovalPolicy();
  await setProductionEntitled(true);
  const held = await request("api_key", "POST", "/v1/earn/vault-withdrawals", {
    positionId,
    shares: "10",
  });
  expect(held.status).toBe(202);
  const { details } = heldSchema.parse(await held.json()).error;
  expect(withdrawFromVault).not.toHaveBeenCalled();
  await setProductionEntitled(false);
  return { positionId, ...details };
}

describe("Earn withdrawal approvals without the production entitlement (APE-351)", () => {
  it("lets a Clerk admin approve a held production vault withdrawal after revocation", async () => {
    const { positionId, approvalRequestId, walletOperationId } = await holdWithdrawalThenRevoke();

    const res = await decide(await seedApprover(), approvalRequestId, "approve");
    await expectNotEntitlementRefusal(res.clone());
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);

    // Execution runs inline on approve; the sweep picks up anything left over.
    let operation = await policyRepository().getWalletOperationById(walletOperationId);
    if (operation?.status !== "completed") {
      await recoverApprovedWalletOperations(env);
      operation = await policyRepository().getWalletOperationById(walletOperationId);
    }
    expect(operation).toMatchObject({ status: "completed", execution_error: null });
    expect(withdrawFromVault).toHaveBeenCalledTimes(1);
    expect(withdrawFromVault.mock.calls[0]?.[1]).toMatchObject({
      positionId,
      environment: "production",
    });
  });

  it("lets a Clerk admin reject a held production vault withdrawal after revocation", async () => {
    const { approvalRequestId, walletOperationId } = await holdWithdrawalThenRevoke();

    const res = await decide(await seedApprover(), approvalRequestId, "reject");
    await expectNotEntitlementRefusal(res.clone());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: { approvalRequest: { id: approvalRequestId, status: "rejected" } },
    });
    const operation = await policyRepository().getWalletOperationById(walletOperationId);
    expect(operation?.status).not.toBe("completed");
    expect(withdrawFromVault).not.toHaveBeenCalled();
  });

  it.each(["api_key", "clerk"] as const)(
    "lists approval requests for an unentitled production org (%s)",
    async (actor) => {
      const { approvalRequestId } = await holdWithdrawalThenRevoke();

      const res = await request(actor, "GET", "/v1/wallets/approval-requests");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { approvalRequests: Array<{ id: string }> } };
      expect(body.data.approvalRequests.map((row) => row.id)).toContain(approvalRequestId);
    }
  );
});
