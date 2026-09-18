/**
 * Audit-ledger parity for DvP money movement (PRO-1992).
 *
 * The money services are stubbed here on purpose: what these tests are about
 * is the bracket around them, and in particular the two postures the bracket
 * takes. Funding must not happen when the ledger cannot admit it; a close must
 * happen even when the ledger cannot record it, because refusing an exit
 * leaves both deposits in escrow. The services' own behaviour is covered in
 * `services/dvp/{fund,reclaim,settle}.test.ts`.
 */

import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { badRequest } from "@/lib/errors";
import { AuditService } from "@/services/audit.service";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const fundDvpTradeLeg = vi.hoisted(() => vi.fn());
const reclaimDvpTradeLeg = vi.hoisted(() => vi.fn());
const closeDvpTrade = vi.hoisted(() => vi.fn());
const observeDvpTradeNow = vi.hoisted(() => vi.fn());

// Each module keeps every other export (the `importOriginal` spread the earn
// suites use): a module replaced wholesale would silently drop an export the
// handlers pick up later, and the test would keep passing.
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
// Observation reads the chain, which has nothing to do with the bracket.
vi.mock("@/services/dvp/observe-now", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/dvp/observe-now")>()),
  observeDvpTradeNow,
}));

const TEST_ORG = { id: "org_dvp_audit", name: "DvP Audit Org", slug: "dvp-audit-org" };
const TEST_PROJECT = { id: "prj_dvp_audit", slug: "dvp-audit-project" };
const TEST_USER = { id: "usr_dvp_audit", email: "dvp-audit@example.com" };
const TEST_API_KEY = { id: "key_dvp_audit", raw: "sk_test_dvp_audit", prefix: "sk_test_dvp_aud" };

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

const CUSTODY_CONFIG_ID = "cust_dvp_audit";
const PARTY_A_WALLET = { id: "cwlt_dvp_audit_a", walletId: "dvp_audit_wallet_a" };
const SETTLEMENT_WALLET = { id: "cwlt_dvp_audit_auth", walletId: "dvp_audit_wallet_auth" };
const PARTY_A_ADDRESS = "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn";
const PARTY_B_EXTERNAL = "C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk";
const SETTLEMENT_AUTHORITY = "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY";
const SWAP_DVP = "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po";
const MINT_A = "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1";
const FUND_SIGNATURE =
  "4NC4dm4WmFqLCQLAvrfxQRoUwBJn7M6vXFRT2mHqMqfkNLeCHGscpVKb1pPcaLxDyPPwzm3CqPRMR4MAQVnpcgVj";
const CLOSE_SIGNATURE =
  "5dRjDnZKcJfMe9vGkJCFbvuLPU4cJfKSMswkaTTd4oQGgtNDdk3vhkfaeKBCWa4sJGnNFdGCVAaKyYdPqvXNwYNG";

let originalMarkets: string | undefined;

function authHeaders() {
  return {
    Authorization: `Bearer ${TEST_API_KEY.raw}`,
    "Content-Type": "application/json",
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      TEST_API_KEY.id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_USER.id,
      "DvP Audit Key",
      TEST_API_KEY.prefix,
      keyHash,
      "api_admin",
      JSON.stringify(["*"]),
      "active"
    )
    .run();
}

/**
 * The party wallet funding and reclaiming side A, and the settlement authority
 * the close signs with. Both are re-read from the database by the handlers, so
 * neither can be faked in the cached key alone.
 */
async function seedCustody(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'local', 'x', 'active')`
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

async function seedTrade(tradeId: string, status = "created"): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO dvp_trades (
         id, organization_id, project_id, swap_dvp,
         settlement_authority, user_a, user_b, mint_a, mint_b, nonce,
         token_program_a, token_program_b,
         amount_a, amount_b, expiry_timestamp,
         user_a_settlement_destination, user_b_settlement_destination,
         escrow_a, escrow_b, status
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?,
         'AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE',
         '7', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
         'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
         '1000', '2000', '1900000000',
         ?, ?,
         'FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU',
         '6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y',
         ?
       )`
    )
    .bind(
      tradeId,
      TEST_ORG.id,
      TEST_PROJECT.id,
      // `dvp_trades` is unique on swap_dvp, and the reset truncates between
      // tests, so one trade account serves every case here.
      SWAP_DVP,
      SETTLEMENT_AUTHORITY,
      PARTY_A_ADDRESS,
      PARTY_B_EXTERNAL,
      MINT_A,
      PARTY_A_ADDRESS,
      PARTY_B_EXTERNAL,
      status
    )
    .run();
}

async function dvpAuditRows(action: "fund" | "reclaim" | "settle" | "cancel") {
  const { results } = await getDb(env)
    .prepare(
      `SELECT * FROM audit_logs
        WHERE action = ? AND resource_type = 'dvp_trade'
        ORDER BY ledger_sequence`
    )
    .bind(action)
    .all<Record<string, unknown>>();
  return results ?? [];
}

async function postAction(tradeId: string, action: string, body?: unknown) {
  return app.request(
    `/v1/dvp/trades/${tradeId}/${action}`,
    {
      method: "POST",
      headers: authHeaders(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env
  );
}

describe("DvP audit-ledger parity (PRO-1992)", () => {
  beforeEach(async () => {
    originalMarkets = env.MARKETS_ENABLED;
    env.MARKETS_ENABLED = "true";
    await seedTestDatabase(env);
    await seedAuth();
    await seedCustody();
    fundDvpTradeLeg.mockReset();
    reclaimDvpTradeLeg.mockReset();
    closeDvpTrade.mockReset();
    observeDvpTradeNow.mockReset();
    fundDvpTradeLeg.mockResolvedValue({ signature: FUND_SIGNATURE, leg: "a", amount: "1000" });
    reclaimDvpTradeLeg.mockResolvedValue({ signature: FUND_SIGNATURE, leg: "a", amount: "1000" });
    closeDvpTrade.mockResolvedValue({ signature: CLOSE_SIGNATURE, landed: true });
    observeDvpTradeNow.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    env.MARKETS_ENABLED = originalMarkets;
    await clearKVStores(env);
    vi.restoreAllMocks();
  });

  describe("funding a leg: money in, fail closed", () => {
    it("records an intent and an outcome around the transfer, keyed to the trade", async () => {
      await seedTrade("dvp_audit_fund");

      const res = await postAction("dvp_audit_fund", "fund", { side: "a" });
      expect(res.status).toBe(200);

      const rows = await dvpAuditRows("fund");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        resource_id: "dvp_audit_fund",
        organization_id: TEST_ORG.id,
        api_key_id: TEST_API_KEY.id,
        user_id: null,
        status: "success",
      });
      // The side and the wallet that signed are what an operator needs, and a
      // leg has no id of its own to carry them.
      const metadata = String(rows[0]?.metadata);
      expect(metadata).toContain('"side":"a"');
      expect(metadata).toContain(PARTY_A_WALLET.id);
      expect(metadata).toContain(FUND_SIGNATURE);
      expect(metadata).toContain('"auditPhase":"outcome"');

      // The intent is its own row, written before the transfer.
      const { results: intents } = await getDb(env)
        .prepare(
          `SELECT * FROM audit_logs WHERE resource_type = 'audit_ledger' ORDER BY ledger_sequence`
        )
        .all<Record<string, unknown>>();
      expect(intents ?? []).toHaveLength(1);
      expect(String(intents?.[0]?.metadata)).toContain('"action":"fund"');

      // The org feed surfaces it (PRO-1992 "done when").
      const feed = await new AuditService(getDb(env)).getForOrganization(TEST_ORG.id, {
        action: "fund",
      });
      expect(feed.some((entry) => entry.resourceId === "dvp_audit_fund")).toBe(true);
    });

    it("refuses the funding when the intent cannot persist, and sends nothing", async () => {
      await seedTrade("dvp_audit_fund_down");
      vi.spyOn(AuditService.prototype, "log").mockRejectedValue(new Error("audit ledger locked"));

      const res = await postAction("dvp_audit_fund_down", "fund", { side: "a" });

      expect(res.status).toBe(500);
      expect(fundDvpTradeLeg).not.toHaveBeenCalled();
    });

    it("closes the intent as a failure when funding is refused with a 4xx", async () => {
      await seedTrade("dvp_audit_fund_4xx");
      fundDvpTradeLeg.mockRejectedValue(badRequest("the leg is already funded"));

      const res = await postAction("dvp_audit_fund_4xx", "fund", { side: "a" });
      expect(res.status).toBe(400);

      // A 4xx is raised before broadcast, so verification must not be paged
      // over tokens that never left the custody wallet.
      const rows = await dvpAuditRows("fund");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "failure" });
      expect(String(rows[0]?.metadata)).toContain("already funded");
    });

    it("leaves the intent unresolved on an ambiguous failure: the transfer may have landed", async () => {
      await seedTrade("dvp_audit_fund_ambiguous");
      fundDvpTradeLeg.mockRejectedValue(new Error("funding was sent but could not be classified"));

      const res = await postAction("dvp_audit_fund_ambiguous", "fund", { side: "a" });
      expect(res.status).toBe(500);

      // The intent is there and stays open. No outcome row: unresolved is the
      // signal that sends an operator to the claim row, where "failure" would
      // be a false record.
      const { results: intents } = await getDb(env)
        .prepare("SELECT metadata FROM audit_logs WHERE resource_type = 'audit_ledger'")
        .all<{ metadata: string }>();
      expect(intents ?? []).toHaveLength(1);
      expect(String(intents?.[0]?.metadata)).toContain('"action":"fund"');
      expect(await dvpAuditRows("fund")).toHaveLength(0);
    });
  });

  describe("exits: recorded after the effect, never blocking it", () => {
    it("records a reclaim with the signature that moved the deposit back", async () => {
      await seedTrade("dvp_audit_reclaim");

      const res = await postAction("dvp_audit_reclaim", "reclaim", { side: "a" });
      expect(res.status).toBe(200);

      const rows = await dvpAuditRows("reclaim");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        resource_id: "dvp_audit_reclaim",
        organization_id: TEST_ORG.id,
        api_key_id: TEST_API_KEY.id,
        status: "success",
      });
      expect(String(rows[0]?.metadata)).toContain(FUND_SIGNATURE);
    });

    it("records a settle with its signature and whether the request saw it confirm", async () => {
      await seedTrade("dvp_audit_settle", "funded");
      closeDvpTrade.mockResolvedValue({ signature: CLOSE_SIGNATURE, landed: false });

      const res = await postAction("dvp_audit_settle", "settle");
      expect(res.status).toBe(200);

      const rows = await dvpAuditRows("settle");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ resource_id: "dvp_audit_settle" });
      const metadata = String(rows[0]?.metadata);
      expect(metadata).toContain(CLOSE_SIGNATURE);
      // An unconfirmed broadcast is recorded as one, not as a settlement.
      expect(metadata).toContain('"confirmed":false');
      expect(metadata).toContain(SETTLEMENT_WALLET.id);
    });

    it("records a cancel", async () => {
      await seedTrade("dvp_audit_cancel");

      const res = await postAction("dvp_audit_cancel", "cancel");
      expect(res.status).toBe(200);

      const rows = await dvpAuditRows("cancel");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ resource_id: "dvp_audit_cancel" });
    });

    // The exit-safety rule: a ledger outage must never be the reason a deposit
    // stays in escrow. ADR 0002, and routes/earn/CLAUDE.md's gate asymmetry.
    it("settles anyway when the audit write fails, and says so in the logs", async () => {
      await seedTrade("dvp_audit_settle_down", "funded");
      const log = vi
        .spyOn(AuditService.prototype, "log")
        .mockRejectedValue(new Error("audit ledger locked"));

      const res = await postAction("dvp_audit_settle_down", "settle");

      expect(res.status).toBe(200);
      expect(closeDvpTrade).toHaveBeenCalledTimes(1);
      expect(await dvpAuditRows("settle")).toHaveLength(0);
      // Asserted, not inferred: a route that stopped writing the record at all
      // would also answer 200 with no rows.
      expect(log).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "settle", resourceType: "dvp_trade" })
      );
    });

    it("reclaims anyway when the audit write fails", async () => {
      await seedTrade("dvp_audit_reclaim_down");
      const log = vi
        .spyOn(AuditService.prototype, "log")
        .mockRejectedValue(new Error("audit ledger locked"));

      const res = await postAction("dvp_audit_reclaim_down", "reclaim", { side: "a" });

      expect(res.status).toBe(200);
      expect(reclaimDvpTradeLeg).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "reclaim", resourceType: "dvp_trade" })
      );
    });
  });
});
