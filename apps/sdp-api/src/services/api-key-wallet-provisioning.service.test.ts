import { hashString } from "@sdp/payments/hash";
import { Context } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { app } from "@/index";
import * as custodyProvisioning from "@/services/custody/provisioning";
import { getOrCreateDvpSettlementWallet } from "@/services/dvp/settlement-wallet";
import { ALL_API_KEY_GRANTS } from "@/test/fixtures/api-keys";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { authenticateTestClerkUser, clerkHeaders } from "@/test/helpers/clerk";
import { insertTestCustodyConfigRow } from "@/test/helpers/custody";
import {
  insertTestCustodyConnection,
  insertTestStoredProviderCredential,
  seedTestPrivyConnection,
  writeTestPrivyCredentialSecret,
} from "@/test/helpers/custody-connections";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { required } from "@/test/helpers/required";
import { type SeededApiKey, seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";
import { provisionApiKeyWallet } from "./api-key-wallet-provisioning.service";

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

const provisionPrivyWalletMock = vi.spyOn(custodyProvisioning, "provisionPrivyWallet");
const ORGANIZATION_ID = "org_api_key_provisioning";
const PROJECT_ID = "prj_api_key_provisioning";
const CONNECTION_ID = "cconn_api_key_provisioning";
const MANAGED_CONFIG_ID = "cust_api_key_provisioning_privy";
const FOREIGN_PROJECT_ID = "prj_api_key_provisioning_foreign";
const FOREIGN_CONNECTION_ID = "cconn_api_key_provisioning_foreign";
const USER_ID = "usr_api_key_provisioning";
const CREDENTIAL_ID = "pcred_api_key_provisioning";
const FOREIGN_CREDENTIAL_ID = "pcred_api_key_provisioning_foreign";
const API_KEY = { id: "key_api_key_provisioning", raw: "sk_test_api_key_provisioning" };
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
const auditContext = new Context<{ Bindings: Env }>(new Request("http://localhost/wallets"), {
  env,
});
auditContext.set("apiKey", { ...CACHED_API_KEY, walletAccess: { scope: "all" } });

const original = {
  encryptionKey: env.CUSTODY_ENCRYPTION_KEY,
  privyAppId: env.PRIVY_APP_ID,
  privyAppSecret: env.PRIVY_APP_SECRET,
};

describe("provisionApiKeyWallet", () => {
  beforeEach(async () => {
    custodyReleaseChannel.outOfChannelMode = null;
    env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString("base64");
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedFixture();
  });

  afterEach(async () => {
    env.CUSTODY_ENCRYPTION_KEY = original.encryptionKey;
    env.PRIVY_APP_ID = original.privyAppId;
    env.PRIVY_APP_SECRET = original.privyAppSecret;
    vi.clearAllMocks();
    await clearKVStores(env);
  });

  it("provisions a DvP settlement wallet under the named Connection", async () => {
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "exact_api_key_wallet",
      address: TEST_SOLANA_ADDRESSES.wallet3,
    });

    const wallet = await provisionApiKeyWallet(getDb(env), env, {
      auditContext,
      creationReason: "dvp_settlement_authority",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      owner: { connectionId: CONNECTION_ID },
      label: "Settlement wallet",
      purpose: "dvp_settlement_authority",
    });

    expect(wallet.walletId).toBe("privy_exact_api_key_wallet");
    expect(
      await getDb(env)
        .prepare(
          `SELECT custody_connection_id, custody_config_id, label, purpose, status
           FROM custody_wallets WHERE id = ?`
        )
        .bind(wallet.id)
        .first()
    ).toEqual({
      custody_connection_id: CONNECTION_ID,
      custody_config_id: null,
      label: "Settlement wallet",
      purpose: "dvp_settlement_authority",
      status: "active",
    });
  });

  it("provisions a DvP settlement wallet under the named provider's Managed config", async () => {
    env.PRIVY_APP_ID = "api-key-provisioning-managed-app";
    env.PRIVY_APP_SECRET = "api-key-provisioning-managed-secret";
    await insertTestCustodyConfigRow(getDb(env), {
      id: MANAGED_CONFIG_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "privy",
      configEncrypted: JSON.stringify({ provider: "privy" }),
      status: "active",
    });
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "managed_settlement_wallet",
      address: TEST_SOLANA_ADDRESSES.wallet2,
    });

    const wallet = await provisionApiKeyWallet(getDb(env), env, {
      auditContext,
      creationReason: "dvp_settlement_authority",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      owner: { provider: "privy" },
      label: "Settlement wallet",
      purpose: "dvp_settlement_authority",
    });

    // Deployment credentials: no tenant Privy app is passed to the provider call.
    expect(provisionPrivyWalletMock).toHaveBeenCalledExactlyOnceWith(env, {});
    expect(wallet.walletId).toBe("privy_managed_settlement_wallet");
    expect(
      await getDb(env).queryOne(
        `SELECT custody_connection_id, custody_config_id, public_key, label, purpose, status
         FROM custody_wallets WHERE id = ?`,
        [wallet.id]
      )
    ).toEqual({
      custody_connection_id: null,
      custody_config_id: MANAGED_CONFIG_ID,
      public_key: TEST_SOLANA_ADDRESSES.wallet2,
      label: "Settlement wallet",
      purpose: "dvp_settlement_authority",
      status: "active",
    });
  });

  it("audits first-use DVP wallet creation with its initiating actor, and does not create on reuse", async () => {
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "dvp_settlement",
      address: TEST_SOLANA_ADDRESSES.wallet3,
    });
    const scope = { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID };
    const first = await getOrCreateDvpSettlementWallet(env, auditContext, scope);
    expect(await getOrCreateDvpSettlementWallet(env, auditContext, scope)).toEqual(first);
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
    const audits = await getDb(env).queryMany<{
      api_key_id: string;
      resource_id: string;
      metadata: string;
    }>(
      "SELECT api_key_id, resource_id, metadata FROM audit_logs WHERE resource_type = 'custody_wallet' AND action = 'create'"
    );
    expect(audits).toHaveLength(1);
    const audit = required(audits[0]);
    expect(audit).toMatchObject({ api_key_id: API_KEY.id, resource_id: first.custodyWalletId });
    const metadata = z
      .object({
        result: z.string(),
        creationReason: z.string(),
        connectionId: z.string(),
      })
      .passthrough()
      .parse(JSON.parse(audit.metadata));
    expect(metadata).toMatchObject({
      result: "created",
      creationReason: "dvp_settlement_authority",
      connectionId: CONNECTION_ID,
    });
    expect(metadata).not.toHaveProperty("assignedSettlementAuthority");
  });

  it.each([
    [
      "missing",
      "missing_connection",
      null,
      { code: "NOT_FOUND", message: "Custody Connection not found" },
    ],
    [
      "another project's",
      FOREIGN_CONNECTION_ID,
      null,
      { code: "NOT_FOUND", message: "Custody Connection not found" },
    ],
    [
      "out-of-channel",
      CONNECTION_ID,
      "byok",
      { code: "FORBIDDEN", details: { reason: "custody_provider_not_in_release_channel" } },
    ],
  ] as const)(
    "refuses a %s Connection before Provider I/O",
    async (_, connectionId, outOfChannelMode, refusal) => {
      custodyReleaseChannel.outOfChannelMode = outOfChannelMode;
      const walletsBefore = await getDb(env).queryOne(
        "SELECT COUNT(*) AS count FROM custody_wallets"
      );

      await expect(
        provisionApiKeyWallet(getDb(env), env, {
          auditContext,
          creationReason: "dvp_settlement_authority",
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          owner: { connectionId },
          purpose: "dvp_settlement_authority",
        })
      ).rejects.toMatchObject(refusal);

      expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
      expect(await getDb(env).queryOne("SELECT COUNT(*) AS count FROM custody_wallets")).toEqual(
        walletsBefore
      );
    }
  );

  it("refuses an unusable exact Connection before Provider I/O", async () => {
    await getDb(env)
      .prepare("UPDATE provider_credentials SET status = 'failed_validation' WHERE id = ?")
      .bind(CREDENTIAL_ID)
      .run();

    await expect(
      provisionApiKeyWallet(getDb(env), env, {
        auditContext,
        creationReason: "dvp_settlement_authority",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        owner: { connectionId: CONNECTION_ID },
        purpose: "dvp_settlement_authority",
      })
    ).rejects.toMatchObject({ code: "CONFLICT", message: "Custody Connection is unavailable" });
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
  });

  it("binds an existing Connection wallet while its BYOK pair is out of channel", async () => {
    custodyReleaseChannel.outOfChannelMode = "byok";

    const response = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({
          name: "Existing Connection wallet key",
          grants: ["transfers.read"],
          walletScope: "selected",
          walletIds: ["cwlt_api_key_provisioning_default"],
        }),
      },
      env
    );

    expect(response.status).toBe(201);
    const body = z
      .object({ data: z.object({ apiKey: z.object({ id: z.string() }) }) })
      .parse(await response.json());
    expect(
      await getDb(env)
        .prepare(
          `SELECT custody_wallet_id
           FROM api_key_signing_wallets
           WHERE api_key_id = ?`
        )
        .bind(body.data.apiKey.id)
        .first()
    ).toEqual({ custody_wallet_id: "cwlt_api_key_provisioning_default" });
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
  });
});

/** Keys are created by a signed-in organization admin, never a key (HOO-2099). */
let adminToken: string;

function adminHeaders(): Record<string, string> {
  return clerkHeaders(adminToken, PROJECT_ID);
}

async function seedFixture(): Promise<void> {
  const db = getDb(env);
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  await seedApiKeyRow(env, keyHash, CACHED_API_KEY);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(
        ORGANIZATION_ID,
        "API key provisioning",
        "api-key-provisioning",
        "enterprise",
        "active"
      ),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER_ID, "api-key-provisioning@example.com"),
  ]);
  ({ token: adminToken } = await authenticateTestClerkUser(env, db, {
    userId: USER_ID,
    email: "api-key-provisioning@example.com",
    clerkUserId: `clerk_${USER_ID}`,
    organizationId: ORGANIZATION_ID,
    clerkOrgId: `clerk_${ORGANIZATION_ID}`,
    orgSlug: "api-key-provisioning",
    role: "admin",
  }));
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [USER_ID],
    ids: { sandbox: PROJECT_ID, production: FOREIGN_PROJECT_ID },
  });
  const stored = await writeTestPrivyCredentialSecret(env, {
    organizationId: ORGANIZATION_ID,
    credentialId: CREDENTIAL_ID,
    appId: "api-key-provisioning-app",
    appSecret: "api-key-provisioning-secret",
  });
  await db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
          grants, status)
       VALUES (?, ?, ?, ?, 'Admin', 'sk_test_api', ?, ?, 'active')`,
      [API_KEY.id, ORGANIZATION_ID, PROJECT_ID, USER_ID, keyHash, ALL_API_KEY_GRANTS]
    );
    await seedTestPrivyConnection(tx, {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      connectionId: CONNECTION_ID,
      credentialId: CREDENTIAL_ID,
      createdBy: USER_ID,
      stored,
      providerAccountFingerprint: `sha256:${CREDENTIAL_ID}`,
      lastCheckStatus: "success",
      wallets: [
        {
          id: "cwlt_api_key_provisioning_default",
          walletId: "privy_api_key_default",
          publicKey: TEST_SOLANA_ADDRESSES.wallet1,
          label: "Default",
          purpose: null,
          status: "active",
        },
      ],
      defaultCustodyWalletId: "cwlt_api_key_provisioning_default",
    });
    await insertTestStoredProviderCredential(tx, {
      id: FOREIGN_CREDENTIAL_ID,
      organizationId: ORGANIZATION_ID,
      projectId: FOREIGN_PROJECT_ID,
      provider: "privy",
      label: "Privy",
      stored,
      displayMetadata: {},
      status: "pending",
      credentialVersion: 1,
      rotatedFromProviderCredentialId: null,
      lastValidatedAt: null,
      deactivatedAt: null,
      createdBy: USER_ID,
    });
    await insertTestCustodyConnection(tx, {
      id: FOREIGN_CONNECTION_ID,
      organizationId: ORGANIZATION_ID,
      projectId: FOREIGN_PROJECT_ID,
      provider: "privy",
      credential: { id: FOREIGN_CREDENTIAL_ID, projectId: FOREIGN_PROJECT_ID },
      status: "pending",
      setupMetadata: {},
      providerAccountFingerprint: null,
      lastCheckStatus: null,
      lastCheckAt: null,
      lastCheckFailureCode: null,
      activatedAt: null,
      deactivatedAt: null,
      createdBy: USER_ID,
      createdAt: new Date().toISOString(),
    });
  });
}
