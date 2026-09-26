import type { RingsGatewayPort } from "@sdp/helius-rings";
import { HeliusRingsError } from "@sdp/helius-rings";
import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { getBase64Codec } from "@solana/codecs";
import { PrivySigner } from "@solana/keychain-privy";
import type { SignatureBytes } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createHeliusRingsWalletRepository } from "@/db/repositories";
import app from "@/index";
import { createCredentialSecretStore } from "@/services/credential-secret-store";
import { createCustodyCipher } from "@/services/custody-cipher/cipher-router";
import { signRingsMessage } from "@/services/helius-rings/signer-adapter";
import { ProviderCredentialStore } from "@/services/stores/provider-credential.store";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

/**
 * Provisioning a Rings wallet over a connection-owned custody wallet.
 *
 * Regression (SOLA9-642): the route accepted a `payments:write` key bound to an
 * active connection-owned custody wallet, but the production signer resolved
 * the owner through the config-only store, so provisioning failed with
 * WALLET_NOT_FOUND and left the Rings row `pending` forever. The gateway stub
 * below is the only fake: its provisioning call goes through the REAL
 * signer-adapter, so a `ready` row here proves the production signer resolved
 * the connection-owned owner. The config-owned control wallet in the same
 * fixture guards the compatible path.
 */

const gatewayOverride = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/services/helius-rings/gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/helius-rings/gateway")>();
  return {
    ...actual,
    resolvePersistedRingsGateway: (
      ...args: Parameters<typeof actual.resolvePersistedRingsGateway>
    ) =>
      (gatewayOverride.current as RingsGatewayPort | null) ??
      actual.resolvePersistedRingsGateway(...args),
  };
});

const ORG = { id: "org_rings_conn", name: "Rings Connection Org", slug: "rings-connection-org" };
const PROJECT_ID = "prj_rings_conn";
const USER_ID = "usr_rings_conn";
const CONNECTION_ID = "cconn_rings_conn";
const CREDENTIAL_ID = "pcred_rings_conn";
const CONNECTION_CUSTODY_WALLET_ID = "cwlt_rings_conn_owner";
const CONNECTION_PROVIDER_WALLET_ID = "privy_rings_conn_wallet";
const CONFIG_CUSTODY_WALLET_ID = "cwlt_rings_conn_config";
const CONFIG_PROVIDER_WALLET_ID = "privy_rings_conn_config_wallet";
/** Real devnet-format keys, as the custody rows would store them. */
const CONNECTION_OWNER = "9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz";
const CONFIG_OWNER = "8dHEsGLpCZHZbXnFVvqWq4kMfM2pVDuNrXvVJVhQWRGZ";
const API_KEY = { id: "key_rings_conn", raw: "sk_test_rings_conn", prefix: "sk_test_rconn" };

const CACHED_KEY: CachedApiKey = {
  id: API_KEY.id,
  organizationId: ORG.id,
  projectId: PROJECT_ID,
  role: "api_developer",
  permissions: ["payments:write"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: CONNECTION_PROVIDER_WALLET_ID,
  walletScope: "selected",
  walletBindings: [
    {
      walletId: CONNECTION_PROVIDER_WALLET_ID,
      custodyWalletId: CONNECTION_CUSTODY_WALLET_ID,
      permissions: ["payments:write"],
    },
    {
      walletId: CONFIG_PROVIDER_WALLET_ID,
      custodyWalletId: CONFIG_CUSTODY_WALLET_ID,
      permissions: ["payments:write"],
    },
  ],
  status: "active",
  expiresAt: null,
  organizationStatus: "active",
};

const SIGNATURE = new Uint8Array(64).fill(21) as SignatureBytes;
/** Arbitrary deterministic payload; the stub signs it through the real adapter. */
const DERIVATION_MESSAGE_BASE64 = "c3ludGhldGljLWRlcml2YXRpb24tZW52ZWxvcGU=";

/**
 * The gateway is the vendor boundary; everything under the signer is real. Its
 * provisioning call signs through the production signer-adapter, mapping
 * failures the way the real gateway's domain-failure boundary does: a
 * non-retryable adapter failure reads as the caller's invalid input, not an
 * outage.
 */
function stubGatewayProvisioningBySigning(): RingsGatewayPort {
  return {
    provisionIdentity: async (input: { walletId: string; sdpAddress: string }) => {
      try {
        await signRingsMessage({
          env,
          organizationId: ORG.id,
          projectId: PROJECT_ID,
          owner: input.sdpAddress,
          messageBase64: DERIVATION_MESSAGE_BASE64,
        });
      } catch (error) {
        if (error instanceof Error && "failureCode" in error) {
          const retryable = (error as { retryable?: boolean }).retryable === true;
          throw new HeliusRingsError(
            retryable ? "gateway_unavailable" : "invalid_input",
            "custody could not sign for this owner"
          );
        }
        throw error;
      }
      return {
        identity: { shieldedAddress: "rings1stub_connection", owner: input.sdpAddress },
        registrationSignatures: ["sig_stub"],
        materialTag: "simulated",
      };
    },
  } as unknown as RingsGatewayPort;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${API_KEY.raw}`,
    "Content-Type": "application/json",
  };
}

async function seedFixture(): Promise<void> {
  const db = getDb(env);
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, CACHED_KEY);

  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG.id, ORG.name, ORG.slug, "enterprise", "active"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER_ID, "rings-connection@example.com"),
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORG.id,
    createdBy: USER_ID,
    members: [],
    ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
  });
  await db
    .prepare(
      `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
       VALUES (?, ?, ?, ?, 'Rings connection key', ?, ?, 'api_developer', ?, 'active')`
    )
    .bind(
      API_KEY.id,
      ORG.id,
      PROJECT_ID,
      USER_ID,
      API_KEY.prefix,
      keyHash,
      JSON.stringify(["payments:write"])
    )
    .run();

  // A stored Privy credential whose payload really decrypts under the test
  // cipher key, so the connection path reaches the adapter with real secrets.
  env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
  const secretStore = createCredentialSecretStore(env, "encrypted_db");
  const secret = await secretStore.write({
    orgId: ORG.id,
    provider: "privy",
    providerCredentialId: CREDENTIAL_ID,
    payload: { appId: "rings-conn-app-id", appSecret: "rings-conn-app-secret" },
  });
  const credential = await new ProviderCredentialStore(db).insertCredential({
    id: CREDENTIAL_ID,
    organizationId: ORG.id,
    projectId: PROJECT_ID,
    provider: "privy",
    label: "Rings connection credential",
    scope: "project",
    source: "stored",
    stored: {
      storageBackend: "encrypted_db",
      encryptedSecretPayload: secret.encryptedSecretPayload,
    },
    displayMetadata: {},
    version: 1,
    rotatedFromId: null,
    idempotencyKey: CONNECTION_ID,
    idempotencyFingerprint: CONNECTION_ID,
    createdBy: USER_ID,
  });
  await db.execute("UPDATE provider_credentials SET status = 'active' WHERE id = ?", [
    credential.id,
  ]);

  // The connection-owned custody wallet, active under its connection. The
  // connection lands before its wallet row and activates only once the
  // default pointer exists, per the lifecycle check.
  await db
    .prepare(
      `INSERT INTO custody_connections
         (id, organization_id, project_id, provider, scope, provider_credential_id,
          provider_credential_scope_key, status, last_check_status, last_check_at,
          provider_account_fingerprint, created_by)
       VALUES (?, ?, ?, 'privy', 'project', ?, ?, 'pending', 'success', sdp_iso_now(),
               'sha256:rings-conn-account', ?)`
    )
    .bind(CONNECTION_ID, ORG.id, PROJECT_ID, credential.id, credential.scope_key, USER_ID)
    .run();
  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, custody_connection_id, wallet_id, public_key, status)
         VALUES (?, NULL, ?, ?, ?, 'active')`
      )
      .bind(
        CONNECTION_CUSTODY_WALLET_ID,
        CONNECTION_ID,
        CONNECTION_PROVIDER_WALLET_ID,
        CONNECTION_OWNER
      ),
    db
      .prepare(
        `UPDATE custody_connections
         SET status = 'active', default_custody_wallet_id = ?, activated_at = sdp_iso_now()
         WHERE id = ?`
      )
      .bind(CONNECTION_CUSTODY_WALLET_ID, CONNECTION_ID),
  ]);

  // The control: a config-owned custody wallet, the path that always worked.
  // Its encrypted config decrypts under the same test cipher key, so the real
  // config adapter factory can build the legacy-env Privy adapter.
  const configPayload = await createCustodyCipher(env).encrypt(
    ORG.id,
    JSON.stringify({ provider: "privy", walletId: CONFIG_PROVIDER_WALLET_ID })
  );
  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted,
            encryption_version, default_wallet_id, status)
         VALUES ('cfg_rings_conn', ?, ?, 'privy', ?, 'sdp-custody-encryption-v1', ?, 'active')`
      )
      .bind(ORG.id, PROJECT_ID, configPayload, CONFIG_PROVIDER_WALLET_ID),
    db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, custody_connection_id, wallet_id, public_key, status)
         VALUES (?, 'cfg_rings_conn', NULL, ?, ?, 'active')`
      )
      .bind(CONFIG_CUSTODY_WALLET_ID, CONFIG_PROVIDER_WALLET_ID, CONFIG_OWNER),
  ]);
}

describe("Rings provisioning over connection-owned custody wallets", () => {
  const original = {
    ringsFlag: env.HELIUS_RINGS_ENABLED,
    encryptionKey: env.CUSTODY_ENCRYPTION_KEY,
    privyAppId: env.PRIVY_APP_ID,
    privyAppSecret: env.PRIVY_APP_SECRET,
    privyByok: env.PRIVY_BYOK_ENABLED,
  };

  beforeEach(async () => {
    await seedTestDatabase(env);
    env.HELIUS_RINGS_ENABLED = "true";
    // The connection runtime is opt-in per deployment.
    env.PRIVY_BYOK_ENABLED = "true";
    // Legacy-env credential the config-owned control path resolves with.
    env.PRIVY_APP_ID = "rings-conn-app-id";
    env.PRIVY_APP_SECRET = "rings-conn-app-secret";
    await seedFixture();
    gatewayOverride.current = stubGatewayProvisioningBySigning();

    // The Privy adapter boundary is the only signer fake: the signer it
    // returns signs with the key the resolved custody row holds. Ids arrive
    // denormalized (the `privy_` prefix stripped).
    vi.spyOn(PrivySigner, "create").mockImplementation(async (config) => {
      const walletId = (config as { walletId?: string }).walletId ?? "";
      const address = walletId === "rings_conn_config_wallet" ? CONFIG_OWNER : CONNECTION_OWNER;
      return {
        address,
        signMessages: async (messages: unknown[]) => messages.map(() => ({ [address]: SIGNATURE })),
      } as never;
    });
  });

  afterEach(async () => {
    env.HELIUS_RINGS_ENABLED = original.ringsFlag;
    env.CUSTODY_ENCRYPTION_KEY = original.encryptionKey;
    env.PRIVY_APP_ID = original.privyAppId;
    env.PRIVY_APP_SECRET = original.privyAppSecret;
    env.PRIVY_BYOK_ENABLED = original.privyByok;
    gatewayOverride.current = null;
    vi.restoreAllMocks();
    await clearKVStores(env);
  });

  it("provisions a Rings wallet for a connection-owned custody wallet", async () => {
    const response = await app.request(
      "/v1/helius-rings/wallets",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ walletId: CONNECTION_PROVIDER_WALLET_ID, name: "Connection ops" }),
      },
      env
    );
    expect(response.status).toBe(201);

    const persisted = await createHeliusRingsWalletRepository(env).getWalletBySdpWalletId({
      organizationId: ORG.id,
      projectId: PROJECT_ID,
      sdpWalletId: CONNECTION_PROVIDER_WALLET_ID,
    });
    expect(persisted).toMatchObject({
      status: "ready",
      custody_wallet_id: CONNECTION_CUSTODY_WALLET_ID,
      owner_address: CONNECTION_OWNER,
    });
  });

  it("still provisions a config-owned custody wallet the way it always did", async () => {
    const response = await app.request(
      "/v1/helius-rings/wallets",
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ walletId: CONFIG_PROVIDER_WALLET_ID, name: "Config ops" }),
      },
      env
    );
    expect(response.status).toBe(201);

    const persisted = await createHeliusRingsWalletRepository(env).getWalletBySdpWalletId({
      organizationId: ORG.id,
      projectId: PROJECT_ID,
      sdpWalletId: CONFIG_PROVIDER_WALLET_ID,
    });
    expect(persisted).toMatchObject({
      status: "ready",
      custody_wallet_id: CONFIG_CUSTODY_WALLET_ID,
      owner_address: CONFIG_OWNER,
    });
  });

  it("refuses an owner no custody row in scope holds", async () => {
    // A key the tenant does not control: the resolver finds nothing on either
    // path and refuses without building a signer.
    const unowned = "BulfTIsSBJAcsXd0CZcEshYDDqLTYpf2sBkbT4SpoWJm";
    const base64 = getBase64Codec();
    await expect(
      signRingsMessage({
        env,
        organizationId: ORG.id,
        projectId: PROJECT_ID,
        owner: unowned,
        messageBase64: base64.decode(new Uint8Array([1, 2, 3])),
      })
    ).rejects.toMatchObject({ failureCode: "signer_failed", retryable: false });
  });
});
