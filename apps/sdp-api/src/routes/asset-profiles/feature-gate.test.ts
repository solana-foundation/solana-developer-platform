/**
 * Regression for SOLA9-604 / APE-866: the /v1/issuance/asset-profiles router is
 * the Asset Profiles CRUD surface and must honor the same self-hosted
 * production opt-in the resolver and configurator already implement.
 *
 * The secure invariant: a self-hosted production deployment that has not
 * explicitly opted in (SDP_FLAG_ASSET_PROFILES=false, or omitted) must refuse
 * every route in the family — reads and mutations alike — and must not persist
 * any asset-profile state. Supported flows stay supported: an explicit opt-in,
 * managed (non-self-hosted) deployments, and development keep working.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { isAssetProfilesEnabled } from "@/lib/feature-flags";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase as resetTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const PROJECT_ID = "prj_asset_profiles_gate";
const READ_WRITE_KEY = {
  id: "key_asset_profiles_gate_rw",
  raw: "sk_test_asset_profiles_gate_rw",
  prefix: "sk_test_asset_profiles_g",
} as const;
const WRITE_ONLY_KEY = {
  id: "key_asset_profiles_gate_wo",
  raw: "sk_test_asset_profiles_gate_wo",
  prefix: "sk_test_asset_profiles_w",
} as const;

// Exactly the shipped self-hosted production posture: compose.yml resolves
// ENVIRONMENT=production and SDP_DEPLOYMENT_MODE=self_hosted, and the flag
// decides the opt-in.
const selfHostedProduction = {
  ...env,
  ENVIRONMENT: "production" as const,
  SDP_DEPLOYMENT_MODE: "self_hosted" as const,
  SDP_FLAG_ASSET_PROFILES: "false",
};
const selfHostedOptedIn = { ...selfHostedProduction, SDP_FLAG_ASSET_PROFILES: "true" };
// Managed deployments never gate on this flag (Vercel owns the rollout there).
const managedProduction = { ...selfHostedProduction, SDP_DEPLOYMENT_MODE: "managed" as const };
// Development is always enabled, flag present or not.
const selfHostedDevelopment = {
  ...env,
  SDP_DEPLOYMENT_MODE: "self_hosted" as const,
};

const createBody = {
  name: "Opt-in boundary probe token",
  symbol: "OBP",
  template: "custom",
  assetCategory: "generic",
  assetType: "generic",
  issuanceMetadata: {
    asset: {
      name: "Opt-in boundary probe token",
      description: "Probes the Asset Profiles production opt-in",
    },
  },
};

async function seedScenario(): Promise<void> {
  const db = getDb(env);
  await db
    .prepare(
      `INSERT INTO organizations (id, name, slug, tier, status)
       VALUES (?, ?, ?, 'individual', 'active')`
    )
    .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
    .run();
  await db
    .prepare(`INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')`)
    .bind(TEST_USER.id, TEST_USER.email)
    .run();
  await seedDefaultProjects(db, {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [],
    ids: { sandbox: `${PROJECT_ID}_sandbox`, production: PROJECT_ID },
  });
  await seedProjectApiKey(db, env, {
    key: READ_WRITE_KEY,
    organizationId: TEST_ORG.id,
    projectId: PROJECT_ID,
    createdBy: TEST_USER.id,
    role: "api_developer",
    permissions: ["tokens:read", "tokens:write"],
  });
  await seedProjectApiKey(db, env, {
    key: WRITE_ONLY_KEY,
    organizationId: TEST_ORG.id,
    projectId: PROJECT_ID,
    createdBy: TEST_USER.id,
    role: "api_developer",
    permissions: ["tokens:write"],
  });
}

async function assetProfileRowCount(): Promise<number> {
  const rows = await getDb(env)
    .prepare(`SELECT id FROM asset_profiles WHERE project_id = ?`)
    .bind(PROJECT_ID)
    .all<{ id: string }>();
  return rows.rows?.length ?? 0;
}

describe("Asset Profiles self-hosted production opt-in boundary", () => {
  beforeEach(async () => {
    await resetTestDatabase(env as Parameters<typeof resetTestDatabase>[0]);
    await seedScenario();
    await clearKVStores(env);
  });

  it("refuses every asset-profiles route and persists nothing when the opt-in is false", async () => {
    // The resolver itself honors the opt-out; the router must enforce it too.
    expect(isAssetProfilesEnabled(selfHostedProduction)).toBe(false);
    expect(isAssetProfilesEnabled(selfHostedOptedIn)).toBe(true);

    const readHeaders = { Authorization: `Bearer ${READ_WRITE_KEY.raw}` };
    const writeHeaders = {
      Authorization: `Bearer ${WRITE_ONLY_KEY.raw}`,
      "Content-Type": "application/json",
    };

    const list = await app.request(
      "/v1/issuance/asset-profiles",
      { headers: readHeaders },
      selfHostedProduction
    );
    expect(list.status).toBe(403);

    const fieldOptions = await app.request(
      "/v1/issuance/asset-profiles/field-options",
      { headers: readHeaders },
      selfHostedProduction
    );
    expect(fieldOptions.status).toBe(403);

    const create = await app.request(
      "/v1/issuance/asset-profiles",
      { method: "POST", headers: writeHeaders, body: JSON.stringify(createBody) },
      selfHostedProduction
    );
    expect(create.status).toBe(403);

    const getById = await app.request(
      "/v1/issuance/asset-profiles/prf_asset_profiles_gate_probe",
      { headers: readHeaders },
      selfHostedProduction
    );
    expect(getById.status).toBe(403);

    const getByToken = await app.request(
      "/v1/issuance/asset-profiles/by-token/tkn_asset_profiles_gate_probe",
      { headers: readHeaders },
      selfHostedProduction
    );
    expect(getByToken.status).toBe(403);

    // The exploit's core: a minimal-permission key must not create durable
    // tenant state while the production flag is false.
    expect(await assetProfileRowCount()).toBe(0);
  });

  it("keeps the explicit self-hosted opt-in working end to end", async () => {
    expect(isAssetProfilesEnabled(selfHostedOptedIn)).toBe(true);

    const headers = {
      Authorization: `Bearer ${READ_WRITE_KEY.raw}`,
      "Content-Type": "application/json",
    };
    const create = await app.request(
      "/v1/issuance/asset-profiles",
      { method: "POST", headers, body: JSON.stringify(createBody) },
      selfHostedOptedIn
    );
    expect(create.status).toBe(201);

    const created = (await create.json()) as {
      data: { assetProfile: { id: string; projectId: string } };
    };
    const profileId = created.data.assetProfile.id;
    const row = await getDb(env)
      .prepare(`SELECT id, project_id, status FROM asset_profiles WHERE id = ?`)
      .bind(profileId)
      .first<{ id: string; project_id: string; status: string }>();
    expect(row).toEqual({ id: profileId, project_id: PROJECT_ID, status: "active" });

    const list = await app.request(
      "/v1/issuance/asset-profiles",
      { headers: { Authorization: `Bearer ${READ_WRITE_KEY.raw}` } },
      selfHostedOptedIn
    );
    expect(list.status).toBe(200);
  });

  it("keeps managed deployments always enabled regardless of the flag", async () => {
    expect(isAssetProfilesEnabled(managedProduction)).toBe(true);

    const list = await app.request(
      "/v1/issuance/asset-profiles",
      { headers: { Authorization: `Bearer ${READ_WRITE_KEY.raw}` } },
      managedProduction
    );
    expect(list.status).toBe(200);
  });

  it("keeps self-hosted development enabled without the flag", async () => {
    expect(isAssetProfilesEnabled(selfHostedDevelopment)).toBe(true);

    const list = await app.request(
      "/v1/issuance/asset-profiles",
      { headers: { Authorization: `Bearer ${READ_WRITE_KEY.raw}` } },
      selfHostedDevelopment
    );
    expect(list.status).toBe(200);
  });
});
