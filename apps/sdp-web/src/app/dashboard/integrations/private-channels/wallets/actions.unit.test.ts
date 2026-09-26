import type { PrivateChannelVerifiedWalletDto } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
  createProjectBoundSdpApiClient: vi.fn(),
  getSelectedProjectId: vi.fn(),
  verifyPrivateChannelWallet: vi.fn(),
  deletePrivateChannelVerifiedWallet: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/i18n/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock("@/lib/private-channels", () => ({
  verifyPrivateChannelWallet: mocks.verifyPrivateChannelWallet,
  deletePrivateChannelVerifiedWallet: mocks.deletePrivateChannelVerifiedWallet,
}));
// `extractSdpApiErrorMessage` stays real: the actions' returned message must
// keep the shape the product actually produces.
vi.mock("@/lib/sdp-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sdp-api")>("@/lib/sdp-api");
  return {
    createSdpApiClient: mocks.createSdpApiClient,
    createProjectBoundSdpApiClient: mocks.createProjectBoundSdpApiClient,
    getSelectedProjectId: mocks.getSelectedProjectId,
    extractSdpApiErrorMessage: actual.extractSdpApiErrorMessage,
  };
});

import { deleteVerifiedWalletAction, verifyWalletAction } from "./actions";

// The project the page rendered for; the sibling tab has since moved the shared
// cookie here.
const RENDERED_PROJECT = "project_rendered";
const MOVED_PROJECT = "project_cookie_moved";

const verifiedWallet: PrivateChannelVerifiedWalletDto = {
  id: "pcvw_1",
  walletId: "wallet_1",
  pubkey: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  verifiedAt: "2026-09-24T00:00:00.000Z",
};

describe("verifyWalletAction project binding", () => {
  const boundClient = { fetch: vi.fn(), request: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createProjectBoundSdpApiClient.mockResolvedValue(boundClient);
  });

  it("binds the mutation to the rendered project instead of the submit-time cookie", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.verifyPrivateChannelWallet.mockResolvedValue(verifiedWallet);

    await expect(
      verifyWalletAction({ walletId: "wallet_1", projectId: RENDERED_PROJECT })
    ).resolves.toEqual({ ok: true, wallet: verifiedWallet });

    expect(mocks.createProjectBoundSdpApiClient).toHaveBeenCalledWith(RENDERED_PROJECT);
    // The mutable-cookie client is exactly the path the finding forbids.
    expect(mocks.createSdpApiClient).not.toHaveBeenCalled();
    expect(mocks.verifyPrivateChannelWallet).toHaveBeenCalledWith(boundClient, "wallet_1", {
      principalId: undefined,
    });
  });

  it("rejects the submission when the submit-time project differs from the rendered one", async () => {
    // The page rendered for RENDERED_PROJECT; by submit time a sibling tab has
    // moved the shared cookie to MOVED_PROJECT. The mutation must not reach the
    // API at all — neither bound to the moved project nor re-resolved silently.
    mocks.getSelectedProjectId.mockResolvedValue(MOVED_PROJECT);

    const result = await verifyWalletAction({
      walletId: "wallet_1",
      projectId: RENDERED_PROJECT,
    });

    expect(result.ok).toBe(false);
    expect(mocks.verifyPrivateChannelWallet).not.toHaveBeenCalled();
    expect(mocks.createSdpApiClient).not.toHaveBeenCalled();
    expect(mocks.createProjectBoundSdpApiClient).not.toHaveBeenCalled();
  });

  it("rejects when the submit-time selection cannot be resolved", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(undefined);

    const result = await verifyWalletAction({
      walletId: "wallet_1",
      projectId: RENDERED_PROJECT,
    });

    expect(result.ok).toBe(false);
    expect(mocks.verifyPrivateChannelWallet).not.toHaveBeenCalled();
    expect(mocks.createProjectBoundSdpApiClient).not.toHaveBeenCalled();
  });

  it("forwards the principal id with the rendered-project client", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.verifyPrivateChannelWallet.mockResolvedValue(verifiedWallet);

    await expect(
      verifyWalletAction({
        walletId: "wallet_1",
        projectId: RENDERED_PROJECT,
        principalId: "principal_1",
      })
    ).resolves.toEqual({ ok: true, wallet: verifiedWallet });

    expect(mocks.verifyPrivateChannelWallet).toHaveBeenCalledWith(boundClient, "wallet_1", {
      principalId: "principal_1",
    });
  });

  it("requires a wallet id before building any client", async () => {
    const result = await verifyWalletAction({ walletId: "", projectId: RENDERED_PROJECT });

    expect(result.ok).toBe(false);
    expect(mocks.createProjectBoundSdpApiClient).not.toHaveBeenCalled();
    expect(mocks.verifyPrivateChannelWallet).not.toHaveBeenCalled();
  });

  it("requires a rendered project id before building any client", async () => {
    const result = await verifyWalletAction({ walletId: "wallet_1", projectId: "" });

    expect(result.ok).toBe(false);
    expect(mocks.getSelectedProjectId).not.toHaveBeenCalled();
    expect(mocks.createProjectBoundSdpApiClient).not.toHaveBeenCalled();
  });

  it("fails closed when the rendered project is no longer listed for the organization", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.createProjectBoundSdpApiClient.mockRejectedValue(
      new Error("Requested project is not available for this organization")
    );

    const result = await verifyWalletAction({
      walletId: "wallet_1",
      projectId: RENDERED_PROJECT,
    });

    expect(result).toMatchObject({ ok: false });
    expect(mocks.verifyPrivateChannelWallet).not.toHaveBeenCalled();
  });

  it("returns a recoverable error when the upstream verification fails", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.verifyPrivateChannelWallet.mockRejectedValue(
      new Error(
        `SDP API request failed (404): ${JSON.stringify({
          error: { message: "Custody wallet not found." },
        })}`
      )
    );

    await expect(
      verifyWalletAction({ walletId: "wallet_1", projectId: RENDERED_PROJECT })
    ).resolves.toEqual({ ok: false, message: "Custody wallet not found." });
  });
});

describe("deleteVerifiedWalletAction project binding", () => {
  const boundClient = { fetch: vi.fn(), request: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createProjectBoundSdpApiClient.mockResolvedValue(boundClient);
  });

  it("binds the revocation to the rendered project instead of the submit-time cookie", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.deletePrivateChannelVerifiedWallet.mockResolvedValue(undefined);

    await expect(
      deleteVerifiedWalletAction({ pubkey: verifiedWallet.pubkey, projectId: RENDERED_PROJECT })
    ).resolves.toEqual({ ok: true });

    expect(mocks.createProjectBoundSdpApiClient).toHaveBeenCalledWith(RENDERED_PROJECT);
    expect(mocks.createSdpApiClient).not.toHaveBeenCalled();
    expect(mocks.deletePrivateChannelVerifiedWallet).toHaveBeenCalledWith(
      boundClient,
      verifiedWallet.pubkey
    );
  });

  it("rejects the revocation when the submit-time project differs from the rendered one", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(MOVED_PROJECT);

    const result = await deleteVerifiedWalletAction({
      pubkey: verifiedWallet.pubkey,
      projectId: RENDERED_PROJECT,
    });

    expect(result.ok).toBe(false);
    expect(mocks.deletePrivateChannelVerifiedWallet).not.toHaveBeenCalled();
    expect(mocks.createSdpApiClient).not.toHaveBeenCalled();
    expect(mocks.createProjectBoundSdpApiClient).not.toHaveBeenCalled();
  });

  it("requires a rendered project id before building any client", async () => {
    const result = await deleteVerifiedWalletAction({
      pubkey: verifiedWallet.pubkey,
      projectId: "",
    });

    expect(result.ok).toBe(false);
    expect(mocks.getSelectedProjectId).not.toHaveBeenCalled();
    expect(mocks.createProjectBoundSdpApiClient).not.toHaveBeenCalled();
  });

  it("fails closed when the rendered project is no longer listed for the organization", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.createProjectBoundSdpApiClient.mockRejectedValue(
      new Error("Requested project is not available for this organization")
    );

    const result = await deleteVerifiedWalletAction({
      pubkey: verifiedWallet.pubkey,
      projectId: RENDERED_PROJECT,
    });

    expect(result).toMatchObject({ ok: false });
    expect(mocks.deletePrivateChannelVerifiedWallet).not.toHaveBeenCalled();
  });

  it("returns a recoverable error when the upstream revocation fails", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.deletePrivateChannelVerifiedWallet.mockRejectedValue(new Error("Revocation failed"));

    await expect(
      deleteVerifiedWalletAction({ pubkey: verifiedWallet.pubkey, projectId: RENDERED_PROJECT })
    ).resolves.toEqual({ ok: false, message: "Revocation failed" });
  });
});
