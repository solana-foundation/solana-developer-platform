import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";

const migration = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0130_recurring_wallet_roles_and_sponsorship.sql"
);

it("migrates exact plan roles independently of commission accounting and retains wallet relationships", async () => {
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA recurring_roles_test");
    await client.query("SET LOCAL search_path = recurring_roles_test");
    await client.query(`CREATE TABLE custody_wallets (id text PRIMARY KEY)`);
    await client.query(`CREATE TABLE payment_subscription_plans (
      id text PRIMARY KEY, owner_wallet_id text NOT NULL, owner_address text NOT NULL,
      puller_wallet_id text, puller_address text
    )`);
    await client.query(readFileSync(migration, "utf8"));
    const columns = await client.query(`SELECT attname FROM pg_attribute
      WHERE attrelid = 'recurring_roles_test.payment_subscription_plans'::regclass
      AND attname IN ('owner_custody_wallet_id','puller_custody_wallet_id','role_projection_revision')
      ORDER BY attname`);
    expect(columns.rows).toEqual([
      { attname: "owner_custody_wallet_id" },
      { attname: "puller_custody_wallet_id" },
      { attname: "role_projection_revision" },
    ]);
    await client.query("INSERT INTO custody_wallets VALUES ('wallet_a'), ('wallet_b')");
    await client.query(`INSERT INTO payment_subscription_plans
      (id,owner_wallet_id,owner_address,puller_wallet_id,puller_address,
       owner_custody_wallet_id,puller_custody_wallet_id,role_projection_revision)
      VALUES ('plan','shared','address','shared','address','wallet_a','wallet_a',1)`);
    // This is the preceding writer's actual projection-only PATCH shape.
    await client.query("SAVEPOINT legacy_patch");
    await expect(
      client.query(`UPDATE payment_subscription_plans SET
      puller_wallet_id = 'shared', puller_address = 'address' WHERE id = 'plan'`)
    ).rejects.toMatchObject({ code: "23514" });
    await client.query("ROLLBACK TO SAVEPOINT legacy_patch");
    await client.query("SAVEPOINT legacy_clear");
    await expect(
      client.query(`UPDATE payment_subscription_plans SET
      puller_wallet_id = NULL, puller_address = NULL WHERE id = 'plan'`)
    ).rejects.toMatchObject({ code: "23514" });
    await client.query("ROLLBACK TO SAVEPOINT legacy_clear");
    await client.query(`UPDATE payment_subscription_plans SET
      puller_custody_wallet_id = 'wallet_b', puller_wallet_id = 'shared',
      puller_address = 'address', role_projection_revision = role_projection_revision + 1
      WHERE id = 'plan'`);
    expect(
      (
        await client.query(`SELECT owner_custody_wallet_id,puller_custody_wallet_id,
      role_projection_revision FROM payment_subscription_plans WHERE id='plan'`)
      ).rows
    ).toEqual([
      {
        owner_custody_wallet_id: "wallet_a",
        puller_custody_wallet_id: "wallet_b",
        role_projection_revision: 2,
      },
    ]);
    await client.query("SAVEPOINT retained_wallet");
    await expect(
      client.query("DELETE FROM custody_wallets WHERE id='wallet_b'")
    ).rejects.toMatchObject({ code: "23503" });
    await client.query("ROLLBACK TO SAVEPOINT retained_wallet");
    await client.query(`UPDATE payment_subscription_plans SET
      puller_custody_wallet_id=NULL,puller_wallet_id=NULL,puller_address=NULL,
      role_projection_revision=role_projection_revision+1 WHERE id='plan'`);
    expect(
      (
        await client.query(`SELECT puller_custody_wallet_id,puller_wallet_id,puller_address
      FROM payment_subscription_plans WHERE id='plan'`)
      ).rows
    ).toEqual([{ puller_custody_wallet_id: null, puller_wallet_id: null, puller_address: null }]);
    await client.query(`INSERT INTO payment_subscription_plans(id,owner_wallet_id,owner_address)
      VALUES ('legacy','legacy','legacy_address')`);
    await client.query(`UPDATE payment_subscription_plans SET puller_wallet_id='legacy_puller',
      puller_address='legacy_address' WHERE id='legacy'`);
    await client.query(`INSERT INTO payment_subscription_plans
      (id,owner_wallet_id,owner_address,owner_custody_wallet_id)
      VALUES ('unfenced','shared','address','wallet_a')`);
    await client.query("SAVEPOINT unfenced_role");
    await expect(
      client.query(`UPDATE payment_subscription_plans SET
      puller_custody_wallet_id='wallet_b',puller_wallet_id='shared',puller_address='address',
      role_projection_revision=role_projection_revision+1 WHERE id='unfenced'`)
    ).rejects.toMatchObject({ code: "23514" });
    await client.query("ROLLBACK TO SAVEPOINT unfenced_role");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
