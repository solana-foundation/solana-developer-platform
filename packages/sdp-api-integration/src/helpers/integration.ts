import { TEST_ORG, TEST_USER } from "@sdp/api-test/fixtures/organizations";
import {
  TEST_PROJECT,
  TEST_PROJECT_API_KEY,
  TEST_PROJECT_CACHED_KEY,
} from "@sdp/api-test/fixtures/tokens";
import { clearTestDatabase, seedTestDatabase } from "@sdp/api-test/mocks/d1";
import app from "@sdp/api/index";
import { hashString } from "@sdp/api/lib/hash";
import { createMosaicService } from "@sdp/api/services/mosaic";
import { Token2022Service, createSigner, createToken2022Service } from "@sdp/api/services/solana";
import { env } from "./env";

const SOLANA_CONFIGURED = !!env.SOLANA_RPC_URL && !!env.CUSTODY_PRIVATE_KEY;
const KORA_CONFIGURED = !!env.KORA_RPC_URL;
const RUN_INTEGRATION_TESTS = env.RUN_INTEGRATION_TESTS === "true";

let cachedKeyHash: string | null = null;
let cachedCustodyAddress: string | null = null;

async function computeApiKeyHash(): Promise<string> {
  if (cachedKeyHash) {
    return cachedKeyHash;
  }

  const pepper = (env as { API_KEY_PEPPER: string }).API_KEY_PEPPER;
  cachedKeyHash = await hashString(TEST_PROJECT_API_KEY.raw, pepper);
  return cachedKeyHash;
}

export async function initIntegrationSuite() {
  await seedTestDatabase(env);

  const apiKeyHash = await computeApiKeyHash();
  let custodyAddress = cachedCustodyAddress;

  if (!custodyAddress && SOLANA_CONFIGURED) {
    const signer = await createSigner(env);
    custodyAddress = signer.address;
    cachedCustodyAddress = custodyAddress;
  }

  return { apiKeyHash, custodyAddress: custodyAddress ?? "" };
}

export async function resetIntegrationState(apiKeyHash: string) {
  const db = env.DB;
  const apiKeysKV = env.SDP_API_KEYS;
  const rateLimitKV = env.SDP_RATE_LIMITS;

  const rateLimitKeys = await rateLimitKV.list();
  for (const key of rateLimitKeys.keys) {
    await rateLimitKV.delete(key.name);
  }

  await db
    .prepare("DELETE FROM signing_requests")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM custody_wallets")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM custody_configs")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM frozen_accounts")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM token_allowlist_statuses")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM token_allowlists")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM issuance_transaction_statuses")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM issuance_transactions")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM issued_token_extensions")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM issued_tokens")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM project_members")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM api_keys WHERE project_id IS NOT NULL")
    .run()
    .catch(() => {});
  await db
    .prepare("DELETE FROM projects")
    .run()
    .catch(() => {});

  await db
    .prepare(
      "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'free', 'active')"
    )
    .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
    .run();

  await db
    .prepare(
      "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
    )
    .bind(TEST_USER.id, TEST_USER.email)
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO projects (id, organization_id, name, slug, environment, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      TEST_PROJECT.id,
      TEST_PROJECT.organizationId,
      TEST_PROJECT.name,
      TEST_PROJECT.slug,
      TEST_PROJECT.environment,
      TEST_PROJECT.status,
      TEST_PROJECT.createdBy
    )
    .run();

  await db
    .prepare(
      `INSERT OR REPLACE INTO api_keys
       (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, environment, status)
       VALUES (?, ?, ?, ?, 'Project Test Key', ?, ?, 'api_admin', '["*"]', 'sandbox', 'active')`
    )
    .bind(
      TEST_PROJECT_API_KEY.id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      TEST_USER.id,
      TEST_PROJECT_API_KEY.prefix,
      apiKeyHash
    )
    .run();

  await apiKeysKV.put(`key:${apiKeyHash}`, JSON.stringify(TEST_PROJECT_CACHED_KEY));
}

export async function cleanupIntegrationSuite() {
  await clearTestDatabase(env);
}

export function request(url: string, init?: RequestInit) {
  return app.request(url, init, env);
}

export function requestWithApiKey(apiKey: string = TEST_PROJECT_API_KEY.raw) {
  return (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    return request(url, { ...init, headers });
  };
}

export {
  app,
  env,
  Token2022Service,
  createSigner,
  createToken2022Service,
  createMosaicService,
  TEST_ORG,
  TEST_USER,
  TEST_PROJECT,
  TEST_PROJECT_API_KEY,
  TEST_PROJECT_CACHED_KEY,
  SOLANA_CONFIGURED,
  KORA_CONFIGURED,
  RUN_INTEGRATION_TESTS,
};
