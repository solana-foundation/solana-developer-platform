import type { CachedApiKey, SdpEnvironment } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { getLogger } from "@/runtime/logger";
import * as custodyProvisioning from "@/services/custody/provisioning";
import { createSigningService } from "@/services/domain/signing.service";
import { createOrgSignerForCustodyWallet } from "@/services/solana/signer";
import { seedProjectApiKey, type TestApiKeyMaterial } from "@/test/helpers/api-keys";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const provisionPrivyWalletMock = vi.spyOn(custodyProvisioning, "provisionPrivyWallet");

const ORGANIZATION_ID = "org_managed_production_use";
const USER_ID = "usr_managed_production_use";
const PROJECT_IDS = {
  sandbox: "prj_managed_production_use_sandbox",
  production: "prj_managed_production_use_production",
} as const satisfies Record<SdpEnvironment, string>;
const API_KEYS = {
  sandbox: {
    id: "key_managed_production_use_sandbox",
    raw: "sk_test_managed_production_use",
    prefix: "sk_test_mpu",
  },
  production: {
    id: "key_managed_production_use_production",
    raw: "sk_live_managed_production_use",
    prefix: "sk_live_mpu",
  },
} as const satisfies Record<SdpEnvironment, TestApiKeyMaterial>;
const CONFIG_IDS = {
  sandbox: "cust_managed_production_use_sandbox",
  production: "cust_managed_production_use_production",
} as const satisfies Record<SdpEnvironment, string>;
const WALLET_RECORD_IDS = {
  sandbox: "cwlt_managed_production_use_sandbox",
  production: "cwlt_managed_production_use_production",
} as const satisfies Record<SdpEnvironment, string>;
const WALLET_IDS = {
  sandbox: "privy_managed_production_use_sandbox",
  production: "privy_managed_production_use_production",
} as const satisfies Record<SdpEnvironment, string>;
const PUBLIC_KEYS = {
  sandbox: "11111111111111111111111111111111",
  production: "So11111111111111111111111111111111111111112",
} as const satisfies Record<SdpEnvironment, string>;
const CREATED_PUBLIC_KEY = "Vote111111111111111111111111111111111111111";
const REFUSAL_MESSAGE = "Privy Managed custody is not allowed in a production project.";
const REFUSAL_BODY = {
  error: {
    code: "FORBIDDEN",
    message: REFUSAL_MESSAGE,
    details: { reason: "custody_mode_not_allowed" },
  },
  meta: { requestId: expect.any(String) },
};
const REFUSAL_ERROR = {
  code: "FORBIDDEN",
  statusCode: 403,
  message: REFUSAL_MESSAGE,
  details: { reason: "custody_mode_not_allowed" },
};
const REFUSAL_EVENT = "sdp_api_custody_use_refused";
const SEEDED_WALLET_ROWS = [
  { id: WALLET_RECORD_IDS.production },
  { id: WALLET_RECORD_IDS.sandbox },
];

const original = {
  encryptionKey: env.CUSTODY_ENCRYPTION_KEY,
  privyAppId: env.PRIVY_APP_ID,
  privyAppSecret: env.PRIVY_APP_SECRET,
};

describe("Managed custody use by project environment", () => {
  beforeEach(async () => {
    provisionPrivyWalletMock.mockReset();
    env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 29).toString("base64");
    env.PRIVY_APP_ID = "managed-production-use-app";
    env.PRIVY_APP_SECRET = "managed-production-use-secret";
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedFixture();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    env.CUSTODY_ENCRYPTION_KEY = original.encryptionKey;
    env.PRIVY_APP_ID = original.privyAppId;
    env.PRIVY_APP_SECRET = original.privyAppSecret;
    await clearKVStores(env);
  });

  it("refuses a Managed wallet in a Production project before any Provider call or row, and logs the refusal", async () => {
    const logger = getLogger();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    const response = await send("production", "/v1/wallets", { provider: "privy" });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(REFUSAL_BODY);
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(await walletRows()).toEqual(SEEDED_WALLET_ROWS);
    expect(warn.mock.calls.filter((call) => call[1] === REFUSAL_EVENT)).toEqual([
      [
        {
          event: REFUSAL_EVENT,
          organization_id: ORGANIZATION_ID,
          project_id: PROJECT_IDS.production,
          environment: "production",
          provider: "privy",
          mode: "managed",
          reason: "custody_mode_not_allowed",
        },
        REFUSAL_EVENT,
      ],
    ]);
    warn.mockRestore();
  });

  it("refuses API-key Managed wallet provisioning in a Production project before any Provider call, row or key", async () => {
    const response = await send("production", `/v1/projects/${PROJECT_IDS.production}/api-keys`, {
      name: "Managed production key",
      walletScope: "selected",
      provisionWallet: { provider: "privy" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(REFUSAL_BODY);
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(await walletRows()).toEqual(SEEDED_WALLET_ROWS);
    expect(
      await getDb(env).queryMany("SELECT id FROM api_keys WHERE name = ?", [
        "Managed production key",
      ])
    ).toEqual([]);
  });

  it("refuses the public key of an existing Managed wallet in a Production project", async () => {
    const response = await get(
      "production",
      `/v1/wallets/public-key?walletId=${WALLET_IDS.production}`
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(REFUSAL_BODY);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses runtime admission of an existing Managed wallet in a Production project", async () => {
    await expect(
      createSigningService(env).admitRuntimeExecution(
        ORGANIZATION_ID,
        PROJECT_IDS.production,
        WALLET_RECORD_IDS.production
      )
    ).rejects.toMatchObject(REFUSAL_ERROR);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a signer for an existing Managed wallet in a Production project before any Provider call", async () => {
    await expect(
      createOrgSignerForCustodyWallet(
        env,
        ORGANIZATION_ID,
        PROJECT_IDS.production,
        WALLET_RECORD_IDS.production
      )
    ).rejects.toMatchObject(REFUSAL_ERROR);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("creates, admits and reads Managed wallets in a Sandbox project", async () => {
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "managed_production_use_created",
      address: CREATED_PUBLIC_KEY,
    });

    const created = await send("sandbox", "/v1/wallets", { provider: "privy" });

    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      data: {
        wallet: {
          id: expect.any(String),
          custodyConfigId: CONFIG_IDS.sandbox,
          isRuntimeExecutionAllowed: true,
          walletId: "privy_managed_production_use_created",
          publicKey: CREATED_PUBLIC_KEY,
          label: null,
          purpose: null,
          status: "active",
          createdAt: expect.any(String),
        },
      },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
    await expect(
      createSigningService(env).admitRuntimeExecution(
        ORGANIZATION_ID,
        PROJECT_IDS.sandbox,
        WALLET_RECORD_IDS.sandbox
      )
    ).resolves.toBeUndefined();
    const publicKey = await get("sandbox", `/v1/wallets/public-key?walletId=${WALLET_IDS.sandbox}`);
    expect(publicKey.status).toBe(200);
    expect(await publicKey.json()).toEqual({
      data: { publicKey: PUBLIC_KEYS.sandbox },
      meta: { requestId: expect.any(String), timestamp: expect.any(String) },
    });
  });
});

function cachedApiKey(environment: SdpEnvironment): CachedApiKey {
  return {
    id: API_KEYS[environment].id,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_IDS[environment],
    role: "api_admin",
    permissions: ["*"],
    environment,
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
  };
}

async function get(environment: SdpEnvironment, path: string): Promise<Response> {
  return app.request(
    path,
    { headers: { Authorization: `Bearer ${API_KEYS[environment].raw}` } },
    env
  );
}

async function send(
  environment: SdpEnvironment,
  path: string,
  body: Record<string, unknown>
): Promise<Response> {
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEYS[environment].raw}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    env
  );
}

async function walletRows() {
  return getDb(env).queryMany("SELECT id FROM custody_wallets ORDER BY id");
}

async function seedFixture(): Promise<void> {
  const db = getDb(env);
  await db.execute(
    `INSERT INTO organizations (id, name, slug, tier, status)
     VALUES (?, 'Managed production use', 'managed-production-use', 'enterprise', 'active')`,
    [ORGANIZATION_ID]
  );
  await db.execute(
    `INSERT INTO users (id, email, email_verified, status)
     VALUES (?, 'managed-production-use@example.com', 1, 'active')`,
    [USER_ID]
  );
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [],
    ids: PROJECT_IDS,
  });
  for (const environment of ["sandbox", "production"] as const) {
    const keyHash = await seedProjectApiKey(db, env, {
      key: API_KEYS[environment],
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_IDS[environment],
      createdBy: USER_ID,
      role: "api_admin",
      permissions: ["*"],
    });
    await seedCachedApiKey(env, keyHash, cachedApiKey(environment));
  }
  await seedTestCustodyRows(env, {
    configs: (["sandbox", "production"] as const).map((environment) => ({
      id: CONFIG_IDS[environment],
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_IDS[environment],
      provider: "privy" as const,
      configEncrypted: JSON.stringify({ provider: "privy" }),
      status: "active" as const,
    })),
    wallets: (["sandbox", "production"] as const).map((environment) => ({
      id: WALLET_RECORD_IDS[environment],
      owner: { kind: "config" as const, custodyConfigId: CONFIG_IDS[environment] },
      walletId: WALLET_IDS[environment],
      publicKey: PUBLIC_KEYS[environment],
      label: null,
      purpose: null,
      status: "active" as const,
    })),
  });
}
