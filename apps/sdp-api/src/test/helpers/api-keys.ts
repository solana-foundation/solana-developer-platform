import { hashString } from "@sdp/payments/hash";
import type { ApiKeyRole } from "@sdp/types";
import type { DatabaseClient } from "@/db";
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
  role: ApiKeyRole;
  permissions: readonly string[];
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
 * @param input.role - Key role.
 * @param input.permissions - Granted permission scopes.
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
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
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
      input.role,
      JSON.stringify(input.permissions)
    )
    .run();
  return keyHash;
}
