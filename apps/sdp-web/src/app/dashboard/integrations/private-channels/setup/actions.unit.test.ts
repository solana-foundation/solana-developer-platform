import { SANDBOX_DEFAULTS } from "@sdp/private-channels";
import type { PrivateChannelInstance } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: async () => ({ fetch: fetchMock }),
  extractSdpApiErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : "Request failed.",
}));

import {
  connectPrivateChannelAction,
  deletePrivateChannelAction,
  disconnectPrivateChannelAction,
  testConnectionAction,
  updatePrivateChannelAction,
} from "./actions";

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

  it("sends a verified update to the active instance", async () => {
    fetchMock.mockResolvedValue({ instance: { ...existingInstance, isActive: true } });
    const { chainRpcUrl: _legacyChainRpcUrl, ...input } = SANDBOX_DEFAULTS;

    const result = await updatePrivateChannelAction({ ...input, instanceId: existingInstance.id });

    expect(result).toEqual({ ok: true, instance: { ...existingInstance, isActive: true } });
    expect(fetchMock).toHaveBeenCalledWith("/v1/private-channels/instance", {
      method: "PATCH",
      body: expect.stringContaining(`"instanceId":"${existingInstance.id}"`),
    });
  });

  it("validates probe input before making a request", async () => {
    const result = await testConnectionAction({
      gatewayUrl: "not-a-url",
      authUrl: "not-a-url",
      escrowProgramId: "",
      escrowInstanceAddr: "",
    });

    expect(result.kind).toBe("validation");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns both successful and failed probe requests without exposing diagnostics", async () => {
    const probe = {
      ok: true,
      gateway: {
        status: "ready" as const,
        latencyMs: 12,
        health: { status: 200, ok: true },
        ready: { status: 200, ok: true },
      },
      rpc: { ok: true as const, latencyMs: 8, version: "2.2.0" },
      auth: { ok: true as const, latencyMs: 4 },
    };
    fetchMock.mockResolvedValueOnce(probe).mockRejectedValueOnce(new Error("sensitive body"));

    await expect(testConnectionAction(SANDBOX_DEFAULTS)).resolves.toEqual({
      kind: "probe",
      probe,
    });
    await expect(testConnectionAction(SANDBOX_DEFAULTS)).resolves.toEqual({
      kind: "request-error",
    });
  });

  it("rejects invalid connection and update input before making a request", async () => {
    await expect(connectPrivateChannelAction({})).resolves.toMatchObject({
      ok: false,
      kind: "validation",
    });
    await expect(updatePrivateChannelAction({})).resolves.toMatchObject({
      ok: false,
      kind: "validation",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("connects with explicit reactivation confirmation and omits the legacy RPC field", async () => {
    const activeInstance = { ...existingInstance, isActive: true };
    fetchMock.mockResolvedValue({ instance: activeInstance });

    const result = await connectPrivateChannelAction({
      ...SANDBOX_DEFAULTS,
      confirmReactivate: true,
    });

    expect(result).toEqual({ ok: true, instance: activeInstance });
    const request = fetchMock.mock.calls[0][1] as { body: string };
    expect(request.body).toContain('"confirmReactivate":true');
    expect(request.body).not.toContain("chainRpcUrl");
  });

  it("requires an instance id for an otherwise valid update", async () => {
    const result = await updatePrivateChannelAction(SANDBOX_DEFAULTS);

    expect(result).toEqual({
      ok: false,
      kind: "server",
      message: "The active instance is unavailable. Refresh and try again.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the active-instance conflict returned by the API", async () => {
    fetchMock.mockRejectedValue(
      new Error(
        `SDP API request failed (409): ${JSON.stringify({
          error: {
            message: "Another connection is active.",
            details: { activeInstance: { ...existingInstance, isActive: true } },
          },
        })}`
      )
    );

    await expect(connectPrivateChannelAction(SANDBOX_DEFAULTS)).resolves.toMatchObject({
      ok: false,
      kind: "conflict-active",
      message: "Another connection is active.",
    });
  });

  it("turns structured probe failures into a concise product error", async () => {
    fetchMock.mockRejectedValue(
      new Error(
        `SDP API request failed (422): ${JSON.stringify({
          error: {
            message: "Probe failed.",
            details: {
              gateway: {
                status: "unreachable",
                latencyMs: 30,
                error: "offline",
              },
              rpc: { ok: false, latencyMs: 20, error: "offline" },
              auth: { ok: false, latencyMs: 10, error: "offline" },
            },
          },
        })}`
      )
    );

    await expect(connectPrivateChannelAction(SANDBOX_DEFAULTS)).resolves.toMatchObject({
      ok: false,
      kind: "probe",
      probe: { ok: false },
    });
  });

  it.each([
    { thrown: null, message: "Request failed." },
    { thrown: new Error("network down"), message: "Unable to reach the SDP API." },
    {
      thrown: new Error("SDP API request failed (500): not-json"),
      message: "Request failed.",
    },
    {
      thrown: new Error("SDP API request failed (500): {}"),
      message: "Request failed.",
    },
  ])("normalizes an unsafe API failure to '$message'", async ({ thrown, message }) => {
    fetchMock.mockRejectedValue(thrown);

    await expect(connectPrivateChannelAction(SANDBOX_DEFAULTS)).resolves.toEqual({
      ok: false,
      kind: "server",
      message,
    });
  });

  it("disconnects and deletes the active connection", async () => {
    fetchMock
      .mockResolvedValueOnce({ instance: existingInstance })
      .mockResolvedValueOnce({ deleted: true });

    await expect(disconnectPrivateChannelAction()).resolves.toEqual({
      ok: true,
      instance: existingInstance,
    });
    await expect(deletePrivateChannelAction()).resolves.toEqual({ ok: true });
  });

  it("returns safe failures for disconnect and delete requests", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("Disconnect failed"))
      .mockRejectedValueOnce(new Error("Delete failed"));

    await expect(disconnectPrivateChannelAction()).resolves.toEqual({
      ok: false,
      message: "Disconnect failed",
    });
    await expect(deletePrivateChannelAction()).resolves.toEqual({
      ok: false,
      message: "Delete failed",
    });
  });
});
