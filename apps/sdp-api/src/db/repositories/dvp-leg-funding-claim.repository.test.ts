/**
 * The funding lock for a leg funded by somebody other than the trade's author.
 *
 * Two properties carry the whole design, and both are what `dvp_trades`'
 * single-column claim could not give:
 *
 *   1. two parties funding OPPOSITE legs never contend, and
 *   2. two requests for the SAME leg do — exactly one wins.
 *
 * Getting (1) wrong tells a party its leg is already being funded when nothing
 * of the sort is happening. Getting (2) wrong broadcasts two transfers and
 * over-funds an escrow, which settlement refunds and which on a transfer-hook
 * mint can revert the settlement it was meant to complete.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { runWithTenantDatabaseIdentity } from "@/db/identity";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  createPostgresDvpLegFundingClaimRepository,
  type DvpLegFundingClaimRepository,
} from "./dvp-leg-funding-claim.repository";

const AGENT_ORG = "org_claim_agent";
const PARTY_A_ORG = "org_claim_party_a";
const PARTY_B_ORG = "org_claim_party_b";
const USER_ID = "usr_claim";
const TRADE_ID = "dvp_claim_trade";

const ADDRESS_A = "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC";
const ADDRESS_B = "C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk";

function walletId(org: string): string {
  return `cwlt_${org}`;
}

async function seed(): Promise<void> {
  const db = getDb(env);
  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified, status)
       VALUES (?, 'claim@example.com', 1, 'active') ON CONFLICT (id) DO NOTHING`
    )
    .bind(USER_ID)
    .run();

  for (const [org, address] of [
    [AGENT_ORG, null],
    [PARTY_A_ORG, ADDRESS_A],
    [PARTY_B_ORG, ADDRESS_B],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, ?, ?, 'individual', 'active') ON CONFLICT (id) DO NOTHING`
      )
      .bind(org, org, org)
      .run();
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'p', ?, 'sandbox', 'active', ?) ON CONFLICT (id) DO NOTHING`
      )
      .bind(`prj_${org}`, org, `prj_${org}`, USER_ID)
      .run();
    if (address === null) {
      continue;
    }
    await db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, provider, config_encrypted, status)
         VALUES (?, ?, 'local', 'x', 'active') ON CONFLICT (id) DO NOTHING`
      )
      .bind(`cust_${org}`, org)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active') ON CONFLICT (id) DO NOTHING`
      )
      .bind(walletId(org), `cust_${org}`, `w_${org}`, address)
      .run();
  }

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
         'AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE', '42',
         'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
         'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 6, 6, '1000', '2000',
         '1900000000', ?, ?, 'FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU',
         '6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y', NULL, 'agent',
         ?, 'created')
       ON CONFLICT (id) DO NOTHING`
    )
    .bind(
      TRADE_ID,
      AGENT_ORG,
      `prj_${AGENT_ORG}`,
      ADDRESS_A,
      ADDRESS_B,
      ADDRESS_A,
      ADDRESS_B,
      walletId(PARTY_A_ORG)
    )
    .run();
}

function claimInput(org: string, side: "a" | "b", signature: string) {
  return {
    tradeId: TRADE_ID,
    side,
    organizationId: org,
    projectId: `prj_${org}`,
    custodyWalletId: walletId(org),
    signature,
    expiryHeight: "1000",
  };
}

describe("DvpLegFundingClaimRepository", () => {
  let repo: DvpLegFundingClaimRepository;

  beforeEach(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
    await seed();
    repo = createPostgresDvpLegFundingClaimRepository(getDb(env));
  });

  // The reason the table exists. On the single-column claim these two would
  // have collided and one party would be told a leg it does not hold was busy.
  it("lets two parties claim opposite legs of the same trade", async () => {
    const first = await runWithTenantDatabaseIdentity({ organizationId: PARTY_A_ORG }, () =>
      repo.claim(claimInput(PARTY_A_ORG, "a", "sig_a"))
    );
    const second = await runWithTenantDatabaseIdentity({ organizationId: PARTY_B_ORG }, () =>
      repo.claim(claimInput(PARTY_B_ORG, "b", "sig_b"))
    );

    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  it("admits exactly one claim on the same leg", async () => {
    const first = await runWithTenantDatabaseIdentity({ organizationId: PARTY_A_ORG }, () =>
      repo.claim(claimInput(PARTY_A_ORG, "a", "sig_first"))
    );
    const second = await runWithTenantDatabaseIdentity({ organizationId: PARTY_A_ORG }, () =>
      repo.claim(claimInput(PARTY_A_ORG, "a", "sig_second"))
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("frees the leg once a rejected broadcast releases its claim", async () => {
    await runWithTenantDatabaseIdentity({ organizationId: PARTY_A_ORG }, async () => {
      await repo.claim(claimInput(PARTY_A_ORG, "a", "sig_first"));
      await repo.release(TRADE_ID, "a", "sig_first");
    });

    const retried = await runWithTenantDatabaseIdentity({ organizationId: PARTY_A_ORG }, () =>
      repo.claim(claimInput(PARTY_A_ORG, "a", "sig_retry"))
    );
    expect(retried).toBe(true);
  });

  // A release names the signature it took, so a slow request cannot free a
  // newer claim taken after its own was swept.
  it("refuses to release a claim it does not own", async () => {
    await runWithTenantDatabaseIdentity({ organizationId: PARTY_A_ORG }, async () => {
      await repo.claim(claimInput(PARTY_A_ORG, "a", "sig_live"));
      await repo.release(TRADE_ID, "a", "sig_stale");
    });

    const blocked = await runWithTenantDatabaseIdentity({ organizationId: PARTY_A_ORG }, () =>
      repo.claim(claimInput(PARTY_A_ORG, "a", "sig_other"))
    );
    expect(blocked).toBe(false);
  });

  // Once the transfer is on the wire the row is a receipt, and releasing it
  // would invite a second transfer on top of one that may yet land.
  it("keeps a claim whose transfer was broadcast", async () => {
    await runWithTenantDatabaseIdentity({ organizationId: PARTY_A_ORG }, async () => {
      await repo.claim(claimInput(PARTY_A_ORG, "a", "sig_sent"));
      await repo.recordFundingTx(TRADE_ID, "a", "sig_sent");
      await repo.release(TRADE_ID, "a", "sig_sent");
    });

    const blocked = await runWithTenantDatabaseIdentity({ organizationId: PARTY_A_ORG }, () =>
      repo.claim(claimInput(PARTY_A_ORG, "a", "sig_again"))
    );
    expect(blocked).toBe(false);
  });

  /**
   * The row belongs to the funder, so ordinary tenant isolation applies and
   * nothing about this table crosses an organization. That is what lets the
   * cross-org read in 0089 stay read-only.
   */
  it("hides one party's claim from the other", async () => {
    await runWithTenantDatabaseIdentity({ organizationId: PARTY_A_ORG }, () =>
      repo.claim(claimInput(PARTY_A_ORG, "a", "sig_a"))
    );

    const seenByOther = await runWithTenantDatabaseIdentity({ organizationId: PARTY_B_ORG }, () =>
      repo.listForTrade(TRADE_ID)
    );
    const seenByOwner = await runWithTenantDatabaseIdentity({ organizationId: PARTY_A_ORG }, () =>
      repo.listForTrade(TRADE_ID)
    );

    expect(seenByOther).toHaveLength(0);
    expect(seenByOwner).toHaveLength(1);
  });
});
