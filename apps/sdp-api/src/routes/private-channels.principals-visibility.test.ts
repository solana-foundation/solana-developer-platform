import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

/**
 * Regression test for the principal-directory visibility finding (SOLA9-662):
 * GET /v1/private-channels/principals used to return every project principal
 * and its channel assignments to any caller holding only payments:read. The
 * full directory is administrative (projects:write / org:admin, matching every
 * directory mutation); lesser callers may only see the project's default
 * movement principal — the identity their payments flows act through.
 */

const ORG_ID = "org_poc_principal_directory";
const PROJECT_ID = "prj_poc_principal_directory";
const USER_ID = "usr_poc_principal_directory";
const INSTANCE_ID = "pci_poc_principal_directory";
const READONLY_KEY = "sk_test_poc_principal_readonly";
const DIRECTORY_KEY = "sk_test_poc_principal_directory";
const DENIED_KEY = "sk_test_poc_principal_denied";

const readonlyKey: CachedApiKey = {
  id: "key_poc_principal_readonly",
  organizationId: ORG_ID,
  projectId: PROJECT_ID,
  role: "api_readonly",
  permissions: ["payments:read"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

const directoryKey: CachedApiKey = {
  ...readonlyKey,
  id: "key_poc_principal_directory",
  role: "api_developer",
  permissions: ["payments:read", "payments:write", "projects:write"],
};

const deniedKey: CachedApiKey = {
  ...readonlyKey,
  id: "key_poc_principal_denied",
  permissions: ["projects:read"],
};

async function cacheKey(raw: string, key: CachedApiKey): Promise<void> {
  await seedCachedApiKey(env, await hashString(raw, env.API_KEY_PEPPER), key);
}

async function seedProjectDirectory(): Promise<void> {
  const db = getDb(env);
  await db
    .prepare(
      `INSERT INTO organizations (id, name, slug, tier, status)
       VALUES (?, 'Principal Directory POC', ?, 'enterprise', 'active')`
    )
    .bind(ORG_ID, ORG_ID)
    .run();
  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified, status)
       VALUES (?, 'poc-owner@example.test', 1, 'active')`
    )
    .bind(USER_ID)
    .run();
  await seedDefaultProjects(db, {
    organizationId: ORG_ID,
    createdBy: USER_ID,
    members: [USER_ID],
    ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
  });
  await db
    .prepare(
      `INSERT INTO private_channel_instances (
         id, organization_id, project_id, gateway_url, chain_rpc_url,
         escrow_program_id, withdraw_program_id, escrow_instance_addr, auth_url,
         is_active, created_by
       ) VALUES (?, ?, ?, 'https://gateway.example.test', 'https://rpc.example.test',
                 'escrow-program', 'withdraw-program', 'escrow-instance',
                 'https://auth.example.test', TRUE, ?)`
    )
    .bind(INSTANCE_ID, ORG_ID, PROJECT_ID, USER_ID)
    .run();
  await db
    .prepare(
      `INSERT INTO private_channels (
         id, organization_id, project_id, instance_id, name, description,
         is_default, status
       ) VALUES
         ('pch_poc_general', ?, ?, ?, 'General', 'Default channel', TRUE, 'active'),
         ('pch_poc_confidential', ?, ?, ?, 'Confidential Treasury', 'Restricted channel', FALSE, 'active')`
    )
    .bind(ORG_ID, PROJECT_ID, INSTANCE_ID, ORG_ID, PROJECT_ID, INSTANCE_ID)
    .run();
  await db
    .prepare(
      `INSERT INTO private_channel_users (
         id, organization_id, project_id, instance_id, user_id, name,
         is_default, created_by, spc_user_id, spc_username,
         spc_credential_ciphertext, provisioned_at
       ) VALUES
         ('pcu_poc_default', ?, ?, ?, NULL, 'Default', TRUE, ?, 'spc-default',
          'default@example.test', 'synthetic-ciphertext', '2026-09-25T00:00:00.000Z'),
         ('pcu_poc_treasury', ?, ?, ?, NULL, 'Treasury Operator', FALSE, ?, 'spc-treasury',
          'treasury@example.test', 'synthetic-ciphertext', '2026-09-25T00:00:01.000Z')`
    )
    .bind(ORG_ID, PROJECT_ID, INSTANCE_ID, USER_ID, ORG_ID, PROJECT_ID, INSTANCE_ID, USER_ID)
    .run();
  await db
    .prepare(
      `INSERT INTO private_channel_memberships (
         id, channel_id, private_channel_user_id, added_by
       ) VALUES
         ('pcm_poc_default', 'pch_poc_general', 'pcu_poc_default', ?),
         ('pcm_poc_treasury', 'pch_poc_confidential', 'pcu_poc_treasury', ?)`
    )
    .bind(USER_ID, USER_ID)
    .run();
  // The default principal's wallets were verified under the active instance;
  // the dashboard overview reads this derived count.
  await db
    .prepare(
      `INSERT INTO private_channel_verified_wallets (
         id, organization_id, project_id, user_id, instance_id, wallet_id, pubkey
       ) VALUES
         ('pcvw_poc_default_1', ?, ?, 'pcu_poc_default', ?, 'wal_poc_default_1',
          'So1111111111111111111111111111111111111111'),
         ('pcvw_poc_default_2', ?, ?, 'pcu_poc_default', ?, 'wal_poc_default_2',
          'So1111111111111111111111111111111111111112')`
    )
    .bind(ORG_ID, PROJECT_ID, INSTANCE_ID, ORG_ID, PROJECT_ID, INSTANCE_ID)
    .run();
}

interface PrincipalDto {
  id: string;
  name: string;
  isDefault: boolean;
  status: string;
  verifiedWalletCount: number;
  channels: Array<{ id: string; name: string; isDefault: boolean }>;
}

async function getPrincipals(raw: string): Promise<{ status: number; principals: PrincipalDto[] }> {
  const response = await app.request(
    "/v1/private-channels/principals",
    {
      headers: {
        Authorization: `Bearer ${raw}`,
        "x-forwarded-for": "198.51.100.24",
      },
    },
    env
  );
  const body = (await response.json()) as { data?: { principals?: PrincipalDto[] } };
  return { status: response.status, principals: body.data?.principals ?? [] };
}

describe("GET /v1/private-channels/principals directory visibility", () => {
  let originalPrivateChannelsEnabled: string | undefined;

  beforeEach(async () => {
    originalPrivateChannelsEnabled = env.PRIVATE_CHANNELS_ENABLED;
    env.PRIVATE_CHANNELS_ENABLED = "true";
    await seedTestDatabase(env);
    await seedProjectDirectory();
    await cacheKey(READONLY_KEY, readonlyKey);
    await cacheKey(DIRECTORY_KEY, directoryKey);
    await cacheKey(DENIED_KEY, deniedKey);
  });

  afterEach(async () => {
    env.PRIVATE_CHANNELS_ENABLED = originalPrivateChannelsEnabled;
    await clearKVStores(env);
  });

  it("hides other principals and their channel assignments from a payments:read-only caller", async () => {
    const { status, principals } = await getPrincipals(READONLY_KEY);

    expect(status).toBe(200);
    expect(readonlyKey.permissions).not.toContain("projects:write");

    // Only the caller's own movement principal is visible: no directory
    // enumeration of other principals (SOLA9-662).
    expect(principals).toEqual([
      expect.objectContaining({
        id: "pcu_poc_default",
        name: "Default",
        isDefault: true,
        status: "active",
        // The restricted path must report the same derived verified-wallet
        // count the full-directory path reports for this principal.
        verifiedWalletCount: 2,
      }),
    ]);
    expect(principals.map((principal) => principal.id)).not.toContain("pcu_poc_treasury");
    expect(principals.map((principal) => principal.name)).not.toContain("Treasury Operator");
    const listedChannels = principals.flatMap((principal) => principal.channels);
    expect(listedChannels.map((channel) => channel.id)).not.toContain("pch_poc_confidential");
  });

  it("still returns the default principal's own channel memberships to preserve transfer flows", async () => {
    const { status, principals } = await getPrincipals(READONLY_KEY);

    expect(status).toBe(200);
    expect(principals[0]?.channels).toEqual([
      { id: "pch_poc_general", name: "General", isDefault: true },
    ]);
  });

  it("returns the full directory to a projects:write caller", async () => {
    const { status, principals } = await getPrincipals(DIRECTORY_KEY);

    expect(status).toBe(200);
    expect(directoryKey.permissions).toContain("projects:write");
    expect(principals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "pcu_poc_default",
          name: "Default",
          isDefault: true,
          verifiedWalletCount: 2,
          channels: [{ id: "pch_poc_general", name: "General", isDefault: true }],
        }),
        expect.objectContaining({
          id: "pcu_poc_treasury",
          name: "Treasury Operator",
          isDefault: false,
          verifiedWalletCount: 0,
          channels: [
            { id: "pch_poc_confidential", name: "Confidential Treasury", isDefault: false },
          ],
        }),
      ])
    );
  });

  it("rejects a caller that lacks payments:read", async () => {
    const { status } = await getPrincipals(DENIED_KEY);
    expect(status).toBe(403);
  });
});
