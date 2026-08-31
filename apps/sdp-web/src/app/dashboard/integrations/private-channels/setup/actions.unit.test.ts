import { SANDBOX_DEFAULTS } from "@sdp/private-channels";
import type { PrivateChannelInstance } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: async () => ({ fetch: fetchMock }),
}));

import { connectPrivateChannelAction } from "./actions";

const existingInstance: PrivateChannelInstance = {
  ...SANDBOX_DEFAULTS,
  // New rows persist the retired RPC field as an empty string.
  chainRpcUrl: "",
  id: "pci_existing",
  organizationId: "org_test",
  projectId: "project_test",
  isActive: false,
  createdBy: "user_test",
  createdAt: "2026-08-31T10:00:00.000Z",
  updatedAt: "2026-08-31T10:00:00.000Z",
};

describe("connectPrivateChannelAction", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it("returns the reactivation confirmation when the persisted instance has an empty legacy RPC URL", async () => {
    fetchMock.mockRejectedValue(
      new Error(
        `SDP API request failed (409): ${JSON.stringify({
          error: {
            message: "Confirm reactivation.",
            details: {
              requiresReactivateConfirmation: true,
              existingInstance,
            },
          },
        })}`
      )
    );
    const { chainRpcUrl: _legacyChainRpcUrl, ...input } = SANDBOX_DEFAULTS;

    const result = await connectPrivateChannelAction(input);

    expect(result).toEqual({
      ok: false,
      kind: "requires-reactivate-confirmation",
      message: "Confirm reactivation.",
      existingInstance,
    });
  });
});
