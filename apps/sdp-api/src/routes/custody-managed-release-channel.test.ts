import type { CustodyProvider } from "@sdp/types/custody";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { custodyProviderNotInReleaseChannel } from "@/services/provider-availability.service";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { type SeededApiKey, seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
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
const CACHED_API_KEY: SeededApiKey = {
  id: API_KEY.id,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  grants: ALL_API_KEY_GRANTS,
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
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
    custodyReleaseChannel.outOfChannelMode = "managed";
    // A dashboard session's token verifies against the local test issuer; every
    // other outbound call is a Provider call the tests assert never happens.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        isJwksRequest(input) ? realFetch(input, init) : Promise.resolve(new Response(null))
      )
    );
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
            id: "cwlt_managed_channel_anchorage",
            custodyConfigId: ANCHORAGE_CONFIG_ID,
            provider: "anchorage",
            walletId: "anchorage_managed_channel",
            publicKey: PUBLIC_KEYS.anchorage,
          }),
          configWallet({
            id: "cwlt_managed_channel_privy_a",
            custodyConfigId: PRIVY_CONFIG_ID,
            provider: "privy",
            walletId: "privy_managed_channel_a",
            publicKey: PUBLIC_KEYS.privyA,
          }),
          configWallet({
            id: "cwlt_managed_channel_privy_b",
            custodyConfigId: PRIVY_CONFIG_ID,
            provider: "privy",
            walletId: "privy_managed_channel_b",
            publicKey: PUBLIC_KEYS.privyB,
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

  it("returns the release-channel 403 for a Config wallet's public key", async () => {
    const response = await get("/v1/wallets/public-key?walletId=privy_managed_channel_a");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(channelRefusalBody("privy"));
    expect(fetch).not.toHaveBeenCalled();
  });
});

function isJwksRequest(input: Parameters<typeof fetch>[0]): boolean {
  const jwksUrl = env.CLERK_JWKS_URL;
  return (
    jwksUrl !== undefined &&
    String(input instanceof Request ? input.url : input).startsWith(jwksUrl)
  );
}

async function _sendAs(
  headers: Record<string, string>,
  path: string,
  body: Record<string, unknown>
) {
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) }, env);
}

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
      details: { reason: "custody_provider_not_in_release_channel" },
    },
    meta: { requestId: expect.any(String) },
  };
}

function configWallet(wallet: {
  id: string;
  custodyConfigId: string;
  provider: CustodyProvider;
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
  const keyHash = await seedProjectApiKey(db, env, {
    key: API_KEY,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    createdBy: USER_ID,
    grants: ALL_API_KEY_GRANTS,
  });
  await seedApiKeyRow(env, keyHash, CACHED_API_KEY);
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: PRIVY_CONFIG_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "privy",
        configEncrypted: "not-read",
        status: "active",
      },
      {
        id: ANCHORAGE_CONFIG_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "anchorage",
        configEncrypted: "not-read",
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
  });
}
