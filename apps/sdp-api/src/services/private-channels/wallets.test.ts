import { PrivateChannelError } from "@sdp/private-channels";
import * as authPkg from "@sdp/private-channels/auth";
import { PrivySigner } from "@solana/keychain-privy";
import { address, signatureBytes } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import * as repositories from "@/db/repositories";
import type { ApiKeyContext } from "@/lib/auth";
import { getPrivyProviderAccountFingerprint } from "@/services/custody/privy-credential";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import * as gatewayAuth from "./auth/gateway-auth";
import * as spcSession from "./auth/spc-session";
import {
  deletePrivateChannelWallet,
  revokePrivateChannelPrincipalWallets,
  verifyPrivateChannelWallet,
} from "./wallets";

// Uses vi.spyOn (+ restoreAllMocks) rather than a module-level vi.mock of
// widely-used modules like @/db/repositories: spies are transient and restored
// per test, so this file's mocking cannot reach any other.

const PUBKEY = address("So11111111111111111111111111111111111111112");
const WALLET_ID = "wal_1";

const auth: ApiKeyContext = {
  id: "usr_1",
  organizationId: "org_1",
  projectId: "prj_1",
  userId: "usr_1",
  apiKeyId: null,
  authType: "session",
  role: "session",
  environment: "sandbox",
  permissions: ["*"],
  signingWalletId: null,
  signingWalletIds: [],
  walletBindings: [],
};
const keyAuth: ApiKeyContext = {
  ...auth,
  id: "key_pc_verify",
  authType: "api_key",
  apiKeyId: "key_pc_verify",
  userId: null,
  role: "api_admin",
  walletScope: "all",
};

const instance = {
  id: "pci_1",
  organization_id: "org_1",
  project_id: "prj_1",
  auth_url: "http://auth.local:8903",
} as unknown as repositories.PrivateChannelInstanceRow;

const pcUser = {
  id: "pcu_1",
  instance_id: "pci_1",
  disabled_at: null,
} as unknown as repositories.PrivateChannelUserRow;

const originalPrivy = { appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET };
let originalByok: string | undefined;

let client: {
  challengeWallet: ReturnType<typeof vi.fn>;
  verifyWallet: ReturnType<typeof vi.fn>;
  deleteWallet: ReturnType<typeof vi.fn>;
  login: ReturnType<typeof vi.fn>;
};
let verifiedRepo: {
  upsert: ReturnType<typeof vi.fn>;
  recordPendingRevocation: ReturnType<typeof vi.fn>;
  listPendingRevocations: ReturnType<typeof vi.fn>;
  deletePendingRevocation: ReturnType<typeof vi.fn>;
  deleteByUserInstanceAndPubkey: ReturnType<typeof vi.fn>;
  findByInstanceAndPubkey: ReturnType<typeof vi.fn>;
  listByUserAndInstance: ReturnType<typeof vi.fn>;
};
let principalRepo: {
  findDefaultPrincipal: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
};
let signMessages: ReturnType<typeof vi.fn<PrivySigner["signMessages"]>>;

beforeEach(async () => {
  originalByok = env.PRIVY_BYOK_ENABLED;
  await seedTestDatabase(env);
  env.PRIVY_APP_ID = "pc-verification-app";
  env.PRIVY_APP_SECRET = "pc-verification-secret";
  const db = getDb(env);
  await db.batch([
    db.prepare(
      "INSERT INTO organizations (id, name, slug, tier, status) VALUES ('org_1', 'PC', 'pc-verify', 'enterprise', 'active')"
    ),
    db.prepare(
      "INSERT INTO users (id, email, status) VALUES ('usr_1', 'pc-verify@example.com', 'active')"
    ),
    db.prepare(
      "INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by) VALUES ('prj_1', 'org_1', 'PC', 'pc-verify', 'sandbox', 'active', 'usr_1')"
    ),
    db
      .prepare(
        "INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, default_wallet_id, status) VALUES ('cfg_verify', 'org_1', 'prj_1', 'privy', '{}', ?, 'active')"
      )
      .bind(WALLET_ID),
    db
      .prepare(
        "INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status) VALUES ('cw_verify', 'cfg_verify', ?, ?, 'active')"
      )
      .bind(WALLET_ID, PUBKEY),
    db.prepare(`INSERT INTO api_keys
      (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
      VALUES ('key_pc_verify', 'org_1', 'prj_1', 'usr_1', 'PC verification', 'pcverify', 'pcverify', 'api_admin', NULL, 'active')`),
  ]);
  verifiedRepo = {
    upsert: vi.fn().mockResolvedValue({
      id: "pcvw_1",
      wallet_id: WALLET_ID,
      pubkey: PUBKEY,
      verified_at: "2026-07-20T00:00:00Z",
    }),
    recordPendingRevocation: vi.fn().mockResolvedValue({
      id: "pcvw_cleanup",
      wallet_id: WALLET_ID,
      pubkey: PUBKEY,
    }),
    listPendingRevocations: vi.fn().mockResolvedValue([]),
    deletePendingRevocation: vi.fn().mockResolvedValue(false),
    deleteByUserInstanceAndPubkey: vi.fn().mockResolvedValue(true),
    findByInstanceAndPubkey: vi.fn().mockResolvedValue({
      id: "pcvw_1",
      organization_id: "org_1",
      project_id: "prj_1",
      user_id: "pcu_1",
      instance_id: "pci_1",
      wallet_id: WALLET_ID,
      pubkey: PUBKEY,
    }),
    listByUserAndInstance: vi.fn().mockResolvedValue([]),
  };
  principalRepo = {
    findDefaultPrincipal: vi.fn().mockResolvedValue(pcUser),
    getById: vi.fn().mockResolvedValue(pcUser),
  };
  client = {
    challengeWallet: vi
      .fn()
      .mockResolvedValue({ message: "sign me", nonce: "n1", expires_at: "l" }),
    verifyWallet: vi.fn().mockResolvedValue({ pubkey: PUBKEY, created_at: "x" }),
    deleteWallet: vi.fn().mockResolvedValue(undefined),
    login: vi.fn(),
  };
  signMessages = vi
    .fn<PrivySigner["signMessages"]>()
    .mockResolvedValue([{ [PUBKEY]: signatureBytes(new Uint8Array(64)) }]);

  vi.spyOn(repositories, "createPrivateChannelInstanceRepository").mockReturnValue({
    getActiveByProject: vi.fn().mockResolvedValue(instance),
  } as never);
  vi.spyOn(repositories, "createPrivateChannelUserRepository").mockReturnValue({
    ...principalRepo,
  } as never);
  vi.spyOn(repositories, "createPrivateChannelVerifiedWalletRepository").mockReturnValue(
    verifiedRepo as never
  );
  vi.spyOn(authPkg, "createAuthClient").mockReturnValue(client as never);
  vi.spyOn(spcSession, "getSpcSession").mockResolvedValue({ token: "jwt", username: "u" });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () =>
      Response.json({ address: PUBKEY, chain_type: "solana", id: WALLET_ID })
    )
  );
  vi.spyOn(PrivySigner, "create");
  vi.spyOn(PrivySigner.prototype, "signMessages").mockImplementation(signMessages);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  env.PRIVY_APP_ID = originalPrivy.appId;
  env.PRIVY_APP_SECRET = originalPrivy.appSecret;
  env.PRIVY_BYOK_ENABLED = originalByok;
});

describe("verifyPrivateChannelWallet", () => {
  it("verifies with role permissions when explicit permissions are absent", async () => {
    const { row } = await verifyPrivateChannelWallet(env, keyAuth, "prj_1", WALLET_ID);
    expect(row.pubkey).toBe(PUBKEY);
    expect(signMessages).toHaveBeenCalledTimes(1);
  });

  it.each(["[]", '["payments:read"]'])(
    "does not inherit role permissions over explicit permissions %s",
    async (permissions) => {
      await getDb(env)
        .prepare("UPDATE api_keys SET permissions = ? WHERE id = ?")
        .bind(permissions, keyAuth.apiKeyId)
        .run();
      await expect(
        verifyPrivateChannelWallet(env, keyAuth, "prj_1", WALLET_ID)
      ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
      expect(PrivySigner.create).not.toHaveBeenCalled();
      expect(client.challengeWallet).not.toHaveBeenCalled();
    }
  );

  it("rejects malformed permissions before verification can sign", async () => {
    await getDb(env)
      .prepare("UPDATE api_keys SET permissions = ? WHERE id = ?")
      .bind('"payments:write"', keyAuth.apiKeyId)
      .run();
    await expect(
      verifyPrivateChannelWallet(env, keyAuth, "prj_1", WALLET_ID)
    ).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Stored API key permissions are invalid",
    });
    expect(PrivySigner.create).not.toHaveBeenCalled();
    expect(client.challengeWallet).not.toHaveBeenCalled();
  });

  it("rejects revoked keys even when their role would allow verification", async () => {
    await getDb(env)
      .prepare("UPDATE api_keys SET status = 'revoked' WHERE id = ?")
      .bind(keyAuth.apiKeyId)
      .run();
    await expect(
      verifyPrivateChannelWallet(env, keyAuth, "prj_1", WALLET_ID)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(PrivySigner.create).not.toHaveBeenCalled();
    expect(client.challengeWallet).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "uses the exact Connection for verification only when admitted (enabled=%s)",
    async (enabled) => {
      env.PRIVY_BYOK_ENABLED = String(enabled);
      const db = getDb(env);
      await db.batch([
        db.prepare("UPDATE custody_configs SET default_wallet_id = NULL WHERE id = 'cfg_verify'"),
        db.prepare(`INSERT INTO provider_credentials
        (id, organization_id, project_id, provider, label, scope, source, storage_backend, status, created_by)
        VALUES ('pcred_verify', 'org_1', 'prj_1', 'privy', 'PC', 'project', 'runtime', 'runtime_env', 'active', 'usr_1')`),
        db.prepare(`INSERT INTO custody_connections
        (id, organization_id, project_id, provider, scope, provider_credential_id, provider_credential_scope_key, status, created_by)
        VALUES ('conn_verify', 'org_1', 'prj_1', 'privy', 'project', 'pcred_verify', 'prj_1', 'pending', 'usr_1')`),
        db.prepare(
          "UPDATE custody_wallets SET custody_config_id = NULL, custody_connection_id = 'conn_verify' WHERE id = 'cw_verify'"
        ),
        db
          .prepare(`UPDATE custody_connections SET default_custody_wallet_id = 'cw_verify', status = 'active',
        provider_account_fingerprint = ?, activated_at = sdp_iso_now(), last_check_status = 'success', last_check_at = sdp_iso_now()
        WHERE id = 'conn_verify'`)
          .bind(await getPrivyProviderAccountFingerprint("pc-verification-app")),
      ]);
      if (enabled) {
        expect((await verifyPrivateChannelWallet(env, auth, "prj_1", WALLET_ID)).row.pubkey).toBe(
          PUBKEY
        );
        expect(PrivySigner.create).toHaveBeenCalledWith(
          expect.objectContaining({ walletId: WALLET_ID, appId: "pc-verification-app" })
        );
        expect(signMessages).toHaveBeenCalledTimes(1);
      } else {
        await expect(
          verifyPrivateChannelWallet(env, auth, "prj_1", WALLET_ID)
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(PrivySigner.create).not.toHaveBeenCalled();
        expect(spcSession.getSpcSession).not.toHaveBeenCalled();
        expect(client.challengeWallet).not.toHaveBeenCalled();
      }
    }
  );
  it("treats an SPC 409 (already verified) as success and still upserts the mirror", async () => {
    client.verifyWallet.mockRejectedValue(
      new PrivateChannelError("CONFLICT", "wallet already verified")
    );

    const { row } = await verifyPrivateChannelWallet(env, auth, "prj_1", WALLET_ID);

    expect(verifiedRepo.upsert).toHaveBeenCalledTimes(1);
    expect(row.pubkey).toBe(PUBKEY);
  });

  it("retries once on UNAUTHORIZED then propagates a persistent 401 without upserting", async () => {
    client.verifyWallet.mockRejectedValue(new PrivateChannelError("UNAUTHORIZED", "bad token"));

    await expect(verifyPrivateChannelWallet(env, auth, "prj_1", WALLET_ID)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(client.challengeWallet).toHaveBeenCalledTimes(2);
    expect(verifiedRepo.upsert).not.toHaveBeenCalled();
  });

  it("on UNAUTHORIZED restarts challenge→sign→verify with a fresh nonce", async () => {
    vi.mocked(spcSession.getSpcSession)
      .mockResolvedValueOnce({ token: "stale", username: "u" })
      .mockResolvedValueOnce({ token: "fresh", username: "u" });

    client.challengeWallet
      .mockResolvedValueOnce({ message: "sign A", nonce: "nA", expires_at: "l" })
      .mockResolvedValueOnce({ message: "sign B", nonce: "nB", expires_at: "l" });
    client.verifyWallet
      .mockRejectedValueOnce(new PrivateChannelError("UNAUTHORIZED", "stale jwt"))
      .mockResolvedValueOnce({ pubkey: PUBKEY, created_at: "x" });

    await verifyPrivateChannelWallet(env, auth, "prj_1", WALLET_ID);

    expect(client.challengeWallet).toHaveBeenCalledTimes(2);
    expect(client.challengeWallet).toHaveBeenNthCalledWith(1, "stale");
    expect(client.challengeWallet).toHaveBeenNthCalledWith(2, "fresh");
    expect(client.verifyWallet).toHaveBeenNthCalledWith(
      2,
      "fresh",
      expect.objectContaining({ nonce: "nB" })
    );
    expect(PrivySigner.create).toHaveBeenCalledTimes(1);
    expect(signMessages).toHaveBeenCalledTimes(2);
    expect(verifiedRepo.upsert).toHaveBeenCalledTimes(1);
  });

  it("opens the session through the shared cached handle layer", async () => {
    const openSpy = vi.spyOn(gatewayAuth, "openSpcAuthContext");

    await verifyPrivateChannelWallet(env, auth, "prj_1", WALLET_ID);

    expect(openSpy).toHaveBeenCalledWith(env, "org_1", "pci_1", pcUser, expect.anything());
    expect(spcSession.getSpcSession).toHaveBeenCalledWith(
      env,
      "org_1",
      pcUser,
      expect.anything(),
      expect.objectContaining({ instanceId: "pci_1", forceRefresh: false })
    );
  });

  it("upserts the mirror scoped to the acting member and active instance", async () => {
    await verifyPrivateChannelWallet(env, auth, "prj_1", WALLET_ID);

    expect(verifiedRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "pcu_1",
        instanceId: "pci_1",
        walletId: WALLET_ID,
        pubkey: PUBKEY,
      })
    );
  });

  it("revokes a late SPC binding when the identity was disabled during verification", async () => {
    verifiedRepo.upsert.mockRejectedValue({ code: "CONFLICT" });
    principalRepo.getById.mockResolvedValue({
      ...pcUser,
      disabled_at: "2026-08-31T00:00:00.000Z",
    });

    await expect(verifyPrivateChannelWallet(env, auth, "prj_1", WALLET_ID)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    expect(client.deleteWallet).toHaveBeenCalledWith("jwt", PUBKEY);
    expect(verifiedRepo.recordPendingRevocation).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "pcu_1", instanceId: "pci_1", pubkey: PUBKEY })
    );
    expect(verifiedRepo.deleteByUserInstanceAndPubkey).toHaveBeenCalledWith(
      "pcu_1",
      "pci_1",
      PUBKEY
    );
    expect(verifiedRepo.deletePendingRevocation).toHaveBeenCalledWith("pcu_1", "pci_1", PUBKEY);
  });

  it("keeps a cleanup marker when late-binding revocation fails", async () => {
    verifiedRepo.upsert.mockRejectedValue({ code: "CONFLICT" });
    principalRepo.getById.mockResolvedValue({
      ...pcUser,
      disabled_at: "2026-08-31T00:00:00.000Z",
    });
    client.deleteWallet.mockRejectedValue(
      new PrivateChannelError("AUTH_UNAVAILABLE", "SPC unavailable")
    );

    await expect(verifyPrivateChannelWallet(env, auth, "prj_1", WALLET_ID)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    expect(verifiedRepo.recordPendingRevocation).toHaveBeenCalledTimes(1);
    expect(verifiedRepo.deleteByUserInstanceAndPubkey).not.toHaveBeenCalled();
    expect(verifiedRepo.deletePendingRevocation).not.toHaveBeenCalled();
  });

  it("does not revoke SPC on an unrelated persistence failure for an active identity", async () => {
    verifiedRepo.upsert.mockRejectedValue(new Error("database unavailable"));
    principalRepo.getById.mockResolvedValue(pcUser);

    await expect(verifyPrivateChannelWallet(env, auth, "prj_1", WALLET_ID)).rejects.toThrow(
      "database unavailable"
    );

    expect(client.deleteWallet).not.toHaveBeenCalled();
  });

  it("verifies a wallet under an explicitly selected project principal", async () => {
    const selectedPrincipal = {
      ...pcUser,
      id: "pcu_treasury",
      is_default: false,
    } as repositories.PrivateChannelUserWithIdentityRow;
    principalRepo.getById.mockResolvedValue(selectedPrincipal);

    await verifyPrivateChannelWallet(env, auth, "prj_1", WALLET_ID, selectedPrincipal.id);

    expect(principalRepo.getById).toHaveBeenCalledWith(
      { organizationId: "org_1", projectId: "prj_1" },
      selectedPrincipal.id
    );
    expect(verifiedRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ userId: selectedPrincipal.id })
    );
  });

  it("resolves the signer before requesting the SPC challenge", async () => {
    await verifyPrivateChannelWallet(env, auth, "prj_1", WALLET_ID);
    const signerOrder = vi.mocked(PrivySigner.create).mock.invocationCallOrder[0];
    const challengeOrder = client.challengeWallet.mock.invocationCallOrder[0];
    expect(signerOrder).toBeLessThan(challengeOrder);
  });

  it("rejects a missing custody wallet before opening the session or challenge", async () => {
    await expect(
      verifyPrivateChannelWallet(env, auth, "prj_1", "wal_missing")
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(spcSession.getSpcSession).not.toHaveBeenCalled();
    expect(client.challengeWallet).not.toHaveBeenCalled();
  });

  it("does not refresh when signing fails inside the retry unit", async () => {
    signMessages.mockRejectedValueOnce(new Error("sign boom"));

    await expect(verifyPrivateChannelWallet(env, auth, "prj_1", WALLET_ID)).rejects.toMatchObject({
      code: "SIGNING_FAILED",
    });
    expect(spcSession.getSpcSession).toHaveBeenCalledTimes(1);
    expect(client.challengeWallet).toHaveBeenCalledTimes(1);
    expect(client.verifyWallet).not.toHaveBeenCalled();
  });
});

describe("deletePrivateChannelWallet", () => {
  it("authenticates as the identity that owns a non-default wallet", async () => {
    const openSpy = vi.spyOn(gatewayAuth, "openSpcAuthContext");
    const selectedPrincipal = {
      ...pcUser,
      id: "pcu_treasury",
      is_default: false,
    } as repositories.PrivateChannelUserWithIdentityRow;
    verifiedRepo.findByInstanceAndPubkey.mockResolvedValue({
      id: "pcvw_treasury",
      organization_id: "org_1",
      project_id: "prj_1",
      user_id: selectedPrincipal.id,
      instance_id: "pci_1",
      wallet_id: WALLET_ID,
      pubkey: PUBKEY,
    });
    principalRepo.getById.mockResolvedValue(selectedPrincipal);

    const { deleted } = await deletePrivateChannelWallet(env, auth, "prj_1", PUBKEY);

    expect(principalRepo.getById).toHaveBeenCalledWith(
      { organizationId: "org_1", projectId: "prj_1" },
      selectedPrincipal.id
    );
    expect(openSpy).toHaveBeenCalledWith(
      env,
      "org_1",
      "pci_1",
      selectedPrincipal,
      expect.anything()
    );
    expect(verifiedRepo.deleteByUserInstanceAndPubkey).toHaveBeenCalledWith(
      selectedPrincipal.id,
      "pci_1",
      PUBKEY
    );
    expect(deleted).toBe(true);
  });

  it("returns false without calling SPC when the local wallet mirror is absent", async () => {
    verifiedRepo.findByInstanceAndPubkey.mockResolvedValue(null);

    const { deleted } = await deletePrivateChannelWallet(env, auth, "prj_1", PUBKEY);

    expect(deleted).toBe(false);
    expect(client.deleteWallet).not.toHaveBeenCalled();
    expect(principalRepo.getById).not.toHaveBeenCalled();
  });

  it("swallows an SPC 'not associated' 400 and still removes the mirror row", async () => {
    client.deleteWallet.mockRejectedValue(
      new PrivateChannelError("BAD_REQUEST", "wallet not associated with this user")
    );

    const { deleted } = await deletePrivateChannelWallet(env, auth, "prj_1", PUBKEY);

    expect(client.deleteWallet).toHaveBeenCalledTimes(1);
    expect(verifiedRepo.deleteByUserInstanceAndPubkey).toHaveBeenCalledWith(
      "pcu_1",
      "pci_1",
      PUBKEY
    );
    expect(deleted).toBe(true);
  });

  it("on UNAUTHORIZED refreshes once and retries delete", async () => {
    vi.mocked(spcSession.getSpcSession)
      .mockResolvedValueOnce({ token: "stale", username: "u" })
      .mockResolvedValueOnce({ token: "fresh", username: "u" });
    client.deleteWallet
      .mockRejectedValueOnce(new PrivateChannelError("UNAUTHORIZED", "stale jwt"))
      .mockResolvedValueOnce(undefined);

    const { deleted } = await deletePrivateChannelWallet(env, auth, "prj_1", PUBKEY);

    expect(client.deleteWallet).toHaveBeenNthCalledWith(1, "stale", PUBKEY);
    expect(client.deleteWallet).toHaveBeenNthCalledWith(2, "fresh", PUBKEY);
    expect(deleted).toBe(true);
  });

  it("rethrows an SPC failure and does not remove the mirror row", async () => {
    client.deleteWallet.mockRejectedValue(new PrivateChannelError("AUTH_UNAVAILABLE", "down"));

    await expect(deletePrivateChannelWallet(env, auth, "prj_1", PUBKEY)).rejects.toMatchObject({
      code: "AUTH_UNAVAILABLE",
    });
    expect(verifiedRepo.deleteByUserInstanceAndPubkey).not.toHaveBeenCalled();
  });
});

describe("revokePrivateChannelPrincipalWallets", () => {
  it("removes every upstream wallet binding before deleting its mirrors", async () => {
    const secondPubkey = "11111111111111111111111111111111";
    verifiedRepo.listByUserAndInstance.mockResolvedValue([
      { user_id: "pcu_1", instance_id: "pci_1", pubkey: PUBKEY },
      { user_id: "pcu_1", instance_id: "pci_1", pubkey: secondPubkey },
    ]);

    const revoked = await revokePrivateChannelPrincipalWallets(env, auth, "prj_1", "pcu_1");

    expect(client.deleteWallet).toHaveBeenNthCalledWith(1, "jwt", PUBKEY);
    expect(client.deleteWallet).toHaveBeenNthCalledWith(2, "jwt", secondPubkey);
    expect(verifiedRepo.deleteByUserInstanceAndPubkey).toHaveBeenCalledTimes(2);
    expect(revoked).toEqual([PUBKEY, secondPubkey]);
  });

  it("retries pending revocations that do not have a verified-wallet mirror", async () => {
    verifiedRepo.listByUserAndInstance.mockResolvedValue([]);
    verifiedRepo.listPendingRevocations.mockResolvedValue([
      { user_id: "pcu_1", instance_id: "pci_1", pubkey: PUBKEY },
    ]);
    verifiedRepo.deletePendingRevocation.mockResolvedValue(true);

    await expect(
      revokePrivateChannelPrincipalWallets(env, auth, "prj_1", "pcu_1")
    ).resolves.toEqual([PUBKEY]);

    expect(client.deleteWallet).toHaveBeenCalledWith("jwt", PUBKEY);
    expect(verifiedRepo.deletePendingRevocation).toHaveBeenCalledWith("pcu_1", "pci_1", PUBKEY);
  });
});
