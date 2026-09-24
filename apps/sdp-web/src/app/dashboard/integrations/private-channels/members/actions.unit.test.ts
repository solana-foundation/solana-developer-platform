import type { PrivateChannelPrincipalDto } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
  createProjectBoundSdpApiClient: vi.fn(),
  getSelectedProjectId: vi.fn(),
  createPrivateChannelPrincipal: vi.fn(),
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

import { createPrincipalAction } from "./actions";

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

describe("createPrincipalAction project binding", () => {
  const boundClient = { fetch: vi.fn(), request: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createProjectBoundSdpApiClient.mockResolvedValue(boundClient);
  });

  it("binds the creation to the rendered project instead of the submit-time cookie", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.createPrivateChannelPrincipal.mockResolvedValue({ principal });

    await expect(
      createPrincipalAction({ name: "Mia", projectId: RENDERED_PROJECT })
    ).resolves.toEqual({ ok: true, value: principal });

    expect(mocks.createProjectBoundSdpApiClient).toHaveBeenCalledWith(RENDERED_PROJECT);
    // The mutable-cookie client is exactly the path the finding forbids.
    expect(mocks.createSdpApiClient).not.toHaveBeenCalled();
    expect(mocks.createPrivateChannelPrincipal).toHaveBeenCalledWith(boundClient, { name: "Mia" });
  });

  it("rejects before creating the principal when the submit-time project differs from the rendered one", async () => {
    // The wizard rendered for RENDERED_PROJECT; by submit time a sibling tab
    // has moved the shared cookie to MOVED_PROJECT. Nothing may be written at
    // all — creating first would strand a principal the guarded verification
    // then refuses to bind to.
    mocks.getSelectedProjectId.mockResolvedValue(MOVED_PROJECT);

    const result = await createPrincipalAction({ name: "Mia", projectId: RENDERED_PROJECT });

    expect(result.ok).toBe(false);
    expect(mocks.createPrivateChannelPrincipal).not.toHaveBeenCalled();
    expect(mocks.createSdpApiClient).not.toHaveBeenCalled();
    expect(mocks.createProjectBoundSdpApiClient).not.toHaveBeenCalled();
  });

  it("rejects when the submit-time selection cannot be resolved", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(undefined);

    const result = await createPrincipalAction({ name: "Mia", projectId: RENDERED_PROJECT });

    expect(result.ok).toBe(false);
    expect(mocks.createPrivateChannelPrincipal).not.toHaveBeenCalled();
    expect(mocks.createProjectBoundSdpApiClient).not.toHaveBeenCalled();
  });

  it("requires a rendered project id before building any client", async () => {
    const result = await createPrincipalAction({ name: "Mia", projectId: "" });

    expect(result.ok).toBe(false);
    expect(mocks.getSelectedProjectId).not.toHaveBeenCalled();
    expect(mocks.createProjectBoundSdpApiClient).not.toHaveBeenCalled();
  });

  it("fails closed when the rendered project is no longer listed for the organization", async () => {
    mocks.getSelectedProjectId.mockResolvedValue(RENDERED_PROJECT);
    mocks.createProjectBoundSdpApiClient.mockRejectedValue(
      new Error("Requested project is not available for this organization")
    );

    const result = await createPrincipalAction({ name: "Mia", projectId: RENDERED_PROJECT });

    expect(result).toMatchObject({ ok: false });
    expect(mocks.createPrivateChannelPrincipal).not.toHaveBeenCalled();
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
      createPrincipalAction({ name: "Mia", projectId: RENDERED_PROJECT })
    ).resolves.toEqual({ ok: false, message: "Principal name is taken." });
  });
});
