/**
 * Regression: the public asset-profile projection must bind `chain.decimals`
 * to the token row's authoritative mint/accounting scale (SOLA9-439).
 *
 * A project-scoped `tokens:write` key could submit `decimals: 6` with
 * `issuanceMetadata.chain.decimals: 18`; the token and every accounting path
 * use the token row, while the cached `public_metadata` (served verbatim by the
 * canonical metadata.json URI) used the caller's claim, so public consumers
 * could read the wrong unit scale. The projection must derive the published
 * scale from the token row on create and update, and a matching claim must keep
 * working unchanged.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import {
  TEST_PRODUCTION_PROJECT,
  TEST_PROJECT,
  TEST_PROJECT_API_KEY,
  TEST_PROJECT_CACHED_KEY,
} from "@/test/fixtures/tokens";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { seedCachedApiKey } from "@/test/mocks/kv";

// The fiat-backed stablecoin registry projection publishes chain.decimals by
// default, so a plain stablecoin create exercises the binding.
function createBody(chainDecimals: number | undefined) {
  return {
    name: "Decimal Binding Token",
    symbol: "DBT",
    template: "stablecoin",
    decimals: 6,
    assetCategory: "stablecoin",
    assetType: "fiat_backed",
    issuanceMetadata: {
      asset: {
        name: "Decimal Binding USD",
        issuerName: "Synthetic Issuer",
        pegCurrency: "USD",
      },
      ...(chainDecimals === undefined ? {} : { chain: { decimals: chainDecimals } }),
    },
  };
}

async function createAssetProfile(chainDecimals: number | undefined) {
  const response = await app.request(
    "/v1/issuance/asset-profiles",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
      },
      body: JSON.stringify(createBody(chainDecimals)),
    },
    env
  );
  expect(response.status).toBe(201);
  return (await response.json()) as {
    data: {
      token: { id: string; decimals: number };
      assetProfile: {
        id: string;
        publicMetadata: { chain?: { decimals?: number } };
      };
    };
  };
}

async function loadPersistedDecimals(tokenId: string, profileId: string) {
  return getDb(env)
    .prepare(
      `SELECT token.decimals AS token_decimals,
              profile.public_metadata->'chain'->>'decimals' AS public_decimals
         FROM issued_tokens AS token
         JOIN asset_profiles AS profile ON profile.token_id = token.id
        WHERE token.id = ?
          AND profile.id = ?`
    )
    .bind(tokenId, profileId)
    .first<{ token_decimals: number; public_decimals: string | null }>();
}

describe("asset profile public chain.decimals binding", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);

    await db
      .prepare(
        `INSERT INTO organizations
            (id, name, slug, tier, status, settings)
          VALUES (?, ?, ?, 'individual', 'active',
                  '{"providerOverrides":{"custody":{"local":true}}}')`
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
      ids: { sandbox: TEST_PROJECT.id, production: TEST_PRODUCTION_PROJECT.id },
    });

    // Plain project-scoped tokens:write — the finding's threat model. No
    // tokens:admin, so the fix must hold without elevated grants.
    const keyHash = await seedProjectApiKey(db, env, {
      key: TEST_PROJECT_API_KEY,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      createdBy: TEST_USER.id,
      role: "api_admin",
      permissions: ["tokens:write", "tokens:read"],
    });
    await seedCachedApiKey(env, keyHash, TEST_PROJECT_CACHED_KEY);
  });

  it("binds the public projection to the token scale when the caller claims a different one", async () => {
    const body = await createAssetProfile(18);

    expect(body.data.token.decimals).toBe(6);
    expect(body.data.assetProfile.publicMetadata.chain?.decimals).toBe(6);

    const stored = await loadPersistedDecimals(body.data.token.id, body.data.assetProfile.id);
    expect(stored).toEqual({ token_decimals: 6, public_decimals: "6" });
  });

  it("binds the public projection when the caller omits chain.decimals", async () => {
    const body = await createAssetProfile(undefined);

    expect(body.data.token.decimals).toBe(6);
    expect(body.data.assetProfile.publicMetadata.chain?.decimals).toBe(6);

    const stored = await loadPersistedDecimals(body.data.token.id, body.data.assetProfile.id);
    expect(stored).toEqual({ token_decimals: 6, public_decimals: "6" });
  });

  it("keeps a matching caller claim working unchanged", async () => {
    const body = await createAssetProfile(6);

    expect(body.data.token.decimals).toBe(6);
    expect(body.data.assetProfile.publicMetadata.chain?.decimals).toBe(6);

    const stored = await loadPersistedDecimals(body.data.token.id, body.data.assetProfile.id);
    expect(stored).toEqual({ token_decimals: 6, public_decimals: "6" });
  });

  it("rebinds the cached projection when an update claims a different scale", async () => {
    const created = await createAssetProfile(6);
    const profileId = created.data.assetProfile.id;

    const response = await app.request(
      `/v1/issuance/asset-profiles/${profileId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
        },
        body: JSON.stringify({
          issuanceMetadata: {
            asset: {
              name: "Decimal Binding USD",
              issuerName: "Synthetic Issuer",
              pegCurrency: "USD",
            },
            chain: { decimals: 18 },
          },
        }),
      },
      env
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { assetProfile: { publicMetadata: { chain?: { decimals?: number } } } };
    };
    expect(body.data.assetProfile.publicMetadata.chain?.decimals).toBe(6);

    const stored = await loadPersistedDecimals(created.data.token.id, profileId);
    expect(stored).toEqual({ token_decimals: 6, public_decimals: "6" });
  });
});

describe("asset profile public chain.decimals binding across token edits", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);

    await db
      .prepare(
        `INSERT INTO organizations
            (id, name, slug, tier, status, settings)
          VALUES (?, ?, ?, 'individual', 'active',
                  '{"providerOverrides":{"custody":{"local":true}}}')`
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
      ids: { sandbox: TEST_PROJECT.id, production: TEST_PRODUCTION_PROJECT.id },
    });

    const keyHash = await seedProjectApiKey(db, env, {
      key: TEST_PROJECT_API_KEY,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      createdBy: TEST_USER.id,
      role: "api_admin",
      permissions: ["tokens:write", "tokens:read"],
    });
    await seedCachedApiKey(env, keyHash, TEST_PROJECT_CACHED_KEY);
  });

  // An arcade (generic-category) template keeps `decimals` editable pre-deploy,
  // while the profile still publishes chain.decimals: the exact window in which
  // a token edit can silently strand the cached projection on the old scale.
  async function createEditableTokenProfile() {
    const response = await app.request(
      "/v1/issuance/asset-profiles",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
        },
        body: JSON.stringify({
          name: "Editable Scale Token",
          symbol: "EST",
          template: "arcade",
          decimals: 6,
          assetCategory: "stablecoin",
          assetType: "generic",
          issuanceMetadata: {
            asset: { name: "Editable Scale USD" },
            chain: { decimals: 18 },
          },
        }),
      },
      env
    );
    expect(response.status).toBe(201);
    return (await response.json()) as {
      data: { token: { id: string }; assetProfile: { id: string } };
    };
  }

  async function patchToken(tokenId: string, body: Record<string, unknown>) {
    return app.request(
      `/v1/issuance/tokens/${tokenId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
        },
        body: JSON.stringify(body),
      },
      env
    );
  }

  it("rebinds the cached projection when the token's decimals change", async () => {
    const created = await createEditableTokenProfile();
    expect(
      await loadPersistedDecimals(created.data.token.id, created.data.assetProfile.id)
    ).toEqual({ token_decimals: 6, public_decimals: "6" });

    const response = await patchToken(created.data.token.id, { decimals: 9 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { token: { decimals: number } } };
    expect(body.data.token.decimals).toBe(9);

    const stored = await loadPersistedDecimals(created.data.token.id, created.data.assetProfile.id);
    expect(stored).toEqual({ token_decimals: 9, public_decimals: "9" });
  });

  it("keeps the projection bound when a token edit races a profile edit", async () => {
    const created = await createEditableTokenProfile();
    const tokenId = created.data.token.id;
    const profileId = created.data.assetProfile.id;

    // Park a lock on the token row so both concurrent edits are forced into the
    // serialized order the rebinding relies on: whichever write lands first,
    // the last one to touch the cache must project the token row's scale.
    let signalLocked: () => void = () => undefined;
    let releaseTokenRow: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseTokenRow = resolve;
    });
    const holdTokenRow = getDb(env).transaction(async (tx) => {
      await tx.queryOne("SELECT id FROM issued_tokens WHERE id = ? FOR UPDATE", [tokenId]);
      signalLocked();
      await released;
    });
    await locked;

    const profileEdit = app.request(
      `/v1/issuance/asset-profiles/${profileId}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_PROJECT_API_KEY.raw}`,
        },
        body: JSON.stringify({
          issuanceMetadata: {
            asset: { name: "Editable Scale USD" },
            chain: { decimals: 18 },
          },
        }),
      },
      env
    );
    const tokenEdit = patchToken(tokenId, { decimals: 9 });
    releaseTokenRow();

    const [profileResponse, tokenResponse] = await Promise.all([
      profileEdit,
      tokenEdit,
      holdTokenRow,
    ]);
    expect(profileResponse.status).toBe(200);
    expect(tokenResponse.status).toBe(200);

    const stored = await loadPersistedDecimals(tokenId, profileId);
    expect(stored).toEqual({ token_decimals: 9, public_decimals: "9" });
  });
});
