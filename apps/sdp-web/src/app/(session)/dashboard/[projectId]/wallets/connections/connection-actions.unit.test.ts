import { beforeEach, describe, expect, it, vi } from "vitest";
import { SdpApiResponseError } from "@/lib/sdp-api";
import { translateServerMessagesToKeys } from "@/test/i18n-server";
import { revalidatePath } from "@/test/next-cache";
import { setPageRequest } from "@/test/request-project";
import { type StubSdpApiClient, stubSdpApiClient } from "@/test/sdp-api-client";

vi.mock("next/cache", () => import("@/test/next-cache"));
vi.mock("next/headers", () => import("@/test/next-headers"));

import {
  cancelSetupAction,
  createConnectionWalletAction,
  deactivateConnectionAction,
} from "./connection-actions";

let client: StubSdpApiClient;

beforeEach(() => {
  vi.clearAllMocks();
  setPageRequest("/dashboard/prj_test_sandbox/integrations/privy/connections/cconn_1");
  translateServerMessagesToKeys();
  client = stubSdpApiClient();
  client.fetch.mockResolvedValue({});
});

function apiError(status: number, code: string): SdpApiResponseError {
  return new SdpApiResponseError(status, JSON.stringify({ error: { code, message: code } }));
}

describe("deactivateConnectionAction", () => {
  it("ends the connection and re-reads every page that lists it", async () => {
    await expect(deactivateConnectionAction("cconn_1", "privy")).resolves.toEqual({
      status: "success",
    });

    expect(client.fetch.mock.calls).toEqual([
      [
        "/internal/dashboard/custody/connections/cconn_1/deactivate",
        { method: "POST", body: "{}" },
      ],
    ]);
    expect(revalidatePath.mock.calls).toEqual([
      ["/dashboard/prj_test_sandbox/integrations/privy"],
      ["/dashboard/prj_test_sandbox/integrations/privy/connections/cconn_1"],
      ["/dashboard/prj_test_sandbox/wallets"],
    ]);
  });

  // An answered refusal changed nothing; a lost or ambiguous answer may have committed, so the
  // page offers a re-read instead of reporting a failure.
  it.each([
    ["a refusal while wallets are active", apiError(409, "CONFLICT"), "failed"],
    ["a server error", apiError(503, "UPSTREAM_UNAVAILABLE"), "unknown"],
    ["a lost response", new TypeError("fetch failed"), "unknown"],
  ] as const)("reports %s as %s and re-reads nothing", async (_case, error, status) => {
    client.fetch.mockRejectedValue(error);

    const result = await deactivateConnectionAction("cconn_1", "privy");

    expect(result.status).toBe(status);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("tells the user to check the list when the key's first outcome is unknown", async () => {
    client.fetch.mockRejectedValue(apiError(409, "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN"));

    await expect(deactivateConnectionAction("cconn_1", "privy")).resolves.toEqual({
      status: "unknown",
      message: "Shared.idempotency.outcomeUnknownCheckList",
      answer: { status: 409, replayed: false, code: "IDEMPOTENCY_KEY_OUTCOME_UNKNOWN" },
    });
  });
});

describe("cancelSetupAction", () => {
  it("cancels the unfinished connection and re-reads the provider and wallet pages", async () => {
    await expect(cancelSetupAction("cconn_1", "privy")).resolves.toEqual({ status: "success" });

    expect(client.fetch.mock.calls).toEqual([
      ["/internal/dashboard/custody/connections/cconn_1/cancel", { method: "POST", body: "{}" }],
    ]);
    expect(revalidatePath.mock.calls).toEqual([
      ["/dashboard/prj_test_sandbox/integrations/privy"],
      ["/dashboard/prj_test_sandbox/wallets"],
    ]);
  });
});

describe("createConnectionWalletAction", () => {
  function walletForm(fields: Record<string, string>): FormData {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.set(name, value);
    return form;
  }

  // The browser mints the key per user action, so a retried press is the same request upstream.
  it("creates the wallet in this connection under the browser's Idempotency-Key", async () => {
    await expect(
      createConnectionWalletAction(
        walletForm({ connectionId: "cconn_1", label: " Treasury ", idempotencyKey: "browser-key" }),
        "privy"
      )
    ).resolves.toEqual({ status: "success" });

    expect(client.fetch.mock.calls).toEqual([
      [
        "/v1/wallets",
        {
          method: "POST",
          body: JSON.stringify({ connectionId: "cconn_1", label: "Treasury" }),
          headers: { "Idempotency-Key": "browser-key" },
        },
      ],
    ]);
  });

  it("refuses a form that names no connection without sending anything", async () => {
    await expect(
      createConnectionWalletAction(walletForm({ label: "Treasury" }), "privy")
    ).resolves.toEqual({
      status: "failed",
      kind: "invalid_credentials",
      message: "DashboardCustody.byokMissingFields",
    });
    expect(client.fetch).not.toHaveBeenCalled();
  });
});
