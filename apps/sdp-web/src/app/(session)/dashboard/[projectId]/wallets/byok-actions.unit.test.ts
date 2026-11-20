import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@/lib/idempotency";
import { translateServerMessagesToKeys } from "@/test/i18n-server";
import { revalidatePath } from "@/test/next-cache";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";
import { type StubSdpApiClient, sentSdpApiRequests, stubSdpApiClient } from "@/test/sdp-api-client";

vi.mock("next/cache", () => import("@/test/next-cache"));
vi.mock("next/headers", () => import("@/test/next-headers"));

import { recheckPrivyCredentialAction, submitPrivyCredentialAction } from "./byok-actions";

const credential = {
  id: "pcred_test",
  provider: "privy",
  label: "Production app",
  scope: "project",
  status: "active",
  displayMetadata: { appIdSuffix: "1234" },
};

let client: StubSdpApiClient;

beforeEach(() => {
  vi.clearAllMocks();
  setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/wallets/setup`);
  translateServerMessagesToKeys();
  client = stubSdpApiClient();
});

function completionResult(status: string, code?: string) {
  const attemptedAt = "2026-08-12T00:00:00.000Z";
  const completion: JsonValue =
    code === undefined ? { status, attemptedAt } : { status, attemptedAt, code };
  return { providerCredential: credential, connectionId: "conn_test", completion };
}

function apiError(status: number, message: string): Error {
  return new Error(`SDP API request failed (${status}): ${JSON.stringify({ error: { message } })}`);
}

function submitForm(): FormData {
  const formData = new FormData();
  formData.set("idempotencyKey", "key_test");
  formData.set("credentialLabel", "Production app");
  formData.set("appId", "app_test");
  formData.set("appSecret", "secret_test");
  return formData;
}

describe("recheckPrivyCredentialAction", () => {
  it("returns success and revalidates when the completion passes", async () => {
    client.fetch.mockResolvedValue(completionResult("success"));

    await expect(recheckPrivyCredentialAction("conn_test")).resolves.toEqual({
      status: "success",
      connectionId: "conn_test",
    });
    expect(sentSdpApiRequests(client)).toEqual([
      {
        path: "/internal/dashboard/custody/connections/conn_test/complete",
        method: "POST",
        headers: undefined,
        body: {},
      },
    ]);
    expect(revalidatePath.mock.calls).toEqual([
      [`/dashboard/${PRODUCTION_PROJECT.id}/wallets`],
      [`/dashboard/${PRODUCTION_PROJECT.id}/integrations/privy`],
    ]);
  });

  it.each([
    ["invalid_credentials", "DashboardCustody.byokInvalidCredentials"],
    ["provider_account_already_connected", "DashboardCustody.byokAccountAlreadyConnected"],
  ])("reports a %s completion failure with the connection replaceable", async (code, message) => {
    client.fetch.mockResolvedValue(completionResult("failed", code));

    await expect(recheckPrivyCredentialAction("conn_test")).resolves.toEqual({
      status: "failed",
      message,
      connectionId: "conn_test",
    });
  });

  it("reports a wallet conflict as unrecoverable without a replacement target", async () => {
    client.fetch.mockResolvedValue(completionResult("failed", "wallet_conflict"));

    // The pinned provider account makes the server reject replacement
    // credentials, so offering the replacement flow would 409 forever.
    await expect(recheckPrivyCredentialAction("conn_test")).resolves.toEqual({
      status: "unrecoverable",
      message: "DashboardCustody.byokWalletConflict",
    });
  });

  it.each([["retry_unknown"], ["running"]])("keeps a %s completion re-runnable", async (status) => {
    client.fetch.mockResolvedValue(completionResult(status));

    await expect(recheckPrivyCredentialAction("conn_test")).resolves.toEqual({
      status: "retry_unknown",
      connectionId: "conn_test",
    });
  });

  it.each([
    [403, "Provider credential installation is unavailable"],
    [409, "Custody Connection completion already in progress"],
  ])(
    "treats a %i refusal as terminal but keeps the connection re-checkable",
    async (status, message) => {
      client.fetch.mockRejectedValue(apiError(status, message));

      await expect(recheckPrivyCredentialAction("conn_test")).resolves.toEqual({
        status: "refused",
        message,
        connectionId: "conn_test",
      });
    }
  );

  it("treats a 404 as terminal without an id because the connection is gone", async () => {
    client.fetch.mockRejectedValue(apiError(404, "Custody Connection not found"));

    await expect(recheckPrivyCredentialAction("conn_test")).resolves.toEqual({
      status: "failed",
      message: "Custody Connection not found",
    });
  });

  it.each([[500], [408], [429]])(
    "keeps a %i response re-runnable because the outcome is unknown",
    async (status) => {
      client.fetch.mockRejectedValue(apiError(status, "try later"));

      await expect(recheckPrivyCredentialAction("conn_test")).resolves.toEqual({
        status: "retry_unknown",
        connectionId: "conn_test",
      });
    }
  );

  it("keeps a transport failure re-runnable", async () => {
    client.fetch.mockRejectedValue(new Error("fetch failed"));

    await expect(recheckPrivyCredentialAction("conn_test")).resolves.toEqual({
      status: "retry_unknown",
      connectionId: "conn_test",
    });
  });
});

describe("submitPrivyCredentialAction outcome classification", () => {
  it("submits Fireblocks credentials and refreshes the Fireblocks integration", async () => {
    const fireblocksCredential = { ...credential, provider: "fireblocks" };
    client.fetch
      .mockResolvedValueOnce({
        providerCredential: fireblocksCredential,
        connectionId: "conn_test",
      })
      .mockResolvedValueOnce({
        ...completionResult("success"),
        providerCredential: fireblocksCredential,
      });
    const data = new FormData();
    for (const [name, value] of Object.entries({
      provider: "fireblocks",
      credentialLabel: "Treasury",
      idempotencyKey: "fireblocks-key",
      apiKey: "api-user",
      signingKeyId: "fbcsr_11111111-1111-4111-8111-111111111111",
      vaultAccountId: "0",
    }))
      data.set(name, value);
    data.append("fireblocksVaultAccountIds", "0");
    data.append("fireblocksVaultAccountIds", "7");
    expect(await submitPrivyCredentialAction(data)).toEqual({
      status: "success",
      connectionId: "conn_test",
    });
    expect(sentSdpApiRequests(client)[0]).toEqual({
      path: "/internal/dashboard/custody/provider-credentials",
      method: "POST",
      headers: { "Idempotency-Key": "fireblocks-key" },
      body: {
        provider: "fireblocks",
        fireblocksVaultAccountIds: ["0", "7"],
        fields: {
          credentialLabel: "Treasury",
          scope: "project",
          apiKey: "api-user",
          signingKeyId: "fbcsr_11111111-1111-4111-8111-111111111111",
          vaultAccountId: "0",
        },
      },
    });
    expect(revalidatePath.mock.calls).toEqual([
      [`/dashboard/${PRODUCTION_PROJECT.id}/wallets`],
      [`/dashboard/${PRODUCTION_PROJECT.id}/integrations/fireblocks`],
    ]);
  });

  // The vault the connection signs from has to be one of the vaults it may use.
  it("refuses a Fireblocks vault outside the chosen vaults without sending anything", async () => {
    const data = new FormData();
    for (const [name, value] of Object.entries({
      provider: "fireblocks",
      credentialLabel: "Treasury",
      idempotencyKey: "fireblocks-key",
      apiKey: "api-user",
      signingKeyId: "fbcsr_11111111-1111-4111-8111-111111111111",
      vaultAccountId: "3",
    }))
      data.set(name, value);
    data.append("fireblocksVaultAccountIds", "0");
    data.append("fireblocksVaultAccountIds", "7");

    expect(await submitPrivyCredentialAction(data)).toEqual({
      status: "invalid",
      message: "DashboardCustody.byokMissingFields",
    });
    expect(client.fetch).not.toHaveBeenCalled();
  });

  // The browser's key rides on the stored credential, the one write a retry must not repeat;
  // the completion is lease-guarded and carries none.
  it("stores the credential under the browser's key, then runs the connection completion", async () => {
    client.fetch
      .mockResolvedValueOnce({ providerCredential: credential, connectionId: "conn_test" })
      .mockResolvedValueOnce(completionResult("success"));
    const form = submitForm();
    form.set("walletLabel", "Ops");

    await expect(submitPrivyCredentialAction(form)).resolves.toEqual({
      status: "success",
      connectionId: "conn_test",
    });
    expect(sentSdpApiRequests(client)).toEqual([
      {
        path: "/internal/dashboard/custody/provider-credentials",
        method: "POST",
        headers: { "Idempotency-Key": "key_test" },
        body: {
          provider: "privy",
          walletLabel: "Ops",
          fields: {
            credentialLabel: "Production app",
            scope: "project",
            appId: "app_test",
            appSecret: "secret_test",
          },
        },
      },
      {
        path: "/internal/dashboard/custody/connections/conn_test/complete",
        method: "POST",
        headers: undefined,
        body: {},
      },
    ]);
  });

  it("replaces the credentials on a failed connection when the form carries its id", async () => {
    client.fetch
      .mockResolvedValueOnce({ providerCredential: credential, connectionId: "conn_test" })
      .mockResolvedValueOnce(completionResult("success"));
    const form = submitForm();
    form.set("connectionId", "conn_test");

    await expect(submitPrivyCredentialAction(form)).resolves.toEqual({
      status: "success",
      connectionId: "conn_test",
    });
    expect(sentSdpApiRequests(client).map((request) => request.path)).toEqual([
      "/internal/dashboard/custody/connections/conn_test/provider-credentials",
      "/internal/dashboard/custody/connections/conn_test/complete",
    ]);
  });

  it("keeps the replacement target when a replacement submission is rejected", async () => {
    client.fetch.mockRejectedValueOnce(
      apiError(409, "Custody Connection cannot accept replacement credentials")
    );
    const form = submitForm();
    form.set("connectionId", "conn_test");

    // The failed connection survives the rejection and still blocks fresh
    // submissions, so the next correction must stay routed at it.
    await expect(submitPrivyCredentialAction(form)).resolves.toEqual({
      status: "failed",
      message: "Custody Connection cannot accept replacement credentials",
      connectionId: "conn_test",
    });
  });

  it("drops the replacement target when the connection is gone", async () => {
    client.fetch.mockRejectedValueOnce(apiError(404, "Custody Connection not found"));
    const form = submitForm();
    form.set("connectionId", "conn_test");

    // Routing corrections at a deleted connection would 404 forever; the
    // fresh submission path is the only one that can still converge.
    await expect(submitPrivyCredentialAction(form)).resolves.toEqual({
      status: "failed",
      message: "Custody Connection not found",
    });
  });

  it("treats an answered rejection as terminal, never as replayable", async () => {
    client.fetch.mockRejectedValueOnce(
      apiError(409, "A Privy custody installation is already in progress for this project")
    );

    // A definitive conflict must not enter the frozen-replay loop.
    await expect(submitPrivyCredentialAction(submitForm())).resolves.toEqual({
      status: "failed",
      message: "A Privy custody installation is already in progress for this project",
    });
  });

  it.each([[500], [502], [408], [429]])(
    "keeps a %i response replayable because it does not prove nothing committed",
    async (status) => {
      client.fetch.mockRejectedValueOnce(apiError(status, "try later"));

      // The submission may have committed server-side; the frozen replay
      // under the same idempotency key is the only path that converges.
      await expect(submitPrivyCredentialAction(submitForm())).resolves.toEqual({
        status: "error",
        message: "try later",
      });
    }
  );

  it("keeps a response-less failure in the unknown, replayable state", async () => {
    client.fetch.mockRejectedValueOnce(new Error("fetch failed: socket hang up"));

    await expect(submitPrivyCredentialAction(submitForm())).resolves.toEqual({
      status: "error",
      message: "fetch failed: socket hang up",
    });
  });

  it("rejects whitespace-only fields as invalid without sending anything", async () => {
    // Whitespace passes the browser's `required` check; the action trims it
    // away and must not report the pre-request reject as a replayable outcome.
    const form = submitForm();
    form.set("credentialLabel", "   ");

    await expect(submitPrivyCredentialAction(form)).resolves.toEqual({
      status: "invalid",
      message: "DashboardCustody.byokMissingFields",
    });
    expect(client.fetch).not.toHaveBeenCalled();
  });
});
