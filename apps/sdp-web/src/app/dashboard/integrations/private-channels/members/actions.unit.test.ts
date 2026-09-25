import type { PrivateChannelPrincipalDto, PrivateChannelVerifiedWalletDto } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
  createProjectBoundSdpApiClient: vi.fn(),
  getSelectedProjectId: vi.fn(),
  createPrivateChannelPrincipal: vi.fn(),
  fetchPrivateChannelPrincipals: vi.fn(),
  verifyPrivateChannelWallet: vi.fn(),
  t: vi.fn((key: string) => key),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/i18n/server", () => ({
  getTranslations: vi.fn(async () => mocks.t),
}));
vi.mock("@/lib/private-channels", () => ({
  addPrincipalChannelMembership: vi.fn(),
  createPrivateChannelPrincipal: mocks.createPrivateChannelPrincipal,
  disablePrivateChannelPrincipal: vi.fn(),
  fetchPrivateChannelPrincipals: mocks.fetchPrivateChannelPrincipals,
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

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

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
    mocks.fetchPrivateChannelPrincipals.mockResolvedValue([]);
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

    expect(result).toMatchObject({
      ok: false,
      message: "DashboardPrivateChannels.verifiedWallets.walletRequired",
    });
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

  it("asks for confirmation before resuming a same-named principal on an attested retry", async () => {
    // The previous attempt created the principal but its response never
    // reached the wizard, so the retry re-enters without a principalId and
    // attests the lost response. The retry flag cannot establish which
    // principal, if any, the first attempt created, so the action surfaces
    // the candidate and writes nothing until the user confirms the resume.
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.fetchPrivateChannelPrincipals.mockResolvedValue([
      { ...principal, id: "pcp_lost", name: "Mia", createdAt: minutesAgo(1) },
      { ...principal, id: "pcp_other", name: "Other", createdAt: minutesAgo(2) },
    ]);

    await expect(
      createAndVerifyPrincipalAction({
        name: "Mia",
        walletId: "wallet_1",
        projectId: RENDERED_PROJECT,
        isRetry: true,
      })
    ).resolves.toEqual({
      ok: false,
      message: "DashboardPrivateChannels.members.resumePrompt",
      resumeCandidates: ["pcp_lost"],
    });

    expect(mocks.createPrivateChannelPrincipal).not.toHaveBeenCalled();
    expect(mocks.verifyPrivateChannelWallet).not.toHaveBeenCalled();
    // The catalog's resumePrompt carries a {name} placeholder: translating it
    // without the value throws, the candidates never reach the wizard, and
    // the stranded principal becomes unresumable.
    expect(mocks.t).toHaveBeenCalledWith("DashboardPrivateChannels.members.resumePrompt", {
      name: "Mia",
    });
  });

  it("resumes the same-named principal the user confirmed on an attested retry", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.fetchPrivateChannelPrincipals.mockResolvedValue([
      { ...principal, id: "pcp_lost", name: "Mia", createdAt: minutesAgo(1) },
      { ...principal, id: "pcp_other", name: "Other", createdAt: minutesAgo(2) },
    ]);
    mocks.verifyPrivateChannelWallet.mockResolvedValue(verifiedWallet);

    await expect(
      createAndVerifyPrincipalAction({
        name: "Mia",
        walletId: "wallet_1",
        projectId: RENDERED_PROJECT,
        isRetry: true,
        resumePrincipalId: "pcp_lost",
      })
    ).resolves.toEqual({ ok: true, wallet: verifiedWallet });

    expect(mocks.createPrivateChannelPrincipal).not.toHaveBeenCalled();
    expect(mocks.verifyPrivateChannelWallet).toHaveBeenCalledWith(boundClient, "wallet_1", {
      principalId: "pcp_lost",
    });
  });

  it("offers only resumable candidates, newest first, skipping disabled ones", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.fetchPrivateChannelPrincipals.mockResolvedValue([
      { ...principal, id: "pcp_old", name: "Mia", createdAt: minutesAgo(5) },
      {
        ...principal,
        id: "pcp_disabled",
        name: "Mia",
        status: "disabled",
        createdAt: minutesAgo(2),
      },
      { ...principal, id: "pcp_newest", name: "Mia", createdAt: minutesAgo(1) },
    ]);

    await expect(
      createAndVerifyPrincipalAction({
        name: "Mia",
        walletId: "wallet_1",
        projectId: RENDERED_PROJECT,
        isRetry: true,
      })
    ).resolves.toEqual({
      ok: false,
      message: "DashboardPrivateChannels.members.resumePrompt",
      resumeCandidates: ["pcp_newest", "pcp_old"],
    });
    expect(mocks.createPrivateChannelPrincipal).not.toHaveBeenCalled();
    expect(mocks.verifyPrivateChannelWallet).not.toHaveBeenCalled();
  });

  it("never adopts a same-named principal the first attempt cannot have created", async () => {
    // A retry flag attests a lost response but cannot establish which
    // principal the first attempt created. Adoption is only safe for a
    // principal holding nothing: wallet-less, membership-less, and not the
    // project default. An established principal — already verified, already
    // in channels, or the project default — must stay a name conflict, or
    // verification would attach the submitted wallet to channel memberships
    // it was never meant to join.
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.fetchPrivateChannelPrincipals.mockResolvedValue([
      {
        ...principal,
        id: "pcp_verified",
        name: "Mia",
        verifiedWalletCount: 2,
        createdAt: minutesAgo(1),
      },
      {
        ...principal,
        id: "pcp_member",
        name: "Mia",
        channels: [{ id: "pc_1", name: "General", isDefault: false }],
        createdAt: minutesAgo(2),
      },
      {
        ...principal,
        id: "pcp_default",
        name: "Mia",
        isDefault: true,
        createdAt: minutesAgo(3),
      },
    ]);

    await expect(
      createAndVerifyPrincipalAction({
        name: "Mia",
        walletId: "wallet_1",
        projectId: RENDERED_PROJECT,
        isRetry: true,
      })
    ).resolves.toEqual({
      ok: false,
      message: "DashboardPrivateChannels.members.principalNameTaken",
    });

    expect(mocks.createPrivateChannelPrincipal).not.toHaveBeenCalled();
    expect(mocks.verifyPrivateChannelWallet).not.toHaveBeenCalled();
  });

  it("reports a conflict when the confirmed principal became established between the prompt and the confirmation", async () => {
    // The confirmation is re-derived server-side: between the prompt and the
    // user's confirm click, another verification may have claimed the
    // principal. An established principal stays a name conflict — never an
    // adoption.
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.fetchPrivateChannelPrincipals.mockResolvedValue([
      {
        ...principal,
        id: "pcp_claimed",
        name: "Mia",
        verifiedWalletCount: 1,
        createdAt: minutesAgo(1),
      },
    ]);

    await expect(
      createAndVerifyPrincipalAction({
        name: "Mia",
        walletId: "wallet_1",
        projectId: RENDERED_PROJECT,
        isRetry: true,
        resumePrincipalId: "pcp_claimed",
      })
    ).resolves.toEqual({
      ok: false,
      message: "DashboardPrivateChannels.members.principalNameTaken",
    });

    expect(mocks.createPrivateChannelPrincipal).not.toHaveBeenCalled();
    expect(mocks.verifyPrivateChannelWallet).not.toHaveBeenCalled();
  });

  it("confirms a stranded principal however long after the lost response", async () => {
    // The wizard keeps the name locked until this submission finishes, so the
    // confirmation must not depend on how quickly the user makes it back: a
    // stranded principal that still holds nothing stays resumable no matter
    // how old it is, and an empty principal grants the submitted wallet
    // nothing a fresh creation would not.
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.fetchPrivateChannelPrincipals.mockResolvedValue([
      { ...principal, id: "pcp_stranded", name: "Mia", createdAt: minutesAgo(3 * 24 * 60) },
    ]);
    mocks.verifyPrivateChannelWallet.mockResolvedValue(verifiedWallet);

    await expect(
      createAndVerifyPrincipalAction({
        name: "Mia",
        walletId: "wallet_1",
        projectId: RENDERED_PROJECT,
        isRetry: true,
        resumePrincipalId: "pcp_stranded",
      })
    ).resolves.toEqual({ ok: true, wallet: verifiedWallet });

    expect(mocks.createPrivateChannelPrincipal).not.toHaveBeenCalled();
    expect(mocks.verifyPrivateChannelWallet).toHaveBeenCalledWith(boundClient, "wallet_1", {
      principalId: "pcp_stranded",
    });
  });

  it("reports a name conflict on a fresh submission that matches an active principal", async () => {
    // A fresh submission (no attested lost response) must never adopt an
    // existing principal — and must never even be offered a resume:
    // verification would attach the submitted wallet to the existing
    // principal's channel memberships.
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.fetchPrivateChannelPrincipals.mockResolvedValue([
      { ...principal, id: "pcp_taken", name: "Mia" },
    ]);

    await expect(
      createAndVerifyPrincipalAction({
        name: "Mia",
        walletId: "wallet_1",
        projectId: RENDERED_PROJECT,
      })
    ).resolves.toEqual({
      ok: false,
      message: "DashboardPrivateChannels.members.principalNameTaken",
    });

    expect(mocks.createPrivateChannelPrincipal).not.toHaveBeenCalled();
    expect(mocks.verifyPrivateChannelWallet).not.toHaveBeenCalled();
  });

  it("creates a new principal when an attested retry matches no same-named one", async () => {
    // The lost response never reached the server either, so nothing was
    // created and the retry creates the principal.
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.fetchPrivateChannelPrincipals.mockResolvedValue([
      { ...principal, id: "pcp_other", name: "Other" },
    ]);
    mocks.createPrivateChannelPrincipal.mockResolvedValue({ principal });
    mocks.verifyPrivateChannelWallet.mockResolvedValue(verifiedWallet);

    await expect(
      createAndVerifyPrincipalAction({
        name: "Mia",
        walletId: "wallet_1",
        projectId: RENDERED_PROJECT,
        isRetry: true,
      })
    ).resolves.toEqual({ ok: true, wallet: verifiedWallet });

    expect(mocks.createPrivateChannelPrincipal).toHaveBeenCalledWith(boundClient, { name: "Mia" });
    expect(mocks.verifyPrivateChannelWallet).toHaveBeenCalledWith(boundClient, "wallet_1", {
      principalId: "pcp_1",
    });
  });
});
