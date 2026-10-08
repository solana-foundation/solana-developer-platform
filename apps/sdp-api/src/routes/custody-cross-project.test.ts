import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { getLogger } from "@/runtime/logger";
import { upsertApiKeyWalletBinding } from "@/services/api-key-wallets.service";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { seedProjectApiKey } from "@/test/helpers/api-keys";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { seedTestPrivyConnection } from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

const ORGANIZATION_ID = "org_custody_cross_project";
const USER_ID = "usr_custody_cross_project";
const REQUESTER_PROJECT_ID = "prj_custody_cross_project";
const OWNER_PROJECT_ID = "prj_custody_cross_project_production";
const OWNER_CONFIG_ID = "cust_cfg_cross_project_owner";
const REQUESTER_CONFIG_ID = "cust_cfg_cross_project_requester";
const REQUESTER_WALLET_ID = "privy_wallet_requester";
const API_KEY = {
  id: "key_custody_cross_project",
  raw: "sk_test_custody_cross_project",
  prefix: "sk_test_ccp",
};

const OWNER_WALLETS = [
  {
    owner: "config",
    walletId: "privy_wallet_owner",
    custodyWalletId: "cwlt_cross_project_owner",
  },
  {
    owner: "connection",
    walletId: "privy_wallet_owner_connection",
    custodyWalletId: "cwlt_cross_project_owner_connection",
  },
] as const;

async function seedOrganizationCustody(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(
        ORGANIZATION_ID,
        "Custody Cross Project Org",
        "custody-cross-project",
        "enterprise",
        "active"
      ),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER_ID, "custody-cross-project@example.com", 1, "active"),
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [USER_ID],
    ids: { sandbox: REQUESTER_PROJECT_ID, production: OWNER_PROJECT_ID },
  });
  await seedProjectApiKey(db, env, {
    key: API_KEY,
    organizationId: ORGANIZATION_ID,
    projectId: REQUESTER_PROJECT_ID,
    createdBy: USER_ID,
    role: "api_admin",
    permissions: ["*"],
  });
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: OWNER_CONFIG_ID,
        organizationId: ORGANIZATION_ID,
        projectId: OWNER_PROJECT_ID,
        provider: "privy",
        configEncrypted: "test-config",
        status: "active",
      },
      {
        id: REQUESTER_CONFIG_ID,
        organizationId: ORGANIZATION_ID,
        projectId: REQUESTER_PROJECT_ID,
        provider: "privy",
        configEncrypted: "test-config",
        status: "active",
      },
    ],
    wallets: [
      {
        id: "cwlt_cross_project_owner",
        owner: { kind: "config", custodyConfigId: OWNER_CONFIG_ID },
        walletId: "privy_wallet_owner",
        publicKey: TEST_SOLANA_ADDRESSES.wallet1,
        label: "Owner wallet",
        purpose: "root",
        status: "active",
      },
      {
        id: "cwlt_cross_project_requester",
        owner: { kind: "config", custodyConfigId: REQUESTER_CONFIG_ID },
        walletId: REQUESTER_WALLET_ID,
        publicKey: TEST_SOLANA_ADDRESSES.wallet3,
        label: "Requester wallet",
        purpose: "root",
        status: "active",
      },
    ],
  });
  await db.transaction((tx) =>
    seedTestPrivyConnection(tx, {
      organizationId: ORGANIZATION_ID,
      projectId: OWNER_PROJECT_ID,
      connectionId: "cconn_cross_project_owner",
      credentialId: "pcred_cross_project_owner",
      createdBy: USER_ID,
      stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "ciphertext" },
      providerAccountFingerprint: "sha256:cross-project-owner",
      lastCheckStatus: "success",
      wallets: [
        {
          id: "cwlt_cross_project_owner_connection",
          walletId: "privy_wallet_owner_connection",
          publicKey: TEST_SOLANA_ADDRESSES.wallet2,
          label: "Owner connection wallet",
          purpose: null,
          status: "active",
        },
      ],
      defaultCustodyWalletId: "cwlt_cross_project_owner_connection",
    })
  );
}

function requestAsRequester(path: string, init: { method: string; body?: unknown }) {
  return app.request(
    path,
    {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY.raw}`,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    env
  );
}

function errorBody(code: string, message: string) {
  return { error: { code, message }, meta: { requestId: expect.any(String) } };
}

async function readCustodyState() {
  const db = getDb(env);
  return {
    wallets: await db.queryMany("SELECT * FROM custody_wallets ORDER BY id"),
    configs: await db.queryMany("SELECT * FROM custody_configs ORDER BY id"),
    connections: await db.queryMany("SELECT * FROM custody_connections ORDER BY id"),
  };
}

describe("custody wallets across an organization's projects", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedOrganizationCustody();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearKVStores(env);
  });

  it.each(OWNER_WALLETS)(
    "hides another project's $owner wallet from public-key and wallet reads",
    async ({ walletId }) => {
      for (const path of [
        `/v1/wallets/public-key?walletId=${walletId}`,
        `/v1/wallets/${walletId}?includeBalance=false`,
      ]) {
        const response = await requestAsRequester(path, { method: "GET" });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual(errorBody("NOT_FOUND", "Wallet not found"));
      }
    }
  );

  it.each(OWNER_WALLETS)(
    "refuses a signer check on another project's $owner wallet",
    async ({ walletId }) => {
      const response = await requestAsRequester("/v1/wallets/signer-check", {
        method: "POST",
        body: { walletId },
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(errorBody("BAD_REQUEST", "Custody wallet not found"));
    }
  );

  it.each(OWNER_WALLETS)(
    "leaves another project's $owner wallet untouched by label and delete requests",
    async ({ walletId }) => {
      const before = await readCustodyState();

      const relabel = await requestAsRequester(`/v1/wallets/${walletId}`, {
        method: "PATCH",
        body: { label: "Cross-project label" },
      });
      expect(relabel.status).toBe(404);
      expect(await relabel.json()).toEqual(errorBody("NOT_FOUND", "Wallet not found"));

      const deletion = await requestAsRequester("/v1/wallets", {
        method: "DELETE",
        body: { provider: "privy", walletId },
      });
      expect(deletion.status).toBe(404);
      expect(await deletion.json()).toEqual(errorBody("NOT_FOUND", "Custody wallet not found"));

      expect(await readCustodyState()).toEqual(before);
    }
  );

  it.each(OWNER_WALLETS)(
    "refuses to bind a new API key to another project's $owner wallet",
    async ({ walletId }) => {
      const response = await requestAsRequester("/v1/api-keys", {
        method: "POST",
        body: { name: "Cross-project key", walletScope: "selected", signingWalletId: walletId },
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(
        errorBody("BAD_REQUEST", `Unknown signing wallet IDs: ${walletId}`)
      );
      expect(
        await getDb(env).queryMany("SELECT id FROM api_keys WHERE name = ?", ["Cross-project key"])
      ).toEqual([]);
    }
  );

  it.each(OWNER_WALLETS)(
    "hydrates a stored binding to another project's $owner wallet as deny-only and logs it",
    async ({ walletId }) => {
      await upsertApiKeyWalletBinding(getDb(env), API_KEY.id, {
        walletId,
        permissions: ["wallets:read"],
      });
      const warn = vi.spyOn(getLogger(), "warn");

      for (const requestedWalletId of [walletId, REQUESTER_WALLET_ID]) {
        const response = await requestAsRequester(
          `/v1/wallets/public-key?walletId=${requestedWalletId}`,
          { method: "GET" }
        );
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual(errorBody("NOT_FOUND", "Wallet not found"));
      }
      expect(warn).toHaveBeenCalledWith(
        {
          apiKeyId: API_KEY.id,
          organizationId: ORGANIZATION_ID,
          projectId: REQUESTER_PROJECT_ID,
          walletId,
          candidateCount: 0,
        },
        "api_key_wallet_binding_unresolved"
      );
    }
  );
});
