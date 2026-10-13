import type { SdpEnvironment } from "@sdp/types";
import type { Client } from "pg";
import { expect } from "vitest";

/** Postgres SQLSTATEs the migration tests distinguish between. */
export const NOT_NULL_VIOLATION = "23502";
export const UNIQUE_VIOLATION = "23505";
export const FK_VIOLATION = "23503";
export const CHECK_VIOLATION = "23514";

/**
 * Runs a statement expected to violate a constraint. The savepoint is taken
 * immediately before the statement — a failed statement poisons the whole
 * transaction, and rolling back to a savepoint created any earlier would
 * discard the fixtures the caller just seeded.
 *
 * Takes a thunk rather than a promise so the statement cannot be queued on the
 * client ahead of the SAVEPOINT.
 */
export async function expectSqlstate(
  client: Client,
  work: () => Promise<unknown>,
  sqlstate: string
): Promise<void> {
  await client.query("SAVEPOINT probe");
  await expect(work()).rejects.toMatchObject({ code: sqlstate });
  await client.query("ROLLBACK TO SAVEPOINT probe");
}

/**
 * Seeds an org, user and project, returning their ids. `tag` keeps the org
 * slug unique across tests since only the transaction is rolled back, not the
 * sequence of ids.
 */
export async function seedOrgProject(
  client: Client,
  tag: string
): Promise<{ organizationId: string; projectId: string; userId: string }> {
  const organizationId = `org_${tag}`;
  const projectId = `proj_${tag}`;
  const userId = `user_${tag}`;

  // Session-level, so a per-test ROLLBACK keeps it. Migration tests probe
  // constraints as the platform, and 0081's forced row-level security would
  // otherwise reject every seed insert.
  await client.query("SET app.tenant_isolation_identity = 'system'");
  await client.query("INSERT INTO organizations (id, name, slug) VALUES ($1, $1, $1)", [
    organizationId,
  ]);
  await client.query("INSERT INTO users (id, email) VALUES ($1, $2)", [
    userId,
    `${tag}@example.test`,
  ]);
  await client.query(
    `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
     VALUES
       ($1, $2, 'Default Sandbox Project', 'default-sandbox', 'sandbox', 'active', $3),
       ($4, $2, 'Default Production Project', 'default-production', 'production', 'active', $3)`,
    [projectId, organizationId, userId, `${projectId}_production`]
  );

  return { organizationId, projectId, userId };
}

/**
 * Seeds an active project-scoped credential stored in the database.
 *
 * @param client - Connection the seed runs on.
 * @param input - The credential to seed.
 * @param input.id - Credential id.
 * @param input.label - Credential label.
 * @param input.organizationId - Owning organization.
 * @param input.projectId - Project the credential is scoped to.
 * @param input.userId - User recorded as its creator.
 * @param input.provider - Provider the credential is for.
 * @returns Resolves once the row is inserted.
 */
export async function seedStoredProviderCredential(
  client: Client,
  input: {
    id: string;
    label: string;
    organizationId: string;
    projectId: string;
    userId: string;
    provider: string;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO provider_credentials (
       id, organization_id, project_id, provider, label, scope, source,
       storage_backend, encrypted_secret_payload, status, created_by
     ) VALUES ($1, $2, $3, $4, $5, 'project', 'stored',
               'encrypted_db', 'test-only', 'active', $6)`,
    [input.id, input.organizationId, input.projectId, input.provider, input.label, input.userId]
  );
}

/** Seeds the active project connection required by Helius Rings operations. */
export async function seedHeliusRingsConnection(
  client: Client,
  input: {
    organizationId: string;
    projectId: string;
    userId: string;
    tag: string;
  }
): Promise<string> {
  const credentialId = `pcred_hr_${input.tag}`;
  const connectionId = `hrconn_${input.tag}`;

  await seedStoredProviderCredential(client, {
    id: credentialId,
    label: input.tag,
    organizationId: input.organizationId,
    projectId: input.projectId,
    userId: input.userId,
    provider: "helius_rings",
  });
  await client.query(
    `INSERT INTO helius_rings_connections (
       id, organization_id, project_id, name, provider_credential_id,
       provider_credential_scope_key, status, is_default, activated_at, created_by
     ) VALUES ($1, $2, $3, $4, $5, $3, 'active', TRUE, sdp_iso_now(), $6)`,
    [connectionId, input.organizationId, input.projectId, input.tag, credentialId, input.userId]
  );

  return connectionId;
}

/**
 * Seeds a created DvP trade. A null environment omits the column, the shape
 * an image predating `dvp_trades.environment` writes.
 *
 * @param client - Connection the seed runs on.
 * @param trade - The trade to seed.
 * @param trade.id - Trade id, also suffixed into its `swap_dvp` address.
 * @param trade.organizationId - Owning organization.
 * @param trade.projectId - Project that created the trade.
 * @param trade.environment - Environment recorded on the trade, or null to omit it.
 * @returns Resolves once the row is inserted.
 */
export async function seedDvpTrade(
  client: Client,
  trade: {
    id: string;
    organizationId: string;
    projectId: string;
    environment: SdpEnvironment | null;
  }
): Promise<void> {
  const environmentColumn = trade.environment === null ? "" : ", environment";
  const environmentValue = trade.environment === null ? "" : ", $5";
  const environmentParams = trade.environment === null ? [] : [trade.environment];
  await client.query(
    `INSERT INTO dvp_trades (
       id, organization_id, project_id, swap_dvp, settlement_authority,
       user_a, user_b, mint_a, mint_b, nonce, token_program_a, token_program_b,
       amount_a, amount_b, expiry_timestamp,
       user_a_settlement_destination, user_b_settlement_destination,
       escrow_a, escrow_b, status${environmentColumn}
     ) VALUES (
       $1, $2, $3, $4, '9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY',
       '5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn',
       '7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg',
       'ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1',
       'AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE', '42',
       'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
       'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
       '1000', '2000', '1800003600',
       '5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn',
       '7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg',
       'FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU',
       '6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y',
       'created'${environmentValue}
     )`,
    [trade.id, trade.organizationId, trade.projectId, `swap_${trade.id}`, ...environmentParams]
  );
}
