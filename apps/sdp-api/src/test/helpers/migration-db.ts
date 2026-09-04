import type { Client } from "pg";
import { expect } from "vitest";

/** Postgres SQLSTATEs the migration tests distinguish between. */
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

  await client.query("INSERT INTO organizations (id, name, slug) VALUES ($1, $1, $1)", [
    organizationId,
  ]);
  await client.query("INSERT INTO users (id, email) VALUES ($1, $2)", [
    userId,
    `${tag}@example.test`,
  ]);
  await client.query(
    "INSERT INTO projects (id, organization_id, name, slug, created_by) VALUES ($1, $2, $1, $1, $3)",
    [projectId, organizationId, userId]
  );

  return { organizationId, projectId, userId };
}
