/**
 * The escrow transfer ledger under real row-level security (0111).
 *
 * The reconciler writes it as a system workload. Whoever can read the trade can
 * read its transfers: the creating organization and a party named on it. A
 * stranger reads nothing, and no tenant request can write a transfer or move a
 * leg's read position.
 */

import { address, getBase58Decoder, type Signature, signature } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { runWithTenantDatabaseIdentity } from "@/db/identity";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  createPostgresDvpLegTransferRepository,
  type DvpLegTransferRepository,
  type NewDvpLegTransfer,
} from "./dvp-leg-transfer.repository";

const CREATOR_ORG = "org_ledger_creator";
const PARTY_ORG = "org_ledger_party";
const STRANGER_ORG = "org_ledger_stranger";
const USER_ID = "usr_ledger";
const TRADE_ID = "dvp_ledger_trade";
const OTHER_TRADE_ID = "dvp_ledger_other";

const PARTY_ADDRESS = "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC";
const OTHER_ADDRESS = "C8gNHiN7huZr5g6foxuPZqPh2kbQHiGQUDkhcnL7CFzk";

function sig(n: number): Signature {
  const bytes = new Uint8Array(64);
  new DataView(bytes.buffer).setUint32(0, n + 1);
  bytes[63] = 9;
  return signature(getBase58Decoder().decode(bytes));
}

function transfer(overrides: Partial<NewDvpLegTransfer> = {}): NewDvpLegTransfer {
  return {
    tradeId: TRADE_ID,
    side: "a",
    signature: sig(1),
    direction: "in",
    amount: "1000",
    slot: "420",
    blockTime: "1789000000",
    feePayer: address(PARTY_ADDRESS),
    finalized: true,
    ...overrides,
  };
}

async function insertTrade(id: string, swapDvp: string): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO dvp_trades (
         id, organization_id, project_id, swap_dvp, settlement_authority,
         user_a, user_b, mint_a, mint_b, nonce, token_program_a, token_program_b,
         decimals_a, decimals_b, amount_a, amount_b, expiry_timestamp,
         user_a_settlement_destination, user_b_settlement_destination,
         escrow_a, escrow_b, status
       ) VALUES (?, ?, ?, ?,
         '9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY', ?, ?,
         'ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1',
         'AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE', '42',
         'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
         'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 6, 6, '1000', '2000',
         '1900000000', ?, ?, 'FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU',
         '6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y', 'created')
       ON CONFLICT (id) DO NOTHING`
    )
    .bind(
      id,
      CREATOR_ORG,
      `prj_${CREATOR_ORG}`,
      swapDvp,
      PARTY_ADDRESS,
      OTHER_ADDRESS,
      PARTY_ADDRESS,
      OTHER_ADDRESS
    )
    .run();
}

async function seed(): Promise<void> {
  const db = getDb(env);
  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified, status)
       VALUES (?, 'ledger@example.com', 1, 'active') ON CONFLICT (id) DO NOTHING`
    )
    .bind(USER_ID)
    .run();
  for (const org of [CREATOR_ORG, PARTY_ORG, STRANGER_ORG]) {
    await db
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, ?, ?, 'individual', 'active') ON CONFLICT (id) DO NOTHING`
      )
      .bind(org, org, org)
      .run();
    await seedDefaultProjects(db, {
      organizationId: org,
      createdBy: USER_ID,
      members: [],
      ids: { sandbox: `prj_${org}`, production: `prj_${org}_production` },
    });
  }
  // The party holds side A's address in a custody wallet of its own; that is
  // what makes it a party (0089).
  await db
    .prepare(
      `INSERT INTO custody_configs (id, organization_id, provider, config_encrypted, status)
       VALUES (?, ?, 'local', 'x', 'active') ON CONFLICT (id) DO NOTHING`
    )
    .bind(`cust_${PARTY_ORG}`, PARTY_ORG)
    .run();
  await db
    .prepare(
      `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
       VALUES (?, ?, ?, ?, 'active') ON CONFLICT (id) DO NOTHING`
    )
    .bind(`cwlt_${PARTY_ORG}`, `cust_${PARTY_ORG}`, `w_${PARTY_ORG}`, PARTY_ADDRESS)
    .run();
  await insertTrade(TRADE_ID, "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po");
  await insertTrade(OTHER_TRADE_ID, "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU");
}

describe("DvpLegTransferRepository", () => {
  let repo: DvpLegTransferRepository;

  beforeEach(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
    await seed();
    repo = createPostgresDvpLegTransferRepository(getDb(env));
  });

  // Re-reading an escrow's history must never duplicate a movement.
  it("records a transaction once per leg however often it is read", async () => {
    await repo.record(transfer());
    await repo.record(transfer());
    await repo.record(transfer({ side: "b" }));

    const listed = (await repo.listForTrades([TRADE_ID])).get(TRADE_ID);

    expect(listed?.a).toEqual([transfer()]);
    expect(listed?.b).toEqual([transfer({ side: "b" })]);
  });

  it("lists each trade's legs oldest first, and an empty pair for a trade with none", async () => {
    await repo.record(transfer({ signature: sig(2), slot: "1000", direction: "out" }));
    await repo.record(transfer({ signature: sig(3), slot: "999" }));

    const listed = await repo.listForTrades([TRADE_ID, OTHER_TRADE_ID]);

    expect(listed.get(TRADE_ID)?.a.map((entry) => entry.slot)).toEqual(["999", "1000"]);
    expect(listed.get(OTHER_TRADE_ID)).toEqual({ a: [], b: [] });
  });

  describe("under a tenant identity", () => {
    beforeEach(async () => {
      await repo.record(transfer());
    });

    it.each([
      ["the creating organization", CREATOR_ORG],
      ["a party named on the trade", PARTY_ORG],
    ])("lets %s read the trade's transfers", async (_label, organizationId) => {
      const listed = await runWithTenantDatabaseIdentity({ organizationId }, () =>
        repo.listForTrades([TRADE_ID])
      );

      expect(listed.get(TRADE_ID)?.a).toHaveLength(1);
    });

    it("shows an organization that cannot read the trade nothing", async () => {
      const listed = await runWithTenantDatabaseIdentity({ organizationId: STRANGER_ORG }, () =>
        repo.listForTrades([TRADE_ID])
      );

      expect(listed.get(TRADE_ID)).toEqual({ a: [], b: [] });
    });

    it("refuses a transfer written by any tenant, even the trade's own organization", async () => {
      await expect(
        runWithTenantDatabaseIdentity({ organizationId: CREATOR_ORG }, () =>
          repo.record(transfer({ signature: sig(5) }))
        )
      ).rejects.toThrow(/row-level security/);
    });

    it("keeps the read position out of every tenant's reach", async () => {
      await repo.saveScan(TRADE_ID, {
        side: "a",
        cursor: { signature: sig(1), slot: "420" },
        scannedAt: null,
      });

      const seen = await runWithTenantDatabaseIdentity({ organizationId: CREATOR_ORG }, () =>
        repo.listScans(TRADE_ID)
      );
      await expect(
        runWithTenantDatabaseIdentity({ organizationId: CREATOR_ORG }, () =>
          repo.saveScan(TRADE_ID, { side: "b", cursor: null, scannedAt: null })
        )
      ).rejects.toThrow(/row-level security/);

      expect(seen).toEqual([]);
    });
  });

  it("moves a leg's read position forward in place", async () => {
    await repo.saveScan(TRADE_ID, { side: "a", cursor: null, scannedAt: null });
    await repo.saveScan(TRADE_ID, {
      side: "a",
      cursor: { signature: sig(7), slot: "700" },
      scannedAt: "2026-09-15T00:00:00.000Z",
    });

    expect(await repo.listScans(TRADE_ID)).toEqual([
      {
        side: "a",
        cursor: { signature: sig(7), slot: "700" },
        scannedAt: "2026-09-15T00:00:00.000Z",
      },
    ]);
  });

  // Two sweeps can overlap. The slower one, working from an older read, must
  // not drag the position back behind what the faster one already passed.
  it("never moves a leg's read position back to an earlier slot", async () => {
    await repo.saveScan(TRADE_ID, {
      side: "a",
      cursor: { signature: sig(9), slot: "900" },
      scannedAt: null,
    });
    await repo.saveScan(TRADE_ID, {
      side: "a",
      cursor: { signature: sig(8), slot: "899" },
      scannedAt: "2026-09-15T00:00:00.000Z",
    });
    await repo.saveScan(TRADE_ID, { side: "b", cursor: null, scannedAt: null });
    await repo.saveScan(TRADE_ID, {
      side: "b",
      cursor: { signature: sig(3), slot: "300" },
      scannedAt: null,
    });
    await repo.saveScan(TRADE_ID, { side: "b", cursor: null, scannedAt: null });

    const scans = await repo.listScans(TRADE_ID);

    expect(scans.find((scan) => scan.side === "a")).toEqual({
      side: "a",
      cursor: { signature: sig(9), slot: "900" },
      scannedAt: "2026-09-15T00:00:00.000Z",
    });
    expect(scans.find((scan) => scan.side === "b")?.cursor).toEqual({
      signature: sig(3),
      slot: "300",
    });
  });

  describe("provisional transfers", () => {
    // The reconciler walks an escrow's history oldest first, so the order rows
    // are recorded in IS the chain's order.
    it("lists one leg in the order its history was walked, with each row's finality", async () => {
      await repo.record(transfer({ signature: sig(1), slot: "400" }));
      await repo.record(transfer({ signature: sig(2), slot: "500", finalized: false }));
      await repo.record(transfer({ side: "b", signature: sig(3) }));

      const listed = await repo.listForLeg(TRADE_ID, "a");

      expect(listed.map((row) => [row.signature, row.finalized])).toEqual([
        [sig(1), true],
        [sig(2), false],
      ]);
    });

    // A slot can hold both a deposit and the reclaim that emptied it, and it
    // carries no order of its own. Ordering by slot alone would let the leg
    // read as funded when the escrow is empty, or the reverse.
    it("keeps two transfers in one slot in the order they were walked", async () => {
      await repo.record(transfer({ signature: sig(4), slot: "700", direction: "in" }));
      await repo.record(transfer({ signature: sig(5), slot: "700", direction: "out" }));

      const listed = await repo.listForLeg(TRADE_ID, "a");

      expect(listed.map((row) => [row.signature, row.direction])).toEqual([
        [sig(4), "in"],
        [sig(5), "out"],
      ]);
    });

    // A later read of the same transaction at a weaker commitment must not
    // turn a finalized row provisional again, which would expose it to deletion.
    it("only ever moves a row from provisional to finalized", async () => {
      await repo.record(transfer({ finalized: false }));
      await repo.record(transfer({ finalized: true }));
      await repo.record(transfer({ finalized: false }));
      await repo.record(transfer({ signature: sig(2), finalized: false }));
      await repo.markFinalized(TRADE_ID, "a", sig(2));

      const listed = await repo.listForLeg(TRADE_ID, "a");

      expect(listed.map((row) => row.finalized)).toEqual([true, true]);
    });

    it("deletes a provisional row and never a finalized one", async () => {
      await repo.record(transfer({ signature: sig(1), finalized: true }));
      await repo.record(transfer({ signature: sig(2), finalized: false }));

      await repo.deleteProvisional(TRADE_ID, "a", sig(1));
      await repo.deleteProvisional(TRADE_ID, "a", sig(2));

      expect((await repo.listForLeg(TRADE_ID, "a")).map((row) => row.signature)).toEqual([sig(1)]);
    });

    it("refuses a tenant deleting or finalizing a transfer", async () => {
      await repo.record(transfer({ finalized: false }));

      await runWithTenantDatabaseIdentity({ organizationId: CREATOR_ORG }, async () => {
        await repo.deleteProvisional(TRADE_ID, "a", sig(1));
        await repo.markFinalized(TRADE_ID, "a", sig(1));
      });

      // Row-level security matches nothing for the tenant, so both writes are
      // no-ops rather than errors; the row is exactly as the system wrote it.
      expect(await repo.listForLeg(TRADE_ID, "a")).toEqual([transfer({ finalized: false })]);
    });
  });
});
