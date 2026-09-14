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
 * the migration's deletes can touch). No FK wiring: the migration's delete
 * order is exercised by running it as-is and checking what survived, which
 * also keeps the fixture honest about the open-TEXT provider columns.
 */
async function createFixture(): Promise<void> {
  await client.query(`
    CREATE TEMP TABLE earn_strategies (id TEXT, provider TEXT);
    CREATE TEMP TABLE earn_provider_wallets (id TEXT, provider TEXT);
    CREATE TEMP TABLE earn_positions (id TEXT, provider TEXT, provider_wallet_id TEXT);
    CREATE TEMP TABLE earn_movements (id TEXT, provider TEXT, position_id TEXT);
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

    INSERT INTO earn_positions (id, provider, provider_wallet_id) VALUES
      ('position_ground_1', 'ground', 'wallet_ground_1'),
      ('position_kamino', 'kamino', 'wallet_kamino');

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
