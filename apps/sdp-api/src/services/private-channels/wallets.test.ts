import { SigningError } from "@sdp/custody/signing";
import { PrivateChannelError } from "@sdp/private-channels";
import * as authPkg from "@sdp/private-channels/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as repositories from "@/db/repositories";
import type { ApiKeyContext } from "@/lib/auth";
import * as solana from "@/services/solana";
import type { Env } from "@/types/env";
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

const PUBKEY = "So11111111111111111111111111111111111111112";
const WALLET_ID = "wal_1";

const auth = {
  organizationId: "org_1",
  userId: "usr_1",
  authType: "session",
} as unknown as ApiKeyContext;

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

const env = {} as Env;

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
let signMessages: ReturnType<typeof vi.fn>;

beforeEach(() => {
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
  signMessages = vi.fn().mockResolvedValue([{ [PUBKEY]: new Uint8Array(64) }]);

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
  vi.spyOn(solana, "createOrgSigner").mockResolvedValue({
    address: PUBKEY,
    signMessages,
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifyPrivateChannelWallet", () => {
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
    expect(solana.createOrgSigner).toHaveBeenCalledTimes(1);
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
    const signerOrder = vi.mocked(solana.createOrgSigner).mock.invocationCallOrder[0];
    const challengeOrder = client.challengeWallet.mock.invocationCallOrder[0];
    expect(signerOrder).toBeLessThan(challengeOrder);
  });

  it("propagates a SigningError unwrapped (so onError maps it, e.g. 404) and skips the challenge", async () => {
    vi.spyOn(solana, "createOrgSigner").mockRejectedValue(
      new SigningError("Custody wallet not found", "WALLET_NOT_FOUND")
    );

    await expect(
      verifyPrivateChannelWallet(env, auth, "prj_1", "wal_missing")
    ).rejects.toBeInstanceOf(SigningError);
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
