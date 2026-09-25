/**
 * @title Regression: requiredForDeploy asset metadata is enforced at the deploy boundary
 * @notice SOLA9-37 / APE-698: a `tokens:write` caller could create a
 * stablecoin/fiat_backed asset profile with empty issuanceMetadata, and both the
 * direct deploy and the legacy prepare/confirm endpoints proceeded past the
 * profile (stopping only at wallet checks) even though the Asset Type Registry
 * marks asset.issuerName and asset.pegCurrency as requiredForDeploy. The gate
 * must reject missing, null, empty, or whitespace-only values with field-specific
 * 400s at profile create/update and again at direct deploy, legacy prepare, and
 * legacy confirm — while profiles that satisfy the registry (or declare no
 * requirements) keep flowing.
 */

import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PROJECT } from "@/test/fixtures/tokens";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { env as testEnv } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const REGRESSION_ENV = testEnv;

const GATE_KEY = {
  id: "key_regression_required_gate",
  raw: "sk_test_required_gate_regression",
  prefix: "sk_test_regress",
} as const;

const GATE_CACHED_KEY: CachedApiKey = {
  id: GATE_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  role: "api_developer",
  // tokens:admin: profile PATCHes that alter the admin-governed compliance view
  // (the default profile carries advanced-settings state) require it.
  permissions: ["tokens:read", "tokens:write", "tokens:admin"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
  rotationDeadline: null,
  organizationStatus: "active",
};

async function seedGateCaller(): Promise<void> {
  const db = getDb(REGRESSION_ENV);
  await db
    .prepare(
      `INSERT INTO organizations (id, name, slug, tier, status)
       VALUES (?, ?, ?, 'individual', 'active')`
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
    ids: { sandbox: TEST_PROJECT.id, production: `${TEST_PROJECT.id}_production` },
  });

  const keyHash = await hashString(GATE_KEY.raw, REGRESSION_ENV.API_KEY_PEPPER);
  await seedProjectApiKey(db, REGRESSION_ENV, {
    key: GATE_KEY,
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    createdBy: TEST_USER.id,
    role: "api_developer",
    permissions: GATE_CACHED_KEY.permissions,
  });
  await createKVStoreSet(REGRESSION_ENV).apiKeys.put(
    `key:${keyHash}`,
    JSON.stringify(GATE_CACHED_KEY)
  );
}

const AUTH = { "Content-Type": "application/json", Authorization: `Bearer ${GATE_KEY.raw}` };

async function createToken(): Promise<string> {
  const res = await app.request(
    "/v1/issuance/tokens",
    {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ name: "Gate Token", symbol: "GATE" }),
    },
    REGRESSION_ENV
  );
  const body = (await res.json()) as { data?: { token?: { id: string } } };
  expect(res.status, JSON.stringify(body)).toBe(201);
  const tokenId = body.data?.token?.id;
  expect(tokenId).toEqual(expect.any(String));
  return tokenId as string;
}

/**
 * Durable bad state: a pending token whose ACTIVE profile is a registry type
 * declaring requiredForDeploy fields, with (partially) missing metadata. Seeded
 * directly so the deploy gates can be exercised independently of the create
 * gate — this is exactly the pre-fix durable state the finding demonstrated.
 */
async function retypeProfile(
  tokenId: string,
  category: string,
  type: string,
  issuanceMetadata: Record<string, unknown>
): Promise<void> {
  const changes = await getDb(REGRESSION_ENV)
    .prepare(
      `UPDATE asset_profiles
          SET asset_category = ?, asset_type = ?, asset_type_version = 2,
              issuance_metadata = ?::jsonb, public_metadata = '{}'::jsonb
        WHERE token_id = ? AND status = 'active'`
    )
    .bind(category, type, JSON.stringify(issuanceMetadata), tokenId)
    .run();
  expect(changes).toBe(1);
}

async function createProfileBody(issuanceMetadata: Record<string, unknown>): Promise<Response> {
  return app.request(
    "/v1/issuance/asset-profiles",
    {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        name: "Gate Profile",
        symbol: "GATE",
        template: "stablecoin",
        assetCategory: "stablecoin",
        assetType: "fiat_backed",
        issuanceMetadata,
      }),
    },
    REGRESSION_ENV
  );
}

const MISSING_FIELDS_MESSAGE = /asset\.issuerName|asset\.pegCurrency|requiredForDeploy/i;
const WALLET_MESSAGE = /signingCustodyWalletId/i;

describe("requiredForDeploy metadata gate (SOLA9-37)", () => {
  beforeEach(async () => {
    await seedTestDatabase(REGRESSION_ENV);
    await seedGateCaller();
  });

  it("rejects a create whose declared requiredForDeploy fields are empty", async () => {
    const res = await createProfileBody({});
    const body = (await res.json()) as { error?: { message?: string } };
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error?.message ?? "").toMatch(MISSING_FIELDS_MESSAGE);
  });

  it("rejects a create whose required fields are null or whitespace-only", async () => {
    for (const asset of [
      { issuerName: null, pegCurrency: "USD" },
      { issuerName: "   ", pegCurrency: "USD" },
      { issuerName: "Acme", pegCurrency: "" },
    ]) {
      const res = await createProfileBody({ asset });
      const body = (await res.json()) as { error?: { message?: string } };
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(body.error?.message ?? "").toMatch(MISSING_FIELDS_MESSAGE);
    }
  });

  it("accepts a populated profile for the same type (compatibility)", async () => {
    const res = await createProfileBody({
      asset: { issuerName: "Acme Financial Inc.", pegCurrency: "USD" },
    });
    const body = (await res.json()) as { data?: { assetProfile?: Record<string, unknown> } };
    expect(res.status, JSON.stringify(body)).toBe(201);
  });

  it("does not enforce fields the type does not declare (negative)", async () => {
    const res = await app.request(
      "/v1/issuance/asset-profiles",
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          name: "Equity Without Peg",
          symbol: "EQWP",
          template: "custom",
          assetCategory: "tokenized_security",
          assetType: "equity",
          // pegCurrency is NOT requiredForDeploy for tokenized_security/equity.
          issuanceMetadata: { asset: { issuerName: "Acme Corp" } },
        }),
      },
      REGRESSION_ENV
    );
    const body = (await res.json()) as { data?: unknown };
    expect(res.status, JSON.stringify(body)).toBe(201);
  });

  it("still rejects unsupported category/type pairs (negative control)", async () => {
    const res = await app.request(
      "/v1/issuance/asset-profiles",
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          name: "Unsupported Pair",
          symbol: "UPAIR",
          assetCategory: "stablecoin",
          assetType: "equity",
          issuanceMetadata: {},
        }),
      },
      REGRESSION_ENV
    );
    expect(res.status).toBe(400);
  });

  it("rejects a profile update that retypes into a type with unmet required fields", async () => {
    const tokenId = await createToken();
    const profile = await app.request(
      `/v1/issuance/asset-profiles/by-token/${tokenId}`,
      { headers: { Authorization: `Bearer ${GATE_KEY.raw}` } },
      REGRESSION_ENV
    );
    const profileBody = (await profile.json()) as {
      data?: { assetProfile?: { id?: string } };
    };
    const profileId = profileBody.data?.assetProfile?.id;
    expect(profileId).toEqual(expect.any(String));

    const patch = await app.request(
      `/v1/issuance/asset-profiles/${profileId}`,
      {
        method: "PATCH",
        headers: AUTH,
        body: JSON.stringify({
          assetCategory: "stablecoin",
          assetType: "fiat_backed",
          issuanceMetadata: { asset: { name: "Gate Token" } },
        }),
      },
      REGRESSION_ENV
    );
    const patchBody = (await patch.json()) as { error?: { message?: string } };
    expect(patch.status, JSON.stringify(patchBody)).toBe(400);
    expect(patchBody.error?.message ?? "").toMatch(MISSING_FIELDS_MESSAGE);
  });

  it("rejects a profile update that drops required fields from the metadata", async () => {
    const create = await createProfileBody({
      asset: { issuerName: "Acme Financial Inc.", pegCurrency: "USD" },
    });
    const createBody = (await create.json()) as {
      data?: { assetProfile?: { id?: string } };
    };
    const profileId = createBody.data?.assetProfile?.id;
    expect(profileId).toEqual(expect.any(String));

    const patch = await app.request(
      `/v1/issuance/asset-profiles/${profileId}`,
      {
        method: "PATCH",
        headers: AUTH,
        body: JSON.stringify({ issuanceMetadata: { asset: { name: "Stripped" } } }),
      },
      REGRESSION_ENV
    );
    const patchBody = (await patch.json()) as { error?: { message?: string } };
    expect(patch.status, JSON.stringify(patchBody)).toBe(400);
    expect(patchBody.error?.message ?? "").toMatch(MISSING_FIELDS_MESSAGE);
  });

  it("accepts a profile update that keeps required fields populated (compatibility)", async () => {
    const tokenId = await createToken();
    const profile = await app.request(
      `/v1/issuance/asset-profiles/by-token/${tokenId}`,
      { headers: { Authorization: `Bearer ${GATE_KEY.raw}` } },
      REGRESSION_ENV
    );
    const profileBody = (await profile.json()) as {
      data?: { assetProfile?: { id?: string } };
    };
    const profileId = profileBody.data?.assetProfile?.id;
    expect(profileId).toEqual(expect.any(String));

    const patch = await app.request(
      `/v1/issuance/asset-profiles/${profileId}`,
      {
        method: "PATCH",
        headers: AUTH,
        body: JSON.stringify({
          assetCategory: "stablecoin",
          assetType: "fiat_backed",
          issuanceMetadata: {
            asset: { name: "Gate Token", issuerName: "Acme Financial Inc.", pegCurrency: "USD" },
          },
        }),
      },
      REGRESSION_ENV
    );
    const patchBody = (await patch.json()) as { data?: unknown };
    expect(patch.status, JSON.stringify(patchBody)).toBe(200);
  });

  it("direct deploy rejects a durable profile with missing required metadata", async () => {
    const tokenId = await createToken();
    await retypeProfile(tokenId, "stablecoin", "fiat_backed", {});

    const res = await app.request(
      `/v1/issuance/tokens/${tokenId}/deploy`,
      { method: "POST", headers: AUTH, body: JSON.stringify({}) },
      REGRESSION_ENV
    );
    const body = (await res.json()) as { error?: { code: string; message: string } };
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error?.message ?? "").toMatch(MISSING_FIELDS_MESSAGE);
    expect(body.error?.message ?? "").not.toMatch(WALLET_MESSAGE);
  });

  it("direct deploy still reaches the wallet guard for a populated profile (compatibility)", async () => {
    const tokenId = await createToken();
    await retypeProfile(tokenId, "stablecoin", "fiat_backed", {
      asset: { issuerName: "Acme Financial Inc.", pegCurrency: "USD" },
    });

    const res = await app.request(
      `/v1/issuance/tokens/${tokenId}/deploy`,
      { method: "POST", headers: AUTH, body: JSON.stringify({}) },
      REGRESSION_ENV
    );
    const body = (await res.json()) as { error?: { message: string } };
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error?.message ?? "").toMatch(WALLET_MESSAGE);
    expect(body.error?.message ?? "").not.toMatch(MISSING_FIELDS_MESSAGE);
  });

  it("direct deploy ignores the gate for types with no declared requirements (compatibility)", async () => {
    const tokenId = await createToken();

    const res = await app.request(
      `/v1/issuance/tokens/${tokenId}/deploy`,
      { method: "POST", headers: AUTH, body: JSON.stringify({}) },
      REGRESSION_ENV
    );
    const body = (await res.json()) as { error?: { message: string } };
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error?.message ?? "").toMatch(WALLET_MESSAGE);
  });

  it("legacy prepare rejects a durable profile with missing required metadata", async () => {
    const tokenId = await createToken();
    await retypeProfile(tokenId, "stablecoin", "fiat_backed", {});

    const res = await app.request(
      `/v1/issuance/tokens/${tokenId}/deploy/prepare`,
      { method: "POST", headers: AUTH, body: JSON.stringify({}) },
      REGRESSION_ENV
    );
    const body = (await res.json()) as { error?: { code: string; message: string } };
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error?.message ?? "").toMatch(MISSING_FIELDS_MESSAGE);
    expect(body.error?.code).toBe("BAD_REQUEST");
  });

  it("legacy prepare still reaches the wallet resolution for a populated profile (compatibility)", async () => {
    const tokenId = await createToken();
    await retypeProfile(tokenId, "stablecoin", "fiat_backed", {
      asset: { issuerName: "Acme Financial Inc.", pegCurrency: "USD" },
    });

    const res = await app.request(
      `/v1/issuance/tokens/${tokenId}/deploy/prepare`,
      { method: "POST", headers: AUTH, body: JSON.stringify({}) },
      REGRESSION_ENV
    );
    const body = (await res.json()) as { error?: { code: string; message: string } };
    // No wallet/config exists: the flow stops at wallet resolution (404), not
    // at the metadata gate — proving the gate passed the populated profile.
    expect(res.status, JSON.stringify(body)).toBe(404);
    expect(body.error?.message ?? "").not.toMatch(MISSING_FIELDS_MESSAGE);
  });

  it("legacy confirm refuses to record a deploy of a profile with missing required metadata", async () => {
    const tokenId = await createToken();
    await retypeProfile(tokenId, "stablecoin", "fiat_backed", {});

    const res = await app.request(
      `/v1/issuance/tokens/${tokenId}/deploy/confirm`,
      {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          signature: "5".repeat(88),
        }),
      },
      REGRESSION_ENV
    );
    const body = (await res.json()) as { error?: { code: string; message: string } };
    expect(res.status, JSON.stringify(body)).toBe(400);
    expect(body.error?.message ?? "").toMatch(MISSING_FIELDS_MESSAGE);

    // Refused before the claim: the token stays pending and unrecorded.
    const token = await app.request(
      `/v1/issuance/tokens/${tokenId}`,
      { headers: { Authorization: `Bearer ${GATE_KEY.raw}` } },
      REGRESSION_ENV
    );
    const tokenBody = (await token.json()) as { data?: { token?: { status: string } } };
    expect(tokenBody.data?.token?.status).toBe("pending");
  });
});
