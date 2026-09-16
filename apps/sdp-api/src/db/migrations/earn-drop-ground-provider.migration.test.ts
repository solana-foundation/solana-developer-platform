import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0099_drop_ground_earn_provider.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");

let client: Client;

/**
 * Minimal temp-table stand-ins shaped like the live earn tables (the columns
 * the migration's deletes can touch), with the live FK graph recreated so the
 * migration's child-before-parent delete order is actually exercised: deleting
 * wallets before positions, or strategies before their dependents, fails here
 * exactly as it would on the migrated schema. The open-TEXT provider columns
 * are kept faithful to the live tables (ADR 0001/0002).
 */
async function createFixture(): Promise<void> {
  await client.query(`
    CREATE TEMP TABLE earn_strategies (id TEXT PRIMARY KEY, provider TEXT);
    CREATE TEMP TABLE earn_provider_wallets (id TEXT PRIMARY KEY, provider TEXT);
    CREATE TEMP TABLE earn_positions (
      id TEXT PRIMARY KEY, provider TEXT, provider_wallet_id TEXT, strategy_id TEXT,
      FOREIGN KEY (provider_wallet_id) REFERENCES earn_provider_wallets(id),
      FOREIGN KEY (strategy_id) REFERENCES earn_strategies(id)
    );
    CREATE TEMP TABLE earn_movements (
      id TEXT PRIMARY KEY, provider TEXT, position_id TEXT,
      FOREIGN KEY (position_id) REFERENCES earn_positions(id)
    );
  `);
}

async function seedGroundAndNeighbors(): Promise<void> {
  await client.query(`
    INSERT INTO earn_strategies (id, provider) VALUES
      ('strategy_ground_1', 'ground'),
      ('strategy_ground_2', 'ground'),
      ('strategy_kamino', 'kamino');

    INSERT INTO earn_provider_wallets (id, provider) VALUES
      ('wallet_ground_1', 'ground'),
      ('wallet_kamino', 'kamino');

    INSERT INTO earn_positions (id, provider, provider_wallet_id, strategy_id) VALUES
      ('position_ground_1', 'ground', 'wallet_ground_1', 'strategy_ground_1'),
      ('position_kamino', 'kamino', 'wallet_kamino', 'strategy_kamino');

    INSERT INTO earn_movements (id, provider, position_id) VALUES
      ('movement_ground_1', 'ground', 'position_ground_1'),
      ('movement_ground_2', 'ground', 'position_ground_1'),
      ('movement_kamino', 'kamino', 'position_kamino');
  `);
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
  await createFixture();
  await seedGroundAndNeighbors();
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0099 drop Ground earn provider", () => {
  it("deletes every Ground row and leaves every other provider's rows alone", async () => {
    await client.query(migrationSql);

    const strategies = await client.query<{ provider: string }>(
      "SELECT provider FROM earn_strategies ORDER BY provider"
    );
    expect(strategies.rows).toEqual([{ provider: "kamino" }]);

    const wallets = await client.query<{ provider: string }>(
      "SELECT provider FROM earn_provider_wallets ORDER BY provider"
    );
    expect(wallets.rows).toEqual([{ provider: "kamino" }]);

    const positions = await client.query<{ id: string }>(
      "SELECT id FROM earn_positions ORDER BY id"
    );
    expect(positions.rows).toEqual([{ id: "position_kamino" }]);

    const movements = await client.query<{ id: string }>(
      "SELECT id FROM earn_movements ORDER BY id"
    );
    expect(movements.rows).toEqual([{ id: "movement_kamino" }]);
  });

  it("rejects out-of-order parent deletes via the recreated FK graph", async () => {
    // Deleting a wallet that a live position still references must fail, or
    // the delete-order coverage above would be vacuous.
    await expect(
      client.query("DELETE FROM earn_provider_wallets WHERE provider = 'ground'")
    ).rejects.toThrow(/violates foreign key/i);
  });

  it("is a no-op when no Ground rows exist", async () => {
    await client.query("DELETE FROM earn_movements WHERE provider = 'ground'");
    await client.query("DELETE FROM earn_positions WHERE provider = 'ground'");
    await client.query("DELETE FROM earn_provider_wallets WHERE provider = 'ground'");
    await client.query("DELETE FROM earn_strategies WHERE provider = 'ground'");

    await expect(client.query(migrationSql)).resolves.toBeDefined();

    const totals = await client.query<{ count: number }>(
      "SELECT (SELECT count(*) FROM earn_strategies) + (SELECT count(*) FROM earn_provider_wallets) + (SELECT count(*) FROM earn_positions) + (SELECT count(*) FROM earn_movements) AS count"
    );
    // One kamino row in each of the four tables.
    expect(totals.rows[0]?.count).toBe(4);
  });
});
