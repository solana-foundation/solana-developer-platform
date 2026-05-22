import type { CachedApiKey } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { hashString } from "@/lib/hash";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVNamespaces, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_ORG = {
  id: "org_custody_self_hosted",
  name: "Custody Self-Hosted Org",
  slug: "custody-self-hosted",
};
const TEST_USER = {
  id: "usr_custody_self_hosted",
  email: "custody-self-hosted@example.com",
};
const TEST_API_KEY = {
  id: "key_custody_self_hosted",
  raw: "sk_test_custody_self_hosted",
  prefix: "sk_test_cus",
};
const TEST_CACHED_API_KEY: CachedApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: null,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

const LOCAL_CUSTODY_PRIVATE_KEY = "local-custody-test-private-key";

let originalDeploymentMode: "managed" | "self_hosted" | undefined;
let originalCustodyPrivateKey: string | undefined;
let originalManagedProviderEnv: Record<string, string | undefined>;

const managedCustodyProviderEnvKeys = [
  "FIREBLOCKS_API_KEY",
  "FIREBLOCKS_API_SECRET",
  "PRIVY_APP_ID",
  "PRIVY_APP_SECRET",
  "COINBASE_CDP_API_KEY_ID",
  "COINBASE_CDP_API_KEY_SECRET",
  "COINBASE_CDP_WALLET_SECRET",
  "PARA_API_KEY",
  "TURNKEY_API_PUBLIC_KEY",
  "TURNKEY_API_PRIVATE_KEY",
  "TURNKEY_ORGANIZATION_ID",
  "DFNS_AUTH_TOKEN",
  "DFNS_CREDENTIAL_ID",
  "DFNS_PRIVATE_KEY",
  "ANCHORAGE_API_KEY",
] as const;

function readManagedProviderEnv(): Record<string, string | undefined> {
  const record = env as unknown as Record<string, string | undefined>;
  return Object.fromEntries(managedCustodyProviderEnvKeys.map((key) => [key, record[key]]));
}

function writeManagedProviderEnv(values: Record<string, string | undefined>): void {
  const record = env as unknown as Record<string, string | undefined>;
  for (const key of managedCustodyProviderEnvKeys) {
    record[key] = values[key];
  }
}

function clearManagedProviderEnv(): void {
  writeManagedProviderEnv({});
}

async function seedAuth(tier: "individual" | "enterprise" = "individual"): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);

  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, tier, "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(TEST_USER.id, TEST_USER.email, 1, "active"),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, environment, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        null,
        TEST_USER.id,
        "Self-Hosted Custody Test Key",
        TEST_API_KEY.prefix,
        keyHash,
        "api_admin",
        JSON.stringify(["*"]),
        "sandbox",
        "active"
      ),
  ]);
}

describe("Custody routes — self-hosted deployment mode", () => {
  beforeEach(async () => {
    originalDeploymentMode = env.SDP_DEPLOYMENT_MODE;
    originalCustodyPrivateKey = env.CUSTODY_PRIVATE_KEY;
    originalManagedProviderEnv = readManagedProviderEnv();
    env.SDP_DEPLOYMENT_MODE = "self_hosted";
    env.CUSTODY_PRIVATE_KEY = LOCAL_CUSTODY_PRIVATE_KEY;
    clearManagedProviderEnv();
    await seedTestDatabase(env);
  });

  afterEach(async () => {
    env.SDP_DEPLOYMENT_MODE = originalDeploymentMode;
    env.CUSTODY_PRIVATE_KEY = originalCustodyPrivateKey;
    writeManagedProviderEnv(originalManagedProviderEnv);
    await clearTestDatabase(env);
    await clearKVNamespaces(env);
  });

  it("GET /v1/wallets/switch-options returns only the configured local provider", async () => {
    await seedAuth("individual");

    const res = await app.request(
      "/v1/wallets/switch-options",
      {
        method: "GET",
        headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { providers: Array<{ provider: string }> };
    };
    const providers = body.data.providers.map((p) => p.provider).sort();
    expect(providers).toEqual(["local"]);
  });

  it("POST /v1/wallets/initialize with a non-configured provider returns 403", async () => {
    await seedAuth("individual");

    const res = await app.request(
      "/v1/wallets/initialize",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({ provider: "dfns" }),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    // In self-hosted mode the message must NOT mention "enterprise tier"
    expect(body.error.message).not.toContain("enterprise tier");
    expect(body.error.message.toLowerCase()).toMatch(/dfns|not configured|disabled/);
  });
});

describe("Custody routes — managed-mode regression", () => {
  beforeEach(async () => {
    originalDeploymentMode = env.SDP_DEPLOYMENT_MODE;
    originalCustodyPrivateKey = env.CUSTODY_PRIVATE_KEY;
    originalManagedProviderEnv = readManagedProviderEnv();
    // Explicitly NOT self-hosted — verifies the bypass is gated by the flag
    env.SDP_DEPLOYMENT_MODE = undefined;
    env.CUSTODY_PRIVATE_KEY = LOCAL_CUSTODY_PRIVATE_KEY;
    clearManagedProviderEnv();
    await seedTestDatabase(env);
  });

  afterEach(async () => {
    env.SDP_DEPLOYMENT_MODE = originalDeploymentMode;
    env.CUSTODY_PRIVATE_KEY = originalCustodyPrivateKey;
    writeManagedProviderEnv(originalManagedProviderEnv);
    await clearTestDatabase(env);
    await clearKVNamespaces(env);
  });

  it("rejects local custody on individual tier even when CUSTODY_PRIVATE_KEY is set", async () => {
    // local is absent from INDIVIDUAL_PROVIDER_DEFAULTS.custody — must stay disabled
    // in managed mode regardless of env config. Pin this behavior so a future
    // refactor that flips the SDP_DEPLOYMENT_MODE default is caught immediately.
    await seedAuth("individual");

    const res = await app.request(
      "/v1/wallets/initialize",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({ provider: "local" }),
      },
      env
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("enterprise tier");
  });
});
