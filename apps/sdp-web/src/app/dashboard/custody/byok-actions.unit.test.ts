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
  scope: "organization",
  status: "active",
  displayMetadata: { appIdSuffix: "1234" },
};

function apiError(status: number, message: string): Error {
  return new Error(`SDP API request failed (${status}): ${JSON.stringify({ error: { message } })}`);
}

function submitForm(): FormData {
  const formData = new FormData();
  formData.set("idempotencyKey", "key_test");
  formData.set("credentialLabel", "Production app");
  formData.set("scope", "organization");
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

  it("returns success and revalidates when the check passes", async () => {
    client.fetch.mockResolvedValue({
      providerCredential: credential,
      check: { status: "success", checkedAt: "2026-08-06T00:00:00.000Z" },
    });

    await expect(recheckPrivyCredentialAction("pcred_test")).resolves.toEqual({
      status: "success",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard/custody");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard/wallets");
  });

  it("reports a failed check as invalid credentials", async () => {
    client.fetch.mockResolvedValue({
      providerCredential: credential,
      check: { status: "failed", checkedAt: "2026-08-06T00:00:00.000Z" },
    });

    await expect(recheckPrivyCredentialAction("pcred_test")).resolves.toEqual({
      status: "failed",
      message: "DashboardCustody.byokInvalidCredentials",
    });
  });

  it("keeps a retry_unknown check outcome re-checkable", async () => {
    client.fetch.mockResolvedValue({
      providerCredential: credential,
      check: { status: "retry_unknown", checkedAt: "2026-08-06T00:00:00.000Z" },
    });

    await expect(recheckPrivyCredentialAction("pcred_test")).resolves.toEqual({
      status: "retry_unknown",
      providerCredentialId: "pcred_test",
    });
  });

  it.each([
    [403, "Install checks are not enabled for this organization"],
    [409, "Privy wallet cannot be reconciled"],
  ])("treats a %i refusal as terminal but keeps the credential re-checkable", async (status, message) => {
    client.fetch.mockRejectedValue(apiError(status, message));

    await expect(recheckPrivyCredentialAction("pcred_test")).resolves.toEqual({
      status: "failed",
      message,
      providerCredentialId: "pcred_test",
    });
  });

  it("treats a 404 as terminal without an id because the credential is gone", async () => {
    client.fetch.mockRejectedValue(apiError(404, "Provider credential not found"));

    await expect(recheckPrivyCredentialAction("pcred_test")).resolves.toEqual({
      status: "failed",
      message: "Provider credential not found",
    });
  });

  it.each([
    [500],
    [408],
    [429],
  ])("keeps a %i response re-checkable because the outcome is unknown", async (status) => {
    client.fetch.mockRejectedValue(apiError(status, "try later"));

    await expect(recheckPrivyCredentialAction("pcred_test")).resolves.toEqual({
      status: "retry_unknown",
      providerCredentialId: "pcred_test",
    });
  });

  it("keeps a transport failure re-checkable", async () => {
    client.fetch.mockRejectedValue(new Error("fetch failed"));

    await expect(recheckPrivyCredentialAction("pcred_test")).resolves.toEqual({
      status: "retry_unknown",
      providerCredentialId: "pcred_test",
    });
  });
});

describe("submitPrivyCredentialAction outcome classification", () => {
  const client = { fetch: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSdpApiClient.mockResolvedValue(client);
  });

  it("runs the connection check after storing the credential", async () => {
    client.fetch.mockResolvedValueOnce({ providerCredential: credential }).mockResolvedValueOnce({
      providerCredential: credential,
      check: { status: "success", checkedAt: "2026-08-06T00:00:00.000Z" },
    });

    await expect(submitPrivyCredentialAction(submitForm())).resolves.toEqual({
      status: "success",
    });
    expect(client.fetch).toHaveBeenCalledTimes(2);
  });

  it("treats any answered HTTP error as terminal, never as replayable", async () => {
    client.fetch.mockRejectedValueOnce(apiError(409, "Privy custody setup already exists"));

    // A definitive conflict must not enter the frozen-replay loop.
    await expect(submitPrivyCredentialAction(submitForm())).resolves.toEqual({
      status: "failed",
      message: "Privy custody setup already exists",
    });
  });

  it("keeps a response-less failure in the unknown, replayable state", async () => {
    client.fetch.mockRejectedValueOnce(new Error("fetch failed: socket hang up"));

    const result = await submitPrivyCredentialAction(submitForm());
    expect(result.status).toBe("error");
  });
});
