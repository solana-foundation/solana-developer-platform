import type { PrivateChannelPrincipalDto, PrivateChannelVerifiedWalletDto } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
  createProjectBoundSdpApiClient: vi.fn(),
  getSelectedProjectId: vi.fn(),
  createPrivateChannelPrincipal: vi.fn(),
  verifyPrivateChannelWallet: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/i18n/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock("@/lib/private-channels", () => ({
  addPrincipalChannelMembership: vi.fn(),
  createPrivateChannelPrincipal: mocks.createPrivateChannelPrincipal,
  disablePrivateChannelPrincipal: vi.fn(),
  removePrincipalChannelMembership: vi.fn(),
  verifyPrivateChannelWallet: mocks.verifyPrivateChannelWallet,
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

import { createAndVerifyPrincipalAction } from "./actions";

// The project the wizard rendered for; the sibling tab has since moved the
// shared cookie here.
const RENDERED_PROJECT = "project_rendered";
const MOVED_PROJECT = "project_cookie_moved";

const principal: PrivateChannelPrincipalDto = {
  id: "pcp_1",
  name: "Mia",
  isDefault: false,
  status: "active",
  verifiedWalletCount: 0,
  createdAt: "2026-09-24T00:00:00.000Z",
  channels: [],
};

const verifiedWallet: PrivateChannelVerifiedWalletDto = {
  id: "pcvw_1",
  walletId: "wallet_1",
  pubkey: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  verifiedAt: "2026-09-24T00:00:00.000Z",
};

describe("createAndVerifyPrincipalAction project binding", () => {
  const boundClient = { fetch: vi.fn(), request: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createProjectBoundSdpApiClient.mockResolvedValue(boundClient);
  });

  it("binds both writes to the rendered project through one guarded client", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.createPrivateChannelPrincipal.mockResolvedValue({ principal });
    mocks.verifyPrivateChannelWallet.mockResolvedValue(verifiedWallet);

    await expect(
      createAndVerifyPrincipalAction({
        name: "Mia",
        walletId: "wallet_1",
        projectId: RENDERED_PROJECT,
      })
    ).resolves.toEqual({ ok: true, wallet: verifiedWallet });

    // One stale check guards both writes; the mutable-cookie client is exactly
    // the path the finding forbids.
    expect(mocks.createProjectBoundSdpApiClient).toHaveBeenCalledTimes(1);
    expect(mocks.createProjectBoundSdpApiClient).toHaveBeenCalledWith(RENDERED_PROJECT);
    expect(mocks.createSdpApiClient).not.toHaveBeenCalled();
    expect(mocks.createPrivateChannelPrincipal).toHaveBeenCalledWith(boundClient, {
      name: "Mia",
    });
    expect(mocks.verifyPrivateChannelWallet).toHaveBeenCalledWith(boundClient, "wallet_1", {
      principalId: "pcp_1",
    });
  });

  it("rejects before any write when the submit-time project differs from the rendered one", async () => {
    // The wizard rendered for RENDERED_PROJECT; by submit time a sibling tab
    // has moved the shared cookie to MOVED_PROJECT. Nothing may be written —
    // creating first would strand a principal the verification then refuses
    // to bind to.
    mocks.getSelectedProjectId.mockResolvedValue(MOVED_PROJECT);

    const result = await createAndVerifyPrincipalAction({
      name: "Mia",
      walletId: "wallet_1",
      projectId: RENDERED_PROJECT,
    });

    expect(result.ok).toBe(false);
    expect(mocks.createPrivateChannelPrincipal).not.toHaveBeenCalled();
    expect(mocks.verifyPrivateChannelWallet).not.toHaveBeenCalled();
    expect(mocks.createSdpApiClient).not.toHaveBeenCalled();
    expect(mocks.createProjectBoundSdpApiClient).not.toHaveBeenCalled();
  });

  it("rejects when the submit-time selection cannot be resolved", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(undefined);

    const result = await createAndVerifyPrincipalAction({
      name: "Mia",
      walletId: "wallet_1",
      projectId: RENDERED_PROJECT,
    });

    expect(result.ok).toBe(false);
    expect(mocks.createPrivateChannelPrincipal).not.toHaveBeenCalled();
    expect(mocks.verifyPrivateChannelWallet).not.toHaveBeenCalled();
    expect(mocks.createProjectBoundSdpApiClient).not.toHaveBeenCalled();
  });

  it("requires a rendered project id before building any client", async () => {
    const result = await createAndVerifyPrincipalAction({
      name: "Mia",
      walletId: "wallet_1",
      projectId: "",
    });

    expect(result.ok).toBe(false);
    expect(mocks.getSelectedProjectId).not.toHaveBeenCalled();
    expect(mocks.createProjectBoundSdpApiClient).not.toHaveBeenCalled();
  });

  it("requires a wallet id before building any client", async () => {
    const result = await createAndVerifyPrincipalAction({
      name: "Mia",
      walletId: "",
      projectId: RENDERED_PROJECT,
    });

    expect(result).toMatchObject({ ok: false, message: "DashboardPrivateChannels.verifiedWallets.walletRequired" });
    expect(mocks.getSelectedProjectId).not.toHaveBeenCalled();
    expect(mocks.createProjectBoundSdpApiClient).not.toHaveBeenCalled();
  });

  it("fails closed when the rendered project is no longer listed for the organization", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.createProjectBoundSdpApiClient.mockRejectedValue(
      new Error("Requested project is not available for this organization")
    );

    const result = await createAndVerifyPrincipalAction({
      name: "Mia",
      walletId: "wallet_1",
      projectId: RENDERED_PROJECT,
    });

    expect(result).toMatchObject({ ok: false });
    expect(mocks.createPrivateChannelPrincipal).not.toHaveBeenCalled();
    expect(mocks.verifyPrivateChannelWallet).not.toHaveBeenCalled();
  });

  it("returns a recoverable error when the upstream creation fails", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.createPrivateChannelPrincipal.mockRejectedValue(
      new Error(
        `SDP API request failed (400): ${JSON.stringify({
          error: { message: "Principal name is taken." },
        })}`
      )
    );

    await expect(
      createAndVerifyPrincipalAction({
        name: "Mia",
        walletId: "wallet_1",
        projectId: RENDERED_PROJECT,
      })
    ).resolves.toEqual({ ok: false, message: "Principal name is taken." });
  });

  it("hands back the created principal id when the verification fails, so a retry does not duplicate", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.createPrivateChannelPrincipal.mockResolvedValue({ principal });
    mocks.verifyPrivateChannelWallet.mockRejectedValue(
      new Error(
        `SDP API request failed (404): ${JSON.stringify({
          error: { message: "Custody wallet not found." },
        })}`
      )
    );

    await expect(
      createAndVerifyPrincipalAction({
        name: "Mia",
        walletId: "wallet_1",
        projectId: RENDERED_PROJECT,
      })
    ).resolves.toEqual({
      ok: false,
      message: "Custody wallet not found.",
      principalId: "pcp_1",
    });
    // Still exactly one write pair under the rendered project.
    expect(mocks.createPrivateChannelPrincipal).toHaveBeenCalledTimes(1);
    expect(mocks.verifyPrivateChannelWallet).toHaveBeenCalledTimes(1);
  });

  it("retries only the verification for an already-created principal", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.verifyPrivateChannelWallet.mockResolvedValue(verifiedWallet);

    await expect(
      createAndVerifyPrincipalAction({
        name: "Mia",
        walletId: "wallet_1",
        projectId: RENDERED_PROJECT,
        principalId: "pcp_existing",
      })
    ).resolves.toEqual({ ok: true, wallet: verifiedWallet });

    expect(mocks.createPrivateChannelPrincipal).not.toHaveBeenCalled();
    expect(mocks.verifyPrivateChannelWallet).toHaveBeenCalledWith(boundClient, "wallet_1", {
      principalId: "pcp_existing",
    });
  });
});
