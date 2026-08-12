import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));
vi.mock("@/i18n/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: mocks.createSdpApiClient,
}));

import { recheckPrivyCredentialAction, submitPrivyCredentialAction } from "./byok-actions";

const credential = {
  id: "pcred_test",
  provider: "privy",
  label: "Production app",
  scope: "project",
  status: "active",
  displayMetadata: { appIdSuffix: "1234" },
};

function completionResult(status: string, code?: string) {
  return {
    providerCredential: credential,
    connectionId: "conn_test",
    completion: {
      status,
      attemptedAt: "2026-08-12T00:00:00.000Z",
      ...(code ? { code } : {}),
    },
  };
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
  const client = { fetch: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSdpApiClient.mockResolvedValue(client);
  });

  it("returns success and revalidates when the completion passes", async () => {
    client.fetch.mockResolvedValue(completionResult("success"));

    await expect(recheckPrivyCredentialAction("conn_test")).resolves.toEqual({
      status: "success",
    });
    expect(client.fetch).toHaveBeenCalledWith(
      "/internal/dashboard/custody/connections/conn_test/complete",
      expect.objectContaining({ method: "POST" })
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard/custody");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard/wallets");
  });

  it("reports a failed completion as invalid credentials with the connection replaceable", async () => {
    client.fetch.mockResolvedValue(completionResult("failed", "invalid_credentials"));

    await expect(recheckPrivyCredentialAction("conn_test")).resolves.toEqual({
      status: "failed",
      message: "DashboardCustody.byokInvalidCredentials",
      connectionId: "conn_test",
    });
  });

  it("names the already-connected provider account when that is the failure", async () => {
    client.fetch.mockResolvedValue(
      completionResult("failed", "provider_account_already_connected")
    );

    await expect(recheckPrivyCredentialAction("conn_test")).resolves.toEqual({
      status: "failed",
      message: "DashboardCustody.byokAccountAlreadyConnected",
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
  const client = { fetch: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSdpApiClient.mockResolvedValue(client);
  });

  it("runs the connection completion after storing the credential", async () => {
    client.fetch
      .mockResolvedValueOnce({ providerCredential: credential, connectionId: "conn_test" })
      .mockResolvedValueOnce(completionResult("success"));

    await expect(submitPrivyCredentialAction(submitForm())).resolves.toEqual({
      status: "success",
    });
    expect(client.fetch).toHaveBeenCalledTimes(2);
    expect(client.fetch).toHaveBeenNthCalledWith(
      1,
      "/internal/dashboard/custody/provider-credentials",
      expect.objectContaining({ method: "POST" })
    );
    expect(client.fetch).toHaveBeenNthCalledWith(
      2,
      "/internal/dashboard/custody/connections/conn_test/complete",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("always submits project-scoped fields; organization scope no longer exists", async () => {
    client.fetch
      .mockResolvedValueOnce({ providerCredential: credential, connectionId: "conn_test" })
      .mockResolvedValueOnce(completionResult("success"));

    await submitPrivyCredentialAction(submitForm());

    const body = JSON.parse(String(client.fetch.mock.calls[0]?.[1]?.body)) as {
      fields: { scope: string };
    };
    expect(body.fields.scope).toBe("project");
  });

  it("replaces the credentials on a failed connection when the form carries its id", async () => {
    client.fetch
      .mockResolvedValueOnce({ providerCredential: credential, connectionId: "conn_test" })
      .mockResolvedValueOnce(completionResult("success"));
    const form = submitForm();
    form.set("connectionId", "conn_test");

    await expect(submitPrivyCredentialAction(form)).resolves.toEqual({ status: "success" });
    expect(client.fetch).toHaveBeenNthCalledWith(
      1,
      "/internal/dashboard/custody/connections/conn_test/provider-credentials",
      expect.objectContaining({ method: "POST" })
    );
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
      const result = await submitPrivyCredentialAction(submitForm());
      expect(result.status).toBe("error");
    }
  );

  it("keeps a response-less failure in the unknown, replayable state", async () => {
    client.fetch.mockRejectedValueOnce(new Error("fetch failed: socket hang up"));

    const result = await submitPrivyCredentialAction(submitForm());
    expect(result.status).toBe("error");
  });

  it("rejects whitespace-only fields as invalid without sending anything", async () => {
    // Whitespace passes the browser's `required` check; the action trims it
    // away and must not report the pre-request reject as a replayable outcome.
    const form = submitForm();
    form.set("credentialLabel", "   ");

    const result = await submitPrivyCredentialAction(form);
    expect(result.status).toBe("invalid");
    expect(client.fetch).not.toHaveBeenCalled();
  });
});
