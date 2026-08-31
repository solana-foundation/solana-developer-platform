import * as privateChannels from "@sdp/private-channels";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrivateChannelUserRepository, PrivateChannelUserRow } from "@/db/repositories";
import * as credentialCrypto from "@/lib/spc-credential-crypto";
import { provisionPrincipal } from "./members";

const scope = {
  organizationId: "org_1",
  projectId: "prj_1",
  instanceId: "pci_1",
  authUrl: "http://auth.local:8903",
  name: "Treasury",
  isDefault: false,
  createdBy: "usr_1",
};

const reservation = {
  id: "pcu_reserved",
  organization_id: "org_1",
  project_id: "prj_1",
  instance_id: "pci_1",
  name: "Treasury",
  is_default: false,
  spc_user_id: null,
} as PrivateChannelUserRow;

const completed = {
  ...reservation,
  spc_user_id: "spc_1",
  spc_username: "treasury-abcde",
  spc_credential_ciphertext: "encrypted",
} as PrivateChannelUserRow;

let repo: {
  findDefaultPrincipal: ReturnType<typeof vi.fn>;
  reservePrincipal: ReturnType<typeof vi.fn>;
  completePrincipal: ReturnType<typeof vi.fn>;
  deletePrincipalReservation: ReturnType<typeof vi.fn>;
};
let registerSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  repo = {
    findDefaultPrincipal: vi.fn().mockResolvedValue(null),
    reservePrincipal: vi.fn().mockResolvedValue(reservation),
    completePrincipal: vi.fn().mockResolvedValue(completed),
    deletePrincipalReservation: vi.fn().mockResolvedValue(true),
  };
  registerSpy = vi.spyOn(privateChannels, "spcRegister").mockResolvedValue({
    id: "spc_1",
    username: "treasury-abcde",
    role: "user",
    createdAt: "2026-08-31T00:00:00.000Z",
  });
  vi.spyOn(credentialCrypto, "createSpcCredentialCipher").mockReturnValue({
    encrypt: vi.fn().mockResolvedValue("encrypted"),
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("provisionPrincipal", () => {
  it("reserves the local identity before registering it with SPC", async () => {
    const result = await provisionPrincipal(
      {} as never,
      repo as unknown as PrivateChannelUserRepository,
      scope
    );

    expect(repo.reservePrincipal.mock.invocationCallOrder[0]).toBeLessThan(
      registerSpy.mock.invocationCallOrder[0]
    );
    expect(repo.completePrincipal).toHaveBeenCalledWith(
      expect.objectContaining({ id: reservation.id, spcUserId: "spc_1" })
    );
    expect(result).toEqual({ principal: completed, created: true });
  });

  it("does not create an SPC user when the local reservation conflicts", async () => {
    repo.reservePrincipal.mockRejectedValue(
      Object.assign(new Error("duplicate"), { code: "23505" })
    );

    await expect(
      provisionPrincipal({} as never, repo as unknown as PrivateChannelUserRepository, scope)
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "An active Private Channels identity already uses this name.",
    });
    expect(registerSpy).not.toHaveBeenCalled();
  });

  it("removes the reservation when SPC registration fails", async () => {
    registerSpy.mockRejectedValue(new Error("SPC unavailable"));

    await expect(
      provisionPrincipal({} as never, repo as unknown as PrivateChannelUserRepository, scope)
    ).rejects.toThrow("SPC unavailable");
    expect(repo.deletePrincipalReservation).toHaveBeenCalledWith(scope, reservation.id);
    expect(repo.completePrincipal).not.toHaveBeenCalled();
  });
});
