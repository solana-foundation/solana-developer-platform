/**
 * The one place a DvP trade crosses an organization boundary (migration 0089).
 *
 * PRO-1855 lets a named party read the trade that names it, so an agent-created
 * trade is discoverable by the two parties who were not in the room when it was
 * set up. That is a deliberate hole in the isolation floor, and these tests are
 * the description of its exact shape.
 *
 * Run under the plain NOSUPERUSER/NOBYPASSRLS runtime role like the rest of
 * `tenant-isolation.test.ts`, so what passes here is the database's answer and
 * not the application's.
 *
 * Four things have to be true, and the last two are what keep the hole a hole
 * rather than a door:
 *
 *   1. a party CAN read a trade another organization created
 *   2. a stranger CANNOT
 *   3. a party still cannot WRITE to it
 *   4. no identity reads nothing
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { runWithoutDatabaseIdentity, runWithTenantDatabaseIdentity } from "@/db/identity";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const AGENT_ORG = "org_dvp_party_agent";
const PARTY_ORG = "org_dvp_party_holder";
const STRANGER_ORG = "org_dvp_party_stranger";
const AGENT_PROJECT = "prj_dvp_party_agent";
const PARTY_PROJECT = "prj_dvp_party_holder";
const STRANGER_PROJECT = "prj_dvp_party_stranger";
const USER_ID = "usr_dvp_party";

const TRADE_ID = "dvp_party_read_trade";
/** Held by PARTY_ORG. Named as `user_b` on a trade AGENT_ORG created. */
const PARTY_ADDRESS = "C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk";
/** Named as `user_a`. Nobody in this test holds it. */
const OUTSIDE_ADDRESS = "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC";
/** Held by STRANGER_ORG, and on no trade. */
const STRANGER_ADDRESS = "7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg";

async function seed(): Promise<void> {
  const db = getDb(env);

  // `projects.created_by` is a foreign key, so the author has to exist first.
  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified, status)
       VALUES (?, 'dvp-party@example.com', 1, 'active')
       ON CONFLICT (id) DO NOTHING`
    )
    .bind(USER_ID)
    .run();

  for (const [org, project, slug] of [
    [AGENT_ORG, AGENT_PROJECT, "dvp-party-agent"],
    [PARTY_ORG, PARTY_PROJECT, "dvp-party-holder"],
    [STRANGER_ORG, STRANGER_PROJECT, "dvp-party-stranger"],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, ?, ?, 'individual', 'active')
         ON CONFLICT (id) DO NOTHING`
      )
      .bind(org, slug, slug)
      .run();
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'p', ?, 'sandbox', 'active', ?)
         ON CONFLICT (id) DO NOTHING`
      )
      .bind(project, org, project, USER_ID)
      .run();
  }

  // A wallet is reachable from its organization through its custody config,
  // which is how 0081 scopes `custody_wallets`, and therefore how 0089's
  // `sdp_dvp_caller_is_party` ends up scoped too.
  for (const [org, address, suffix] of [
    [PARTY_ORG, PARTY_ADDRESS, "holder"],
    [STRANGER_ORG, STRANGER_ADDRESS, "stranger"],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, provider, config_encrypted, status)
         VALUES (?, ?, 'local', 'x', 'active')
         ON CONFLICT (id) DO NOTHING`
      )
      .bind(`cust_dvp_party_${suffix}`, org)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')
         ON CONFLICT (id) DO NOTHING`
      )
      .bind(`cwlt_dvp_party_${suffix}`, `cust_dvp_party_${suffix}`, `w_${suffix}`, address)
      .run();
  }

  // The trade belongs to the agent's organization and names a party who does
  // not: exactly the shape PRO-1853 creates.
  await db
    .prepare(
      `INSERT INTO dvp_trades (
         id, organization_id, project_id, swap_dvp, settlement_authority,
         user_a, user_b, mint_a, mint_b, nonce, token_program_a, token_program_b,
         decimals_a, decimals_b, amount_a, amount_b, expiry_timestamp,
         user_a_settlement_destination, user_b_settlement_destination,
         escrow_a, escrow_b, sdp_side, trade_kind, sdp_wallet_id, status
       ) VALUES (?, ?, ?, 'BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po',
         '9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY', ?, ?,
         'ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1',
         'AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE',
         '42', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
         'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 6, 6, '1000', '2000',
         '1900000000', ?, ?, 'FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU',
         '6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y', NULL, 'agent',
         'cwlt_dvp_party_holder', 'created')
       ON CONFLICT (id) DO NOTHING`
    )
    .bind(
      TRADE_ID,
      AGENT_ORG,
      AGENT_PROJECT,
      OUTSIDE_ADDRESS,
      PARTY_ADDRESS,
      OUTSIDE_ADDRESS,
      PARTY_ADDRESS
    )
    .run();
}

function readTrade(): Promise<{ id: string } | null> {
  return getDb(env)
    .prepare("SELECT id FROM dvp_trades WHERE id = ?")
    .bind(TRADE_ID)
    .first<{ id: string }>();
}

describe("DvP party read across organizations (0089)", () => {
  beforeEach(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
    await seed();
  });

  it("lets an organization read a trade that names a wallet it holds", async () => {
    const row = await runWithTenantDatabaseIdentity({ organizationId: PARTY_ORG }, () =>
      readTrade()
    );

    expect(row?.id).toBe(TRADE_ID);
  });

  // The creating organization's own policy already covered this; asserting it
  // proves 0089 did not displace `sdp_tenant_isolation`, only add to it.
  it("still lets the organization that created it read it", async () => {
    const row = await runWithTenantDatabaseIdentity({ organizationId: AGENT_ORG }, () =>
      readTrade()
    );

    expect(row?.id).toBe(TRADE_ID);
  });

  // The whole hole in one assertion: holding A wallet is not enough, it has to
  // be a wallet this trade names.
  it("hides the trade from an organization it does not name", async () => {
    const row = await runWithTenantDatabaseIdentity({ organizationId: STRANGER_ORG }, () =>
      readTrade()
    );

    expect(row).toBeNull();
  });

  /**
   * Read only. 0089 is `FOR SELECT`, so a party gains sight of the row and no
   * power over it — which is why funding by a second party records its claim on
   * its own table rather than mutating this one.
   */
  it("does not let a party write to a trade another organization owns", async () => {
    await runWithTenantDatabaseIdentity({ organizationId: PARTY_ORG }, async () => {
      await getDb(env)
        .prepare("UPDATE dvp_trades SET status = 'cancelled' WHERE id = ?")
        .bind(TRADE_ID)
        .run();
    });

    const after = await runWithTenantDatabaseIdentity({ organizationId: AGENT_ORG }, () =>
      getDb(env)
        .prepare("SELECT status FROM dvp_trades WHERE id = ?")
        .bind(TRADE_ID)
        .first<{ status: string }>()
    );
    expect(after?.status).toBe("created");
  });

  it("fails closed with no identity at all", async () => {
    const row = await runWithoutDatabaseIdentity("test", () => readTrade());

    expect(row).toBeNull();
  });
});
