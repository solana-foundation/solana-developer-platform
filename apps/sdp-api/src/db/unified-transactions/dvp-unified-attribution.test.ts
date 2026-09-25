/**
 * Regression test for Apex finding SOLA9-352 (APE-695).
 *
 * The unified DvP source must not present a mutable funding-claim lock as
 * permanent `fund` history, and must attribute a close to the recorded
 * settlement-authority wallet rather than to a side funder's custody wallet.
 *
 * Secure behavior asserted here:
 *   1. An unbroadcast funding lock is not funding evidence: no `fund` row.
 *   2. A broadcast funding appears as a `fund` row carrying the funder's own
 *      signature, wallet, and tenant, and a reclaim taking the leg's lock over
 *      must neither rewrite that row to the reclaim's signature nor remove it.
 *   3. Close rows carry the settlement authority's custody wallet inside the
 *      trade's organization/project domain, so a settlement-wallet-scoped read
 *      finds them and no side funder's wallet id leaks into them.
 *   4. A funding the chain proved moved nothing leaves no fund row behind.
 *   5. Each funder's receipt stays inside its own tenant.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { runWithSystemDatabaseIdentity, runWithTenantDatabaseIdentity } from "@/db/identity";
import { createPostgresDvpLegFundingClaimRepository } from "@/db/repositories/dvp-leg-funding-claim.repository";
import { createPostgresUnifiedTransactionsRepository } from "@/db/repositories/unified-transactions.repository.postgres";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const ORG_A = "org_poc_dvp_a";
const ORG_B = "org_poc_dvp_b";
const USER_A = "usr_poc_dvp_a";
const USER_B = "usr_poc_dvp_b";
const PROJECT_A = "prj_poc_dvp_a";
const PROJECT_B = "prj_poc_dvp_b";
const WALLET_A_FUNDER = "cwlt_poc_dvp_a_funder";
const WALLET_A_SETTLEMENT = "cwlt_poc_dvp_a_settlement";
const WALLET_B_FUNDER = "cwlt_poc_dvp_b_funder";
const SETTLEMENT_AUTHORITY = "PocDvpASettlement111";

async function seedFixture(): Promise<void> {
  await seedTestDatabase(env);
  const db = getDb(env);

  await db.batch([
    db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(ORG_A, "DvP POC A", "poc-dvp-a"),
    db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(ORG_B, "DvP POC B", "poc-dvp-b"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER_A, "poc-dvp-a@example.test"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER_B, "poc-dvp-b@example.test"),
  ]);

  await seedDefaultProjects(db, {
    organizationId: ORG_A,
    createdBy: USER_A,
    members: [],
    ids: { sandbox: PROJECT_A, production: `${PROJECT_A}_production` },
  });
  await seedDefaultProjects(db, {
    organizationId: ORG_B,
    createdBy: USER_B,
    members: [],
    ids: { sandbox: PROJECT_B, production: `${PROJECT_B}_production` },
  });

  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'local', 'poc-only', 'active')`
      )
      .bind("cfg_poc_dvp_a", ORG_A, PROJECT_A),
    db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'local', 'poc-only', 'active')`
      )
      .bind("cfg_poc_dvp_b", ORG_B, PROJECT_B),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, label, status)
         VALUES (?, 'cfg_poc_dvp_a', ?, ?, ?, 'active')`
      )
      .bind(WALLET_A_FUNDER, "provider-a-funder", "PocPartyA111", "A funder"),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, label, status)
         VALUES (?, 'cfg_poc_dvp_a', ?, ?, ?, 'active')`
      )
      .bind(
        WALLET_A_SETTLEMENT,
        "provider-a-settlement",
        SETTLEMENT_AUTHORITY,
        "A settlement authority"
      ),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, label, status)
         VALUES (?, 'cfg_poc_dvp_b', ?, ?, ?, 'active')`
      )
      .bind(WALLET_B_FUNDER, "provider-b-funder", "PocPartyB111", "B funder"),
    db
      .prepare(
        `INSERT INTO dvp_settlement_wallets (project_id, organization_id, custody_wallet_id)
         VALUES (?, ?, ?)`
      )
      .bind(PROJECT_A, ORG_A, WALLET_A_SETTLEMENT),
  ]);
}

async function insertTrade(
  id: string,
  status: "partially_funded" | "settled",
  closeSignature: string | null = null
): Promise<void> {
  await getDb(env).execute(
    `INSERT INTO dvp_trades
       (id, organization_id, project_id, swap_dvp, settlement_authority, user_a, user_b,
        mint_a, mint_b, nonce, token_program_a, token_program_b, amount_a, amount_b,
        expiry_timestamp, user_a_settlement_destination, user_b_settlement_destination,
        escrow_a, escrow_b, status, escrow_a_amount, escrow_b_amount,
        escrow_a_peak_amount, escrow_b_peak_amount, decimals_a, decimals_b,
        close_signature, closed_at)
     VALUES (?, ?, ?, ?, ?, 'PocPartyA111', 'PocPartyB111',
             'PocMintA111', 'PocMintB111', '1', 'PocTokenProgram111', 'PocTokenProgram222',
             '1000000', '2000000', '2000000000', 'PocDestinationA111',
             'PocDestinationB111', 'PocEscrowA111', 'PocEscrowB111', ?, '0', '0',
             '1000000', '2000000', 6, 6, ?, CASE WHEN ?::text IS NULL THEN NULL ELSE '2026-09-24T08:00:00.000Z' END)`,
    [
      id,
      ORG_A,
      PROJECT_A,
      `PocSwap${id}`,
      SETTLEMENT_AUTHORITY,
      status,
      closeSignature,
      closeSignature,
    ]
  );
}

async function insertClaim(
  tradeId: string,
  side: "a" | "b",
  organizationId: string,
  projectId: string,
  custodyWalletId: string,
  signature: string,
  fundingTx: string | null
): Promise<void> {
  await getDb(env).execute(
    `INSERT INTO dvp_leg_funding_claims
       (trade_id, side, organization_id, project_id, custody_wallet_id, signature, expiry_height, funding_tx)
     VALUES (?, ?, ?, ?, ?, ?, '999999', ?)`,
    [tradeId, side, organizationId, projectId, custodyWalletId, signature, fundingTx]
  );
}

async function listDvp(input: {
  organizationId: string;
  projectId: string;
  moduleWalletScopes?: readonly { module: "dvp"; custodyWalletIds: readonly string[] }[];
}) {
  const repository = createPostgresUnifiedTransactionsRepository(getDb(env));
  return runWithTenantDatabaseIdentity({ organizationId: input.organizationId }, () =>
    repository.list({
      organizationId: input.organizationId,
      projectId: input.projectId,
      modules: ["dvp"],
      moduleWalletScopes: input.moduleWalletScopes,
      limit: 100,
    })
  );
}

describe("DvP unified transaction attribution (SOLA9-352)", () => {
  beforeEach(seedFixture);

  it("does not present an unbroadcast funding lock as a fund event", async () => {
    await insertTrade("dvp_poc_lock", "partially_funded");
    await insertClaim(
      "dvp_poc_lock",
      "a",
      ORG_A,
      PROJECT_A,
      WALLET_A_FUNDER,
      "sig_unbroadcast",
      null
    );

    const feed = await listDvp({ organizationId: ORG_A, projectId: PROJECT_A });
    expect(feed.rows.filter((row) => row.moduleId === "dvp_poc_lock")).toEqual([]);
  });

  it("keeps a broadcast funding receipt immutable across a reclaim", async () => {
    await insertTrade("dvp_poc_reclaim", "partially_funded");
    await insertClaim(
      "dvp_poc_reclaim",
      "a",
      ORG_A,
      PROJECT_A,
      WALLET_A_FUNDER,
      "sig_original_funding",
      null
    );

    await runWithTenantDatabaseIdentity({ organizationId: ORG_A }, async () => {
      const claims = createPostgresDvpLegFundingClaimRepository(getDb(env));

      // The funding is broadcast: the receipt is the fund event.
      await claims.recordFundingTx("dvp_poc_reclaim", "a", "sig_original_funding");
      const afterBroadcast = await listDvp({ organizationId: ORG_A, projectId: PROJECT_A });
      expect(afterBroadcast.rows.filter((row) => row.moduleId === "dvp_poc_reclaim")).toEqual([
        expect.objectContaining({
          kind: "fund",
          signature: "sig_original_funding",
          custodyWalletId: WALLET_A_FUNDER,
          organizationId: ORG_A,
          projectId: PROJECT_A,
        }),
      ]);

      // A reclaim takes the leg's lock over (the chain read confirmed the
      // funding landed or moved nothing). The feed must keep reporting the
      // original funding and must never show the reclaim's signature as a fund.
      await claims.claimForReclaim(
        {
          tradeId: "dvp_poc_reclaim",
          side: "a",
          organizationId: ORG_A,
          projectId: PROJECT_A,
          custodyWalletId: WALLET_A_FUNDER,
          signature: "sig_reclaim",
          expiryHeight: "999999",
        },
        "sig_original_funding"
      );
      const duringReclaim = await listDvp({ organizationId: ORG_A, projectId: PROJECT_A });
      expect(duringReclaim.rows.filter((row) => row.moduleId === "dvp_poc_reclaim")).toEqual([
        expect.objectContaining({
          kind: "fund",
          signature: "sig_original_funding",
          custodyWalletId: WALLET_A_FUNDER,
        }),
      ]);
      expect(duringReclaim.rows.some((row) => row.signature === "sig_reclaim")).toBe(false);

      // The reclaim confirms and releases its lock. The original funding
      // receipt is history and must survive it.
      await claims.release("dvp_poc_reclaim", "a", "sig_reclaim");
      const afterReclaim = await listDvp({ organizationId: ORG_A, projectId: PROJECT_A });
      expect(afterReclaim.rows.filter((row) => row.moduleId === "dvp_poc_reclaim")).toEqual([
        expect.objectContaining({
          kind: "fund",
          signature: "sig_original_funding",
          custodyWalletId: WALLET_A_FUNDER,
        }),
      ]);
    });
  });

  it("attributes a close to the settlement authority wallet in the trade's tenant domain", async () => {
    await insertTrade("dvp_poc_close", "settled", "sig_settlement_authority");
    await insertClaim(
      "dvp_poc_close",
      "a",
      ORG_A,
      PROJECT_A,
      WALLET_A_FUNDER,
      "sig_a_funding",
      "sig_a_funding"
    );
    await insertClaim(
      "dvp_poc_close",
      "b",
      ORG_B,
      PROJECT_B,
      WALLET_B_FUNDER,
      "sig_b_funding",
      "sig_b_funding"
    );

    const orgAFeed = await listDvp({ organizationId: ORG_A, projectId: PROJECT_A });
    const closeRows = orgAFeed.rows
      .filter((row) => row.moduleId === "dvp_poc_close" && row.kind === "close")
      .sort((left, right) => left.id.localeCompare(right.id));
    expect(closeRows).toHaveLength(2);
    // Both close rows belong to the trade's organization/project and name the
    // recorded settlement authority's custody wallet — never a side funder's.
    for (const row of closeRows) {
      expect(row).toMatchObject({
        organizationId: ORG_A,
        projectId: PROJECT_A,
        custodyWalletId: WALLET_A_SETTLEMENT,
        signature: "sig_settlement_authority",
      });
    }
    expect(closeRows.some((row) => row.custodyWalletId === WALLET_A_FUNDER)).toBe(false);
    expect(closeRows.some((row) => row.custodyWalletId === WALLET_B_FUNDER)).toBe(false);

    // A feed scoped to the settlement wallet finds the closes it signed.
    const authorityScoped = await listDvp({
      organizationId: ORG_A,
      projectId: PROJECT_A,
      moduleWalletScopes: [{ module: "dvp", custodyWalletIds: [WALLET_A_SETTLEMENT] }],
    });
    expect(
      authorityScoped.rows.filter((row) => row.moduleId === "dvp_poc_close" && row.kind === "close")
    ).toHaveLength(2);
  });

  it("leaves no fund row for a funding the chain proved moved nothing", async () => {
    await insertTrade("dvp_poc_dead", "partially_funded");
    await insertClaim(
      "dvp_poc_dead",
      "a",
      ORG_A,
      PROJECT_A,
      WALLET_A_FUNDER,
      "sig_brd_dead",
      "sig_brd_dead"
    );

    await runWithTenantDatabaseIdentity({ organizationId: ORG_A }, async () => {
      const claims = createPostgresDvpLegFundingClaimRepository(getDb(env));
      await claims.recordFundingTx("dvp_poc_dead", "a", "sig_brd_dead");
      await claims.deleteBroadcastClaim("dvp_poc_dead", "a", "sig_brd_dead");
    });

    const rows = await listDvp({ organizationId: ORG_A, projectId: PROJECT_A });
    expect(rows.rows.filter((row) => row.moduleId === "dvp_poc_dead")).toEqual([]);
  });

  it("keeps each funder's receipt inside its own tenant", async () => {
    await insertTrade("dvp_poc_shared", "partially_funded");
    await insertClaim(
      "dvp_poc_shared",
      "a",
      ORG_A,
      PROJECT_A,
      WALLET_A_FUNDER,
      "sig_a_funding",
      "sig_a_funding"
    );
    await insertClaim(
      "dvp_poc_shared",
      "b",
      ORG_B,
      PROJECT_B,
      WALLET_B_FUNDER,
      "sig_b_funding",
      "sig_b_funding"
    );
    await runWithSystemDatabaseIdentity("poc-dvp-unified-transactions", async () => {
      const claims = createPostgresDvpLegFundingClaimRepository(getDb(env));
      await claims.recordFundingTx("dvp_poc_shared", "a", "sig_a_funding");
      await claims.recordFundingTx("dvp_poc_shared", "b", "sig_b_funding");
    });

    const orgAFeed = await listDvp({ organizationId: ORG_A, projectId: PROJECT_A });
    expect(orgAFeed.rows.filter((row) => row.moduleId === "dvp_poc_shared")).toEqual([
      expect.objectContaining({
        kind: "fund",
        signature: "sig_a_funding",
        custodyWalletId: WALLET_A_FUNDER,
        organizationId: ORG_A,
      }),
    ]);

    // The party funder keeps seeing its own funding in its own feed, while the
    // trade owner's close rows stay in the owner's domain only.
    const orgBFeed = await listDvp({ organizationId: ORG_B, projectId: PROJECT_B });
    expect(orgBFeed.rows.filter((row) => row.moduleId === "dvp_poc_shared")).toEqual([
      expect.objectContaining({
        kind: "fund",
        signature: "sig_b_funding",
        custodyWalletId: WALLET_B_FUNDER,
        organizationId: ORG_B,
      }),
    ]);
  });
});
