import type { Client } from "pg";
import { expect } from "vitest";

/** Postgres SQLSTATEs the migration tests distinguish between. */
export const NOT_NULL_VIOLATION = "23502";
export const UNIQUE_VIOLATION = "23505";
export const FK_VIOLATION = "23503";
export const CHECK_VIOLATION = "23514";
export const RAISE_EXCEPTION = "P0001";

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

/**
 * Seeds an individual counterparty. A NULL project is only insertable while a
 * test has rewound the schema to before 0129.
 *
 * @param client - Connection the seed runs on.
 * @param counterparty - The counterparty to seed.
 * @param counterparty.id - Counterparty id, also used as its display name.
 * @param counterparty.organizationId - Owning organization.
 * @param counterparty.projectId - Owning project, or NULL on a pre-0129 schema.
 * @returns Resolves once the row is inserted.
 */
export async function seedCounterparty(
  client: Client,
  counterparty: { id: string; organizationId: string; projectId: string | null }
): Promise<void> {
  await client.query(
    `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name)
     VALUES ($1, $2, $3, 'individual', $1)`,
    [counterparty.id, counterparty.organizationId, counterparty.projectId]
  );
}

/**
 * Seeds an active customer-link provider account. The organization and
 * project are taken as given, so a test can seed one that disagrees with its
 * counterparty's.
 *
 * @param client - Connection the seed runs on.
 * @param link - The provider account to seed.
 * @param link.id - Provider account id, also used as its provider customer reference.
 * @param link.organizationId - Organization recorded on the provider account.
 * @param link.projectId - Project recorded on the provider account.
 * @param link.counterpartyId - Counterparty the provider account belongs to.
 * @returns Resolves once the row is inserted.
 */
export async function seedCustomerLink(
  client: Client,
  link: { id: string; organizationId: string; projectId: string; counterpartyId: string }
): Promise<void> {
  await client.query(
    `INSERT INTO counterparty_provider_accounts (
       id, organization_id, project_id, counterparty_id, provider,
       provider_customer_reference, kind, status
     ) VALUES ($1, $2, $3, $4, 'moonpay', $1, 'customer_link', 'active')`,
    [link.id, link.organizationId, link.projectId, link.counterpartyId]
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
