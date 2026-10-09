import { generateKeyPairSigner } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import type { ApiKeyContext } from "@/lib/auth";
import * as solanaServices from "@/services/solana";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { seedTestPrivyConnection } from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  createLegacyResolvedAuthoritySigner,
  resolveAuthorityWallet,
  resolveIssuanceWallet,
} from "./authority-resolution";

const ORGANIZATION_ID = "org_issuance_project_scope";
const USER_ID = "usr_issuance_project_scope";
const REQUESTER_PROJECT_ID = "prj_issuance_project_scope";
const OWNER_PROJECT_ID = "prj_issuance_project_scope_production";
const OTHER_ORGANIZATION_ID = "org_issuance_project_scope_other";
const OTHER_ORGANIZATION_SANDBOX_PROJECT_ID = "prj_issuance_project_scope_other_sandbox";
const OWNER_CONFIG_ID = "cfg_issuance_project_scope_owner";
const REQUESTER_CONFIG_ID = "cfg_issuance_project_scope_requester";
const SHARED_AUTHORITY = TEST_SOLANA_ADDRESSES.wallet1;

const OWNER_WALLETS = [
  {
    owner: "config",
    organizationId: OTHER_ORGANIZATION_ID,
    projectId: OTHER_ORGANIZATION_SANDBOX_PROJECT_ID,
    custodyWalletId: "cwlt_issuance_scope_owner_config",
    providerWalletId: "wal_issuance_scope_owner_config",
    publicKey: TEST_SOLANA_ADDRESSES.wallet2,
  },
  {
    owner: "connection",
    organizationId: ORGANIZATION_ID,
    projectId: OWNER_PROJECT_ID,
    custodyWalletId: "cwlt_issuance_scope_owner_connection",
    providerWalletId: "wal_issuance_scope_owner_connection",
    publicKey: SHARED_AUTHORITY,
  },
] as const;

const REQUESTER_WALLET = {
  custodyWalletId: "cwlt_issuance_scope_requester",
  providerWalletId: "wal_issuance_scope_requester",
  publicKey: SHARED_AUTHORITY,
};

function clerkAuth(organizationId: string, projectId: string): ApiKeyContext {
  return {
    id: USER_ID,
    organizationId,
    projectId,
    role: "admin",
    permissions: ["*"],
    environment: "dashboard",
    walletScope: "all",
    signingWalletId: null,
    signingWalletIds: [],
    walletBindings: [],
    authType: "clerk",
    apiKeyId: null,
    userId: USER_ID,
  };
}

async function seedOwnerProjectCustody(): Promise<void> {
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: OWNER_CONFIG_ID,
        organizationId: OWNER_WALLETS[0].organizationId,
        projectId: OWNER_WALLETS[0].projectId,
        provider: "local",
        configEncrypted: "encrypted",
        status: "active",
      },
    ],
    wallets: [
      {
        id: OWNER_WALLETS[0].custodyWalletId,
        owner: { kind: "config", custodyConfigId: OWNER_CONFIG_ID },
        walletId: OWNER_WALLETS[0].providerWalletId,
        publicKey: OWNER_WALLETS[0].publicKey,
        label: null,
        purpose: "root",
        status: "active",
      },
    ],
  });
  await getDb(env).transaction((tx) =>
    seedTestPrivyConnection(tx, {
      organizationId: OWNER_WALLETS[1].organizationId,
      projectId: OWNER_WALLETS[1].projectId,
      connectionId: "cconn_issuance_project_scope_owner",
      credentialId: "pcred_issuance_project_scope_owner",
      createdBy: USER_ID,
      stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "ciphertext" },
      providerAccountFingerprint: "sha256:issuance-project-scope-owner",
      lastCheckStatus: "success",
      wallets: [
        {
          id: OWNER_WALLETS[1].custodyWalletId,
          walletId: OWNER_WALLETS[1].providerWalletId,
          publicKey: OWNER_WALLETS[1].publicKey,
          label: null,
          purpose: null,
          status: "active",
        },
      ],
      defaultCustodyWalletId: OWNER_WALLETS[1].custodyWalletId,
    })
  );
}

async function seedRequesterProjectWallet(): Promise<void> {
  await seedTestCustodyRows(env, {
    configs: [
      {
        id: REQUESTER_CONFIG_ID,
        organizationId: ORGANIZATION_ID,
        projectId: REQUESTER_PROJECT_ID,
        provider: "local",
        configEncrypted: "encrypted",
        status: "active",
      },
    ],
    wallets: [
      {
        id: REQUESTER_WALLET.custodyWalletId,
        owner: { kind: "config", custodyConfigId: REQUESTER_CONFIG_ID },
        walletId: REQUESTER_WALLET.providerWalletId,
        publicKey: REQUESTER_WALLET.publicKey,
        label: null,
        purpose: "root",
        status: "active",
      },
    ],
  });
}

describe("issuance authority resolution across an organization's projects", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(
          ORGANIZATION_ID,
          "Issuance Project Scope",
          "issuance-project-scope",
          "individual",
          "active"
        ),
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(
          OTHER_ORGANIZATION_ID,
          "Issuance Project Scope Other",
          "issuance-project-scope-other",
          "individual",
          "active"
        ),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
        .bind(USER_ID, "issuance-project-scope@example.com", 1, "active"),
    ]);
    await seedDefaultProjects(getDb(env), {
      organizationId: ORGANIZATION_ID,
      createdBy: USER_ID,
      members: [],
      ids: { sandbox: REQUESTER_PROJECT_ID, production: OWNER_PROJECT_ID },
    });
    await seedDefaultProjects(getDb(env), {
      organizationId: OTHER_ORGANIZATION_ID,
      createdBy: USER_ID,
      members: [],
      ids: {
        sandbox: OTHER_ORGANIZATION_SANDBOX_PROJECT_ID,
        production: "prj_issuance_project_scope_other_production",
      },
    });
    await seedOwnerProjectCustody();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(OWNER_WALLETS)(
    "resolves a $owner wallet only for the project that owns it",
    async ({ organizationId, projectId, custodyWalletId, providerWalletId, publicKey }) => {
      await expect(
        resolveIssuanceWallet({
          env,
          auth: clerkAuth(organizationId, projectId),
          custodyWalletId,
          requiredWalletPermissions: ["tokens:write"],
        })
      ).resolves.toEqual({ custodyWalletId, providerWalletId, publicKey });

      await expect(
        resolveIssuanceWallet({
          env,
          auth: clerkAuth(ORGANIZATION_ID, REQUESTER_PROJECT_ID),
          custodyWalletId,
          requiredWalletPermissions: ["tokens:write"],
        })
      ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    }
  );

  it("resolves an authority to the requester's own wallet when another project holds the same key", async () => {
    await seedRequesterProjectWallet();

    await expect(
      resolveAuthorityWallet({
        env,
        auth: clerkAuth(ORGANIZATION_ID, REQUESTER_PROJECT_ID),
        currentAuthority: SHARED_AUTHORITY,
        requiredWalletPermissions: ["tokens:write"],
      })
    ).resolves.toEqual(REQUESTER_WALLET);
  });

  it("does not resolve an authority held only by another project's wallet", async () => {
    await expect(
      resolveAuthorityWallet({
        env,
        auth: clerkAuth(ORGANIZATION_ID, REQUESTER_PROJECT_ID),
        currentAuthority: SHARED_AUTHORITY,
        requiredWalletPermissions: ["tokens:write"],
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      statusCode: 409,
      message: "Current authority is not controlled by custody",
    });
  });

  it("signs a legacy deploy with the named wallet from the requester's own project", async () => {
    await seedRequesterProjectWallet();
    const signer = await generateKeyPairSigner();
    const exactSigner = vi
      .spyOn(solanaServices, "createOrgSignerForCustodyWallet")
      .mockResolvedValue(signer);

    await expect(
      createLegacyResolvedAuthoritySigner({
        env,
        auth: clerkAuth(ORGANIZATION_ID, REQUESTER_PROJECT_ID),
        walletId: REQUESTER_WALLET.providerWalletId,
      })
    ).resolves.toBe(signer);
    expect(exactSigner).toHaveBeenCalledExactlyOnceWith(
      env,
      ORGANIZATION_ID,
      REQUESTER_PROJECT_ID,
      REQUESTER_WALLET.custodyWalletId,
      "issuance.authority"
    );
  });

  it("refuses a legacy deploy naming a wallet only another project holds", async () => {
    const exactSigner = vi.spyOn(solanaServices, "createOrgSignerForCustodyWallet");

    await expect(
      createLegacyResolvedAuthoritySigner({
        env,
        auth: clerkAuth(ORGANIZATION_ID, REQUESTER_PROJECT_ID),
        walletId: OWNER_WALLETS[1].providerWalletId,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(exactSigner).not.toHaveBeenCalled();
  });

  it("refuses a legacy deploy that names no wallet before any signer is loaded", async () => {
    await seedRequesterProjectWallet();
    const exactSigner = vi.spyOn(solanaServices, "createOrgSignerForCustodyWallet");

    await expect(
      createLegacyResolvedAuthoritySigner({
        env,
        auth: clerkAuth(ORGANIZATION_ID, REQUESTER_PROJECT_ID),
        walletId: null,
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      statusCode: 400,
      message: "signingWalletId is required for the legacy issuance prepare flow",
    });
    expect(exactSigner).not.toHaveBeenCalled();
  });
});
