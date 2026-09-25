import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const PROJECT = "prj_issuance_finality";
const API_KEY = "sk_test_issuance_finality";
const KEY_ID = "key_issuance_finality";
const TOKEN_ID = "tok_issuance_finality";
const CONFIRMED_ID = "itx_finality_confirmed";
const FINALIZED_ID = "itx_finality_finalized";
const PENDING_ID = "itx_finality_pending";

const READ_ONLY_KEY: CachedApiKey = {
  id: KEY_ID,
  organizationId: TEST_ORG.id,
  projectId: PROJECT,
  role: "api_readonly",
  permissions: ["tokens:read"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  walletScope: "all",
  status: "active",
  expiresAt: null,
  rotationDeadline: null,
  organizationStatus: "active",
};

async function seedTransaction(
  id: string,
  status: "pending" | "confirmed" | "finalized"
): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO issuance_transactions
         (id, token_id, organization_id, type, status, signature, slot,
          operation_params, created_at, updated_at)
       VALUES (?, ?, ?, 'mint', ?, ?, ?, '{}', ?, ?)`
    )
    .bind(
      id,
      TOKEN_ID,
      TEST_ORG.id,
      status,
      status === "pending" ? null : `sig_${id}`,
      status === "pending" ? null : 123,
      "2026-09-24T00:00:00.000Z",
      "2026-09-24T00:00:00.000Z"
    )
    .run();
}

describe("unified transactions route — issuance finality", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await clearKVStores(env);
    const keyHash = await hashString(API_KEY, env.API_KEY_PEPPER);

    const db = getDb(env);
    await db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: PROJECT, production: `${PROJECT}_production` },
    });
    await db
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
            role, permissions, status)
         VALUES (?, ?, ?, ?, 'Finality read key', 'sk_test_iss', ?, 'api_readonly',
                 '["tokens:read"]', 'active')`
      )
      .bind(KEY_ID, TEST_ORG.id, PROJECT, TEST_USER.id, keyHash)
      .run();
    await seedCachedApiKey(env, keyHash, READ_ONLY_KEY);
    await db
      .prepare(
        `INSERT INTO issued_tokens
           (id, project_id, organization_id, mint_address, name, symbol, decimals, created_by)
         VALUES (?, ?, ?, 'FinalityMint111111111111111111111111111111111',
                 'Finality token', 'FIN', 6, ?)`
      )
      .bind(TOKEN_ID, PROJECT, TEST_ORG.id, TEST_USER.id)
      .run();
    await seedTransaction(CONFIRMED_ID, "confirmed");
    await seedTransaction(FINALIZED_ID, "finalized");
    await seedTransaction(PENDING_ID, "pending");
  });

  afterEach(async () => {
    await clearKVStores(env);
    await seedTestDatabase(env);
  });

  it("reports confirmed issuance as provisional to a tokens:read caller", async () => {
    const response = await app.request(
      "/v1/transactions?module=issuance&limit=100",
      { headers: { Authorization: `Bearer ${API_KEY}` } },
      env
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        transactions: Array<{ id: string; moduleStatus: string; status: string }>;
      };
    };
    const transactions = body.data.transactions;

    // A pre-finality observation must stay non-terminal: confirmed is
    // provisional and only finalized settlement may read as succeeded.
    expect(transactions.find((row) => row.id === CONFIRMED_ID)).toMatchObject({
      moduleStatus: "confirmed",
      status: "pending",
    });
    expect(transactions.find((row) => row.id === FINALIZED_ID)).toMatchObject({
      moduleStatus: "finalized",
      status: "succeeded",
    });
    expect(transactions.find((row) => row.id === PENDING_ID)).toMatchObject({
      moduleStatus: "pending",
      status: "pending",
    });
  });
});
