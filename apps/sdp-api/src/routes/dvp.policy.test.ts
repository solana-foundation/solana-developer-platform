import assert from "node:assert/strict";
import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey, PolicyRule } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createPolicyRepository } from "@/db/repositories";
import app from "@/index";
import { createTenantScope } from "@/lib/tenant-scope";
import { recoverApprovedWalletOperations } from "@/services/policy/approved-operation-replay";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { required } from "@/test/helpers/required";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const fundDvpTradeLeg = vi.hoisted(() => vi.fn());
const reclaimDvpTradeLeg = vi.hoisted(() => vi.fn());
const closeDvpTrade = vi.hoisted(() => vi.fn());
const observeDvpTradeNow = vi.hoisted(() => vi.fn());

vi.mock("@/services/dvp/fund", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/dvp/fund")>()),
  fundDvpTradeLeg,
}));
vi.mock("@/services/dvp/reclaim", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/dvp/reclaim")>()),
  reclaimDvpTradeLeg,
}));
vi.mock("@/services/dvp/settle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/dvp/settle")>()),
  closeDvpTrade,
}));
vi.mock("@/services/dvp/observe-now", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/dvp/observe-now")>()),
  observeDvpTradeNow,
}));

const TEST_ORG = { id: "org_test_dvp_policy", name: "DvP Policy Org", slug: "dvp-policy-org" };
const TEST_PROJECT = { id: "prj_dvp_policy", slug: "dvp-policy-project" };
const TEST_USER = { id: "usr_test_dvp_policy", email: "dvp-policy@example.com" };

const APPROVER = { id: "usr_test_dvp_approver", email: "dvp-approver@example.com" };
const TEST_API_KEY = { id: "key_dvp_policy", raw: "sk_test_dvp_policy", prefix: "sk_test_dvp_pol" };

const TEST_CACHED_API_KEY: CachedApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

const CUSTODY_CONFIG_ID = "cust_dvp_policy";
const PARTY_A_WALLET = { id: "cwlt_dvp_policy_a", walletId: "dvp_policy_wallet_a" };
const SETTLEMENT_WALLET = { id: "cwlt_dvp_policy_auth", walletId: "dvp_policy_wallet_auth" };
const PARTY_A_ADDRESS = "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn";
const PARTY_B_EXTERNAL = "C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk";
const SETTLEMENT_AUTHORITY = "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY";
const SWAP_DVP = "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po";
const ESCROW_A = "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU";
const MINT_A = "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1";
const FUND_SIGNATURE =
  "4NC4dm4WmFqLCQLAvrfxQRoUwBJn7M6vXFRT2mHqMqfkNLeCHGscpVKb1pPcaLxDyPPwzm3CqPRMR4MAQVnpcgVj";
const CLOSE_SIGNATURE =
  "5dRjDnZKcJfMe9vGkJCFbvuLPU4cJfKSMswkaTTd4oQGgtNDdk3vhkfaeKBCWa4sJGnNFdGCVAaKyYdPqvXNwYNG";

const LEG_A_TARGET = "1000";

let originalMarkets: string | undefined;

function authHeaders(extra: Record<string, string>) {
  return {
    Authorization: `Bearer ${TEST_API_KEY.raw}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function seedAuth(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);
  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "enterprise", "active"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(TEST_USER.id, TEST_USER.email, 1, "active"),
  ]);
  await seedDefaultProjects(db, {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [],
    ids: { sandbox: TEST_PROJECT.id, production: `${TEST_PROJECT.id}_production` },
  });
  await db
    .prepare(
      `INSERT INTO api_keys
        (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'api_admin', ?, 'active')`
    )
    .bind(
      TEST_API_KEY.id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_USER.id,
      "DvP Policy Key",
      TEST_API_KEY.prefix,
      keyHash,
      JSON.stringify(["*"])
    )
    .run();

  await db
    .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
    .bind(APPROVER.id, APPROVER.email)
    .run();
  await db.batch([
    db
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES ('om_dvp_policy', ?, ?, 'admin', 'active')`
      )
      .bind(TEST_ORG.id, APPROVER.id),
    db
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES ('pm_dvp_policy', ?, ?, 'admin')`
      )
      .bind(TEST_PROJECT.id, APPROVER.id),
  ]);
}

async function approverHeaders() {
  return {
    Authorization: `Bearer ${await signSeededClerkMember(env, getDb(env), APPROVER.id, TEST_ORG.id)}`,
    "x-project-id": TEST_PROJECT.id,
  };
}

async function seedCustody(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'privy', 'encrypted', 'active')`
      )
      .bind(CUSTODY_CONFIG_ID, TEST_ORG.id, TEST_PROJECT.id),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(PARTY_A_WALLET.id, CUSTODY_CONFIG_ID, PARTY_A_WALLET.walletId, PARTY_A_ADDRESS),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status, purpose)
         VALUES (?, ?, ?, ?, 'active', 'dvp_settlement_authority')`
      )
      .bind(
        SETTLEMENT_WALLET.id,
        CUSTODY_CONFIG_ID,
        SETTLEMENT_WALLET.walletId,
        SETTLEMENT_AUTHORITY
      ),
    db
      .prepare(
        `INSERT INTO dvp_settlement_wallets (project_id, organization_id, custody_wallet_id)
         VALUES (?, ?, ?)`
      )
      .bind(TEST_PROJECT.id, TEST_ORG.id, SETTLEMENT_WALLET.id),
  ]);
}

async function seedTrade(tradeId: string, status: string): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO dvp_trades (
         id, organization_id, project_id, swap_dvp, settlement_authority,
         user_a, user_b, mint_a, mint_b, nonce, token_program_a, token_program_b,
         decimals_a, decimals_b, symbol_a, symbol_b,
         amount_a, amount_b, expiry_timestamp,
         user_a_settlement_destination, user_b_settlement_destination,
         escrow_a, escrow_b, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,
         'AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE', '7',
         'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
         'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
         6, 6, 'ATD', 'USDC',
         ?, '2000', '1900000000',
         ?, ?, ?, '6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y', ?
       )`
    )
    .bind(
      tradeId,
      TEST_ORG.id,
      TEST_PROJECT.id,
      SWAP_DVP,
      SETTLEMENT_AUTHORITY,
      PARTY_A_ADDRESS,
      PARTY_B_EXTERNAL,
      MINT_A,
      LEG_A_TARGET,
      PARTY_A_ADDRESS,
      PARTY_B_EXTERNAL,
      ESCROW_A,
      status
    )
    .run();
}

async function seedWalletPolicy(
  custodyWalletId: string,
  rules: PolicyRule[],
  defaultAction: "allow" | "deny" | "approval_required"
): Promise<void> {
  const repo = createPolicyRepository(
    env,
    createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id })
  );
  const profile = await repo.createWalletControlProfile({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    custodyWalletId,
    name: `policy for ${custodyWalletId}`,
    createdBy: TEST_USER.id,
  });
  assert(profile);
  const revision = await repo.createWalletControlProfileRevision({
    profileId: profile.id,
    rules,
    defaultAction,
    createdBy: TEST_USER.id,
  });
  assert(revision);
  await repo.activateWalletControlProfileRevision({
    profileId: profile.id,
    revisionId: revision.id,
  });
}

function post(tradeId: string, action: string, body?: unknown, extra?: Record<string, string>) {
  return app.request(
    `/v1/dvp/trades/${tradeId}/${action}`,
    {
      method: "POST",
      headers: authHeaders({ ...extra }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env
  );
}

describe("DvP wallet-policy gating (PRO-1975)", () => {
  beforeEach(async () => {
    originalMarkets = env.MARKETS_ENABLED;
    env.MARKETS_ENABLED = "true";
    await seedTestDatabase(env);
    await seedAuth();
    await seedCustody();
    for (const stub of [fundDvpTradeLeg, reclaimDvpTradeLeg, closeDvpTrade, observeDvpTradeNow]) {
      stub.mockReset();
    }
    fundDvpTradeLeg.mockResolvedValue({
      signature: FUND_SIGNATURE,
      leg: "a",
      amount: LEG_A_TARGET,
    });
    reclaimDvpTradeLeg.mockResolvedValue({
      signature: FUND_SIGNATURE,
      leg: "a",
      amount: LEG_A_TARGET,
    });
    closeDvpTrade.mockResolvedValue({ signature: CLOSE_SIGNATURE, landed: true });
    observeDvpTradeNow.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    env.MARKETS_ENABLED = originalMarkets;
    await clearKVStores(env);
    vi.restoreAllMocks();
  });

  describe("the two actions that commit value", () => {
    it("refuses a funding the wallet's policy denies, and sends nothing", async () => {
      await seedTrade("dvp_policy_fund_deny", "funded");
      await seedWalletPolicy(
        PARTY_A_WALLET.id,
        [{ id: "deny-fund", kind: "operation_type", operationTypes: ["dvp_fund"], action: "deny" }],
        "allow"
      );

      const res = await post("dvp_policy_fund_deny", "fund", { side: "a" });

      expect(res.status).toBe(403);
      expect(fundDvpTradeLeg).not.toHaveBeenCalled();
    });

    it("refuses a settle the settlement wallet's policy denies", async () => {
      await seedTrade("dvp_policy_settle_deny", "funded");
      await seedWalletPolicy(
        SETTLEMENT_WALLET.id,
        [
          {
            id: "deny-settle",
            kind: "operation_type",
            operationTypes: ["dvp_settle"],
            action: "deny",
          },
        ],
        "allow"
      );

      const res = await post("dvp_policy_settle_deny", "settle");

      expect(res.status).toBe(403);
      expect(closeDvpTrade).not.toHaveBeenCalled();
    });

    it("holds a funding for approval instead of sending it", async () => {
      await seedTrade("dvp_policy_fund_approval", "funded");
      await seedWalletPolicy(
        PARTY_A_WALLET.id,
        [{ id: "approve-fund", kind: "approval", operationTypes: ["dvp_fund"] }],
        "allow"
      );

      const res = await post("dvp_policy_fund_approval", "fund", { side: "a" });

      expect(res.status).toBe(202);
      const body = (await res.json()) as {
        error: { code: string; details: { approvalRequestId: string } };
      };
      expect(body.error.code).toBe("SIGNING_PENDING");
      expect(body.error.details.approvalRequestId).toBeTruthy();
      expect(fundDvpTradeLeg).not.toHaveBeenCalled();
    });

    it("executes the funding once an approver allows it", async () => {
      await seedTrade("dvp_policy_fund_approved", "funded");
      await seedWalletPolicy(
        PARTY_A_WALLET.id,
        [{ id: "approve-fund", kind: "approval", operationTypes: ["dvp_fund"] }],
        "allow"
      );

      const held = await post("dvp_policy_fund_approved", "fund", { side: "a" });
      expect(held.status).toBe(202);
      const { error } = (await held.json()) as {
        error: { details: { approvalRequestId: string } };
      };

      const decided = await app.request(
        `/v1/wallets/approval-requests/${error.details.approvalRequestId}/approve`,
        {
          method: "POST",
          headers: { ...(await approverHeaders()), "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
        env
      );
      expect(decided.status).toBe(200);

      await recoverApprovedWalletOperations(env);
      expect(fundDvpTradeLeg).toHaveBeenCalledTimes(1);
    });

    it("executes the settlement once an approver allows it", async () => {
      await seedTrade("dvp_policy_settle_approved", "funded");
      await seedWalletPolicy(
        SETTLEMENT_WALLET.id,
        [{ id: "approve-settle", kind: "approval", operationTypes: ["dvp_settle"] }],
        "allow"
      );

      const held = await post("dvp_policy_settle_approved", "settle");
      expect(held.status).toBe(202);
      const { error } = (await held.json()) as {
        error: { details: { approvalRequestId: string } };
      };

      const decided = await app.request(
        `/v1/wallets/approval-requests/${error.details.approvalRequestId}/approve`,
        {
          method: "POST",
          headers: { ...(await approverHeaders()), "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
        env
      );
      expect(decided.status).toBe(200);

      await recoverApprovedWalletOperations(env);
      expect(closeDvpTrade).toHaveBeenCalledTimes(1);
    });

    it("judges the leg's full target, so the approval is a ceiling", async () => {
      await seedTrade("dvp_policy_fund_ceiling", "funded");
      await seedWalletPolicy(
        PARTY_A_WALLET.id,
        [{ id: "approve-fund", kind: "approval", operationTypes: ["dvp_fund"] }],
        "allow"
      );

      await post("dvp_policy_fund_ceiling", "fund", { side: "a" });

      const row = await getDb(env)
        .prepare(
          `SELECT amount, asset, destination, operation_type, operation_family,
                  custody_wallet_id, project_id
             FROM wallet_operations WHERE operation_type = 'dvp_fund'`
        )
        .first<Record<string, unknown>>();

      expect(row).toMatchObject({
        amount: "0.001",
        asset: MINT_A,
        destination: ESCROW_A,
        operation_family: "program",
        custody_wallet_id: PARTY_A_WALLET.id,
        project_id: TEST_PROJECT.id,
      });
    });
  });

  describe("the two recovery paths are not gated", () => {
    it("runs a reclaim even when the wallet denies everything", async () => {
      await seedTrade("dvp_policy_reclaim_open", "funded");
      await seedWalletPolicy(PARTY_A_WALLET.id, [], "deny");

      const res = await post("dvp_policy_reclaim_open", "reclaim", { side: "a" });

      expect(res.status).toBe(200);
      expect(reclaimDvpTradeLeg).toHaveBeenCalledTimes(1);
    });

    it("runs a cancel even when the settlement wallet denies everything", async () => {
      await seedTrade("dvp_policy_cancel_open", "funded");
      await seedWalletPolicy(SETTLEMENT_WALLET.id, [], "deny");

      const res = await post("dvp_policy_cancel_open", "cancel");

      expect(res.status).toBe(200);
      expect(closeDvpTrade).toHaveBeenCalledTimes(1);
    });

    it("denies the funding and allows the reclaim under one policy", async () => {
      await seedTrade("dvp_policy_mixed", "funded");
      await seedWalletPolicy(PARTY_A_WALLET.id, [], "deny");

      expect((await post("dvp_policy_mixed", "fund", { side: "a" })).status).toBe(403);
      expect((await post("dvp_policy_mixed", "reclaim", { side: "a" })).status).toBe(200);
      expect(fundDvpTradeLeg).not.toHaveBeenCalled();
      expect(reclaimDvpTradeLeg).toHaveBeenCalledTimes(1);
    });
  });

  it("answers a dry run with the verdict and moves nothing", async () => {
    await seedTrade("dvp_policy_dry_run", "funded");
    await seedWalletPolicy(
      PARTY_A_WALLET.id,
      [{ id: "deny-fund", kind: "operation_type", operationTypes: ["dvp_fund"], action: "deny" }],
      "allow"
    );

    const res = await post("dvp_policy_dry_run", "fund", { side: "a" }, { "Dry-Run": "true" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { decision: string } };
    expect(body.data.decision).toBe("deny");
    expect(fundDvpTradeLeg).not.toHaveBeenCalled();
    const operations = await getDb(env)
      .prepare("SELECT id FROM wallet_operations")
      .all<{ id: string }>();
    expect(operations.results).toHaveLength(0);
  });

  it("judges an inbound trade against the caller's own project", async () => {
    await seedTrade("dvp_policy_inbound", "funded");
    await getDb(env)
      .prepare("UPDATE dvp_trades SET project_id = ?, organization_id = ? WHERE id = ?")
      .bind(`${TEST_PROJECT.id}_production`, TEST_ORG.id, "dvp_policy_inbound")
      .run();
    await seedWalletPolicy(
      PARTY_A_WALLET.id,
      [{ id: "approve-fund", kind: "approval", operationTypes: ["dvp_fund"] }],
      "allow"
    );

    const res = await post("dvp_policy_inbound", "fund", { side: "a" });

    expect(res.status).toBe(202);
    const row = await getDb(env)
      .prepare("SELECT project_id FROM wallet_operations WHERE operation_type = 'dvp_fund'")
      .first<{ project_id: string }>();
    expect(required(row).project_id).toBe(TEST_PROJECT.id);
  });

  it("funds normally when no policy governs the wallet", async () => {
    await seedTrade("dvp_policy_ungoverned", "funded");

    const res = await post("dvp_policy_ungoverned", "fund", { side: "a" });

    expect(res.status).toBe(200);
    expect(fundDvpTradeLeg).toHaveBeenCalledTimes(1);
  });
});
