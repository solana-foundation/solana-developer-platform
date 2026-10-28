import { hashString } from "@sdp/payments/hash";
import type { Action } from "@sdp/types/actions";
import type { DatabaseClient } from "@/db/client";
import type { Env } from "@/types/env";

export interface TestApiKeyMaterial {
  id: string;
  raw: string;
  prefix: string;
}

export interface SeedProjectApiKeyInput {
  key: TestApiKeyMaterial;
  organizationId: string;
  projectId: string;
  createdBy: string;
  grants: readonly Action[];
}

/**
 * Seed an active API key bound to one project, hashed the way auth will look it up.
 *
 * @param db - Test database client.
 * @param env - Test environment; supplies the hashing pepper.
 * @param input - Key material and the project it belongs to.
 * @param input.key - Id, raw secret and display prefix of the key.
 * @param input.organizationId - Organization that owns the key.
 * @param input.projectId - Project the key is bound to.
 * @param input.createdBy - User recorded as the creator.
 * @param input.grants - The key's grants.
 * @returns The key hash auth resolves the raw secret to.
 */
export async function seedProjectApiKey(
  db: DatabaseClient,
  env: Env,
  input: SeedProjectApiKeyInput
): Promise<string> {
  const keyHash = await hashString(input.key.raw, env.API_KEY_PEPPER);
  await db
    .prepare(
      `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, grants, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
       ON CONFLICT (id) DO NOTHING`
    )
    .bind(
      input.key.id,
      input.organizationId,
      input.projectId,
      input.createdBy,
      input.key.id,
      input.key.prefix,
      keyHash,
      [...input.grants]
    )
    .run();
  return keyHash;
}

/**
 * Seed an active API key row that cannot authenticate, rotated from `rotatedFrom`: one link of the
 * rotation lineage the payment list filters walk.
 *
 * @param db - Test database client.
 * @param key - The key row.
 * @param key.id - The key id.
 * @param key.organizationId - Organization that owns the key.
 * @param key.projectId - Project the key is bound to.
 * @param key.createdBy - User recorded as the creator.
 * @param key.rotatedFrom - The key it was rotated from, or null for the first key of a lineage.
 * @returns Resolves once the row is seeded.
 */
export async function seedRotatedApiKeyRow(
  db: DatabaseClient,
  key: {
    id: string;
    organizationId: string;
    projectId: string;
    createdBy: string;
    rotatedFrom: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, grants, status,
          rotated_from)
       VALUES (?, ?, ?, ?, ?, 'sk_test_rot', ?, '{}', 'active', ?)`
    )
    .bind(
      key.id,
      key.organizationId,
      key.projectId,
      key.createdBy,
      key.id,
      `hash_${key.id}`,
      key.rotatedFrom
    )
    .run();
}
