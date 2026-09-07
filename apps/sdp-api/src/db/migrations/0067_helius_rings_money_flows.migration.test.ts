import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";
import {
  CHECK_VIOLATION,
  expectSqlstate as expectSqlstateOn,
  seedOrgProject,
} from "@/test/helpers/migration-db";

let client: Client;

const expectSqlstate = (work: () => Promise<unknown>, sqlstate: string) =>
  expectSqlstateOn(client, work, sqlstate);

async function seedWallet(tag: string): Promise<{ walletId: string }> {
  const { organizationId, projectId } = await seedOrgProject(client, `0067_${tag}`);
  const walletId = `hrw_0067_${tag}`;
  await client.query(
    `INSERT INTO helius_rings_wallets (id, organization_id, project_id, sdp_wallet_id, name)
     VALUES ($1, $2, $3, $4, 'Treasury')`,
    [walletId, organizationId, projectId, `sdpw_0067_${tag}`]
  );

  return { walletId };
}

beforeAll(async () => {
  client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("BEGIN");
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0067_helius_rings_money_flows owner/identity pair", () => {
  it("accepts a wallet with both owner and shielded address, or neither", async () => {
    const { walletId } = await seedWallet("both");

    await expect(
      client.query(
        `UPDATE helius_rings_wallets
            SET shielded_address = 'shielded', owner_address = 'owner'
          WHERE id = $1`,
        [walletId]
      )
    ).resolves.toBeDefined();
  });

  it("rejects a shielded address without its owner, and the reverse", async () => {
    const { walletId } = await seedWallet("half");

    await expectSqlstate(
      () =>
        client.query(
          `UPDATE helius_rings_wallets SET shielded_address = 'shielded' WHERE id = $1`,
          [walletId]
        ),
      CHECK_VIOLATION
    );
    await expectSqlstate(
      () =>
        client.query(`UPDATE helius_rings_wallets SET owner_address = 'owner' WHERE id = $1`, [
          walletId,
        ]),
      CHECK_VIOLATION
    );
  });
});
