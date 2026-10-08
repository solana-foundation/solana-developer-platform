import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey, CustodyProvider } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { custodyProviderNotInReleaseChannel } from "@/services/provider-availability.service";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const original = await importOriginal<typeof import("@sdp/types/release-channels")>();
  const isCustodyProviderInReleaseChannel: typeof original.isCustodyProviderInReleaseChannel = (
    releaseChannel,
    provider,
    mode
  ) =>
    mode !== "managed" &&
    original.isCustodyProviderInReleaseChannel(releaseChannel, provider, mode);
  return { ...original, isCustodyProviderInReleaseChannel };
});

const ORGANIZATION_ID = "org_managed_release_channel";
const PROJECT_ID = "prj_managed_release_channel";
const USER_ID = "usr_managed_release_channel";
const PRIVY_CONFIG_ID = "cust_managed_channel_privy";
const ANCHORAGE_CONFIG_ID = "cust_managed_channel_anchorage";
const API_KEY = {
  id: "key_managed_release_channel",
  raw: "sk_test_managed_release_channel",
  prefix: "sk_test_mrc",
};
const CACHED_API_KEY: CachedApiKey = {
  id: API_KEY.id,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};
const PUBLIC_KEYS = {
  privyA: "11111111111111111111111111111111",
  privyB: "So11111111111111111111111111111111111111112",
  anchorage: "Vote111111111111111111111111111111111111111",
} as const;

describe("Managed custody out of the release channel", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", vi.fn());
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedFixture();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await clearKVStores(env);
  });

  it("lists Managed wallets as not executable", async () => {
    const response = await get("/v1/wallets");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        wallets: [
          configWallet({
            id: "cwlt_managed_channel_privy_a",
            custodyConfigId: PRIVY_CONFIG_ID,
            provider: "privy",
            isDefaultProvider: true,
            walletId: "privy_managed_channel_a",
            publicKey: PUBLIC_KEYS.privyA,
          }),
          configWallet({
            id: "cwlt_managed_channel_privy_b",
            custodyConfigId: PRIVY_CONFIG_ID,
            provider: "privy",
            isDefaultProvider: true,
            walletId: "privy_managed_channel_b",
            publicKey: PUBLIC_KEYS.privyB,
          }),
          configWallet({
            id: "cwlt_managed_channel_anchorage",
            custodyConfigId: ANCHORAGE_CONFIG_ID,
            provider: "anchorage",
            isDefaultProvider: false,
            walletId: "anchorage_managed_channel",
            publicKey: PUBLIC_KEYS.anchorage,
          }),
        ],
      },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
  });

  it("refuses Config wallet deletion before any Provider call", async () => {
    const response = await send("/v1/wallets", "DELETE", {
      walletId: "anchorage_managed_channel",
      provider: "anchorage",
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(channelRefusalBody("anchorage"));
    expect(
      await getDb(env).queryOne("SELECT status FROM custody_wallets WHERE id = ?", [
        "cwlt_managed_channel_anchorage",
      ])
    ).toEqual({ status: "active" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await auditRows()).toEqual([]);
  });

  it("refuses API-key Config wallet provisioning before any Provider call or row", async () => {
    const response = await send(`/v1/projects/${PROJECT_ID}/api-keys`, "POST", {
      name: "Managed out of channel key",
      walletScope: "selected",
      provisionWallet: true,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(channelRefusalBody("privy"));
    expect(await getDb(env).queryMany("SELECT id FROM custody_wallets ORDER BY id")).toEqual([
      { id: "cwlt_managed_channel_anchorage" },
      { id: "cwlt_managed_channel_privy_a" },
      { id: "cwlt_managed_channel_privy_b" },
    ]);
    expect(
      await getDb(env).queryMany("SELECT id FROM api_keys WHERE name = ?", [
        "Managed out of channel key",
      ])
    ).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

async function get(path: string) {
  return app.request(path, { headers: { Authorization: `Bearer ${API_KEY.raw}` } }, env);
}

async function send(path: string, method: "POST" | "DELETE", body: Record<string, unknown>) {
  return app.request(
    path,
    {
      method,
      headers: { Authorization: `Bearer ${API_KEY.raw}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env
  );
}

function channelRefusalBody(provider: CustodyProvider) {
  return {
    error: {
      code: "FORBIDDEN",
      message: custodyProviderNotInReleaseChannel(provider, "managed").message,
    },
    meta: { requestId: expect.any(String) },
  };
}

function configWallet(wallet: {
  id: string;
  custodyConfigId: string;
  provider: CustodyProvider;
  isDefaultProvider: boolean;
  walletId: string;
  publicKey: string;
}) {
  return {
    ...wallet,
    isRuntimeExecutionAllowed: false,
    label: null,
    purpose: null,
    status: "active",
    createdAt: expect.any(String),
  };
}

async function auditRows() {
  return getDb(env).queryMany("SELECT id FROM audit_logs WHERE organization_id = ?", [
    ORGANIZATION_ID,
  ]);
}

async function seedFixture(): Promise<void> {
  const db = getDb(env);
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, CACHED_API_KEY);
  await db.execute(
    `INSERT INTO organizations (id, name, slug, tier, status)
     VALUES (?, 'Managed release channel', 'managed-release-channel', 'enterprise', 'active')`,
    [ORGANIZATION_ID]
  );
  await db.execute(
    `INSERT INTO users (id, email, email_verified, status)
     VALUES (?, 'managed-release-channel@example.com', 1, 'active')`,
    [USER_ID]
  );
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [],
    ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
  });
  await db.execute(
    `INSERT INTO api_keys
       (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
        role, permissions, status)
     VALUES (?, ?, ?, ?, 'Admin', ?, ?, 'api_admin', '["*"]', 'active')`,
    [API_KEY.id, ORGANIZATION_ID, PROJECT_ID, USER_ID, API_KEY.prefix, keyHash]
  );
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: PRIVY_CONFIG_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "privy",
        configEncrypted: "not-read",
        defaultWalletId: "privy_managed_channel_a",
        status: "active",
      },
      {
        id: ANCHORAGE_CONFIG_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "anchorage",
        configEncrypted: "not-read",
        defaultWalletId: "anchorage_managed_channel",
        status: "active",
      },
    ],
    wallets: [
      {
        id: "cwlt_managed_channel_privy_a",
        owner: { kind: "config", custodyConfigId: PRIVY_CONFIG_ID },
        walletId: "privy_managed_channel_a",
        publicKey: PUBLIC_KEYS.privyA,
        label: null,
        purpose: null,
        status: "active",
      },
      {
        id: "cwlt_managed_channel_privy_b",
        owner: { kind: "config", custodyConfigId: PRIVY_CONFIG_ID },
        walletId: "privy_managed_channel_b",
        publicKey: PUBLIC_KEYS.privyB,
        label: null,
        purpose: null,
        status: "active",
      },
      {
        id: "cwlt_managed_channel_anchorage",
        owner: { kind: "config", custodyConfigId: ANCHORAGE_CONFIG_ID },
        walletId: "anchorage_managed_channel",
        publicKey: PUBLIC_KEYS.anchorage,
        label: null,
        purpose: null,
        status: "active",
      },
    ],
    scopeDefaults: [
      {
        id: "csd_managed_release_channel",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        defaultCustodyConfigId: PRIVY_CONFIG_ID,
        defaultCustodyConnectionId: null,
      },
    ],
  });
}
