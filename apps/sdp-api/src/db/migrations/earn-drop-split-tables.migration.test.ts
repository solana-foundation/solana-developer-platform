import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0068_earn_drop_split_movement_tables.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");

let client: Client;

async function createContractFixture(): Promise<void> {
  await client.query(`
    CREATE TEMP TABLE earn_positions (
      id TEXT,
      organization_id TEXT,
      project_id TEXT,
      environment TEXT,
      provider TEXT,
      kind TEXT,
      custody_wallet_id TEXT,
      vault_address TEXT,
      share_mint TEXT,
      token_mint TEXT,
      provider_wallet_id TEXT,
      label TEXT,
      created_by TEXT,
      created_at TEXT,
      updated_at TEXT,
      activated_at TEXT,
      closed_at TEXT
    );

    CREATE TEMP TABLE earn_movements (
      id TEXT,
      organization_id TEXT,
      project_id TEXT,
      environment TEXT,
      provider TEXT,
      execution_model TEXT,
      direction TEXT,
      position_id TEXT,
      status TEXT,
      failure_reason TEXT,
      confirmed_at TEXT,
      settled_at TEXT,
      denomination TEXT,
      amount_requested TEXT,
      amount_settled TEXT,
      fee_amount TEXT,
      payout_token TEXT,
      min_shares_out TEXT,
      shares_out TEXT,
      custody_wallet_id TEXT,
      vault_address TEXT,
      source_address TEXT,
      destination_address TEXT,
      provider_reference TEXT,
      signature TEXT,
      signed_transaction TEXT,
      last_valid_block_height NUMERIC,
      request_id TEXT,
      idempotency_fingerprint TEXT,
      provider_data JSONB,
      created_by TEXT,
      initiated_by_key_id TEXT,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TEMP TABLE projected_provider_positions AS
      SELECT provider_wallet_id, organization_id, project_id, environment, provider, kind,
             label, created_by, created_at, updated_at, activated_at
        FROM earn_positions WITH NO DATA;
    CREATE TEMP VIEW earn_projected_position_from_provider_wallet AS
      SELECT * FROM projected_provider_positions;

    CREATE TEMP TABLE projected_vault_positions AS
      SELECT id, organization_id, project_id, environment, provider, kind,
             custody_wallet_id, vault_address, share_mint, token_mint, label,
             created_by, created_at, updated_at, activated_at, closed_at
        FROM earn_positions WITH NO DATA;
    CREATE TEMP VIEW earn_projected_position_from_vault_position AS
      SELECT * FROM projected_vault_positions;

    CREATE TEMP TABLE projected_withdrawals AS
      SELECT id, organization_id, project_id, environment, provider, execution_model,
             direction, position_id, status, failure_reason, settled_at, denomination,
             amount_requested, amount_settled, fee_amount, payout_token,
             destination_address, provider_reference, request_id, idempotency_fingerprint,
             provider_data, created_by, initiated_by_key_id, created_at, updated_at
        FROM earn_movements WITH NO DATA;
    CREATE TEMP VIEW earn_projected_movement_from_withdrawal AS
      SELECT * FROM projected_withdrawals;

    CREATE TEMP TABLE projected_vault_movements AS
      SELECT id, organization_id, project_id, environment, provider, execution_model,
             direction, position_id, status, failure_reason, confirmed_at, denomination,
             amount_requested, amount_settled, min_shares_out, shares_out,
             custody_wallet_id, vault_address, source_address, destination_address,
             signature, signed_transaction, last_valid_block_height, request_id,
             idempotency_fingerprint, created_by, initiated_by_key_id, created_at, updated_at
        FROM earn_movements WITH NO DATA;
    CREATE TEMP VIEW earn_projected_movement_from_vault_movement AS
      SELECT * FROM projected_vault_movements;

    CREATE TEMP TABLE earn_vault_movements (id TEXT);
    CREATE TEMP TABLE earn_vault_positions (id TEXT);
    CREATE TEMP TABLE earn_program_withdrawals (id TEXT);
  `);
}

async function seedProviderPosition(): Promise<void> {
  await client.query(`
    INSERT INTO earn_positions (
      id, organization_id, project_id, environment, provider, kind,
      provider_wallet_id, label, created_by, created_at, updated_at, activated_at
    ) VALUES (
      'position_provider', 'org_contract', 'project_contract', 'production', 'ground',
      'custodial', 'provider_wallet_contract', 'Treasury', 'user_contract',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO projected_provider_positions
      SELECT provider_wallet_id, organization_id, project_id, environment, provider, kind,
             label, created_by, created_at, updated_at, activated_at
        FROM earn_positions
       WHERE id = 'position_provider';
  `);
}

async function seedCustodialMovement(): Promise<void> {
  await client.query(`
    INSERT INTO earn_movements (
      id, organization_id, project_id, environment, provider, execution_model,
      direction, position_id, status, settled_at, denomination, amount_requested,
      amount_settled, fee_amount, payout_token, destination_address, provider_reference,
      request_id, idempotency_fingerprint, provider_data, created_by, initiated_by_key_id,
      created_at, updated_at
    ) VALUES (
      'movement_custodial', 'org_contract', 'project_contract', 'production', 'ground',
      'custodial', 'withdrawal', 'position_provider', 'completed',
      '2026-01-02T00:00:00.000Z', 'usd', '100', '99', '1', 'usdc',
      'destination_contract', 'provider_reference_contract', 'request_contract',
      'fingerprint_contract', '{"result":"complete"}', 'user_contract', 'key_contract',
      '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
    );
    INSERT INTO projected_withdrawals
      SELECT id, organization_id, project_id, environment, provider, execution_model,
             direction, position_id, status, failure_reason, settled_at, denomination,
             amount_requested, amount_settled, fee_amount, payout_token,
             destination_address, provider_reference, request_id, idempotency_fingerprint,
             provider_data, created_by, initiated_by_key_id, created_at, updated_at
        FROM earn_movements
       WHERE id = 'movement_custodial';
  `);
}

async function seedFinalizedVaultMovement(): Promise<void> {
  await client.query(`
    INSERT INTO earn_movements (
      id, organization_id, project_id, environment, provider, execution_model,
      direction, position_id, status, confirmed_at, settled_at, denomination,
      amount_requested, amount_settled, min_shares_out, shares_out, custody_wallet_id,
      vault_address, source_address, destination_address, signature, signed_transaction,
      last_valid_block_height, request_id, idempotency_fingerprint, created_by,
      initiated_by_key_id, created_at, updated_at
    ) VALUES (
      'movement_vault', 'org_contract', 'project_contract', 'production', 'kamino',
      'vault_direct', 'deposit', 'position_vault', 'finalized',
      '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z', 'mint_contract',
      '100', '100', '99', '99.5', 'custody_wallet_contract', 'vault_contract',
      'source_contract', 'vault_contract', 'signature_contract', 'bytes_contract', 123,
      'request_vault', 'fingerprint_vault', 'user_contract', 'key_contract',
      '2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z'
    );
    INSERT INTO projected_vault_movements
      SELECT id, organization_id, project_id, environment, provider, execution_model,
             direction, position_id, 'confirmed', failure_reason, confirmed_at, denomination,
             amount_requested, amount_settled, min_shares_out, shares_out,
             custody_wallet_id, vault_address, source_address, destination_address,
             signature, signed_transaction, last_valid_block_height, request_id,
             idempotency_fingerprint, created_by, initiated_by_key_id, created_at,
             '2026-01-02T00:00:00.000Z'
        FROM earn_movements
       WHERE id = 'movement_vault';
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
  await createContractFixture();
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0068 Earn split-table contract gate", () => {
  it("blocks the irreversible drop when a legacy holding has no unified projection", async () => {
    await seedProviderPosition();
    await client.query("DELETE FROM earn_positions WHERE id = 'position_provider'");

    await expect(client.query(migrationSql)).rejects.toThrow(
      "a legacy provider wallet is missing or malformed in earn_positions"
    );
  });

  it("blocks the irreversible drop when a terminal legacy outcome would be lost", async () => {
    await seedProviderPosition();
    await seedCustodialMovement();
    await client.query(
      "UPDATE earn_movements SET amount_settled = '98' WHERE id = 'movement_custodial'"
    );

    await expect(client.query(migrationSql)).rejects.toThrow(
      "a legacy custodial movement is missing or malformed in earn_movements"
    );
  });

  it("allows the unified lifecycle to advance, then drops the verified legacy shape", async () => {
    await seedFinalizedVaultMovement();

    await expect(client.query(migrationSql)).resolves.toBeDefined();
    const remaining = await client.query<{ relation: string | null }>(
      "SELECT to_regclass('pg_temp.earn_vault_movements')::text AS relation"
    );
    expect(remaining.rows[0]?.relation).toBeNull();
  });
});
