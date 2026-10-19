import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "user_test", orgId: "org_test", sessionId: null })),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/i18n/server", () => ({
  getTranslations: vi.fn(
    async () => (key: string, values?: Record<string, string>) =>
      values?.error ? `${key}: ${values.error}` : key
  ),
  getRequestLocale: vi.fn(async () => "en"),
}));
vi.mock("@/lib/sdp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sdp-api")>()),
  createSdpApiClient: mocks.createSdpApiClient,
}));

import { saveApiKeyAuthoringAction } from "./actions";
import { createApiKeyAuthoringDraft } from "./api-key-authoring";

const client = { fetch: vi.fn() };

function lastBody(): Record<string, unknown> {
  const call = client.fetch.mock.calls.at(-1);
  return JSON.parse(String(call?.[1]?.body));
}

function draft(overrides: Partial<ReturnType<typeof createApiKeyAuthoringDraft>> = {}) {
  return {
    ...createApiKeyAuthoringDraft(),
    name: "Payouts worker",
    grants: ["transfers.execute" as const],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/api-keys/new`);
  mocks.createSdpApiClient.mockResolvedValue(client);
  client.fetch.mockResolvedValue({
    apiKey: { id: "key_1", name: "Payouts worker", key: "sk_test_x", keyPrefix: "sk_test_x" },
  });
});

describe("saveApiKeyAuthoringAction: create", () => {
  it("creates a key with its explicit grants", async () => {
    const result = await saveApiKeyAuthoringAction({ mode: "create", draft: draft() });

    expect(result.ok).toBe(true);
    expect(client.fetch).toHaveBeenCalledTimes(1);
    expect(client.fetch.mock.calls[0]?.[0]).toBe("/v1/api-keys");
    expect(lastBody()).toEqual({
      name: "Payouts worker",
      grants: ["transfers.execute"],
      walletScope: "all",
    });
  });

  it("creates a key with its IP allowlist, one entry per address", async () => {
    await saveApiKeyAuthoringAction({
      mode: "create",
      draft: draft({ allowedIps: "203.0.113.10\n198.51.100.0/24, 203.0.113.10\n" }),
    });

    expect(lastBody()).toMatchObject({ allowedIps: ["203.0.113.10", "198.51.100.0/24"] });
  });

  it("refuses a key with no grants before calling the API", async () => {
    const result = await saveApiKeyAuthoringAction({
      mode: "create",
      draft: draft({ grants: [] }),
    });

    expect(result).toEqual({ ok: false, message: "DashboardCustody.apiKeyGrantsRequired" });
    expect(client.fetch).not.toHaveBeenCalled();
  });

  it("creates selected-wallet keys with their wallet bindings", async () => {
    await saveApiKeyAuthoringAction({
      mode: "create",
      draft: draft({
        walletScope: "selected",
        selectedWalletIds: ["wallet_a", "wallet_b"],
        defaultWalletId: "wallet_b",
      }),
    });

    expect(lastBody()).toMatchObject({
      walletScope: "selected",
      signingWalletId: "wallet_b",
      signingWalletIds: ["wallet_a", "wallet_b"],
    });
  });
});

describe("saveApiKeyAuthoringAction: edit", () => {
  beforeEach(() => {
    client.fetch.mockResolvedValue({ success: true });
  });

  it("patches the key once, replacing its grants", async () => {
    const result = await saveApiKeyAuthoringAction({
      mode: "edit",
      keyId: "key_1",
      draft: draft({ grants: ["transfers.read", "wallets.read"] }),
      grantsTouched: true,
    });

    expect(result.ok).toBe(true);
    expect(client.fetch).toHaveBeenCalledTimes(1);
    expect(client.fetch.mock.calls[0]?.[0]).toBe("/v1/api-keys/key_1");
    expect(client.fetch.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(lastBody()).toMatchObject({ grants: ["transfers.read", "wallets.read"] });
  });

  it("clears the IP allowlist when the field is emptied", async () => {
    await saveApiKeyAuthoringAction({
      mode: "edit",
      keyId: "key_1",
      draft: draft({ allowedIps: "  " }),
    });

    expect(lastBody()).toMatchObject({ allowedIps: null });
  });

  it("sends no grants when the permissions step was not touched", async () => {
    await saveApiKeyAuthoringAction({
      mode: "edit",
      keyId: "key_1",
      draft: draft(),
      grantsTouched: false,
    });

    expect(lastBody()).not.toHaveProperty("grants");
  });

  it("resets an all-wallets key with walletScope alone, as the API requires", async () => {
    await saveApiKeyAuthoringAction({ mode: "edit", keyId: "key_1", draft: draft() });

    const body = lastBody();
    expect(body.walletScope).toBe("all");
    expect(body).not.toHaveProperty("signingWalletId");
    expect(body).not.toHaveProperty("signingWalletIds");
    expect(body).not.toHaveProperty("walletBindings");
  });

  it("moves a key to selected wallets with their ids", async () => {
    await saveApiKeyAuthoringAction({
      mode: "edit",
      keyId: "key_1",
      draft: draft({ walletScope: "selected", selectedWalletIds: ["wallet_a"] }),
    });

    expect(lastBody()).toMatchObject({
      walletScope: "selected",
      signingWalletId: "wallet_a",
      signingWalletIds: ["wallet_a"],
    });
  });

  it("reports an API failure without a flash or a revalidation", async () => {
    client.fetch.mockRejectedValue(new Error("SDP API request failed (400): boom"));

    const result = await saveApiKeyAuthoringAction({
      mode: "edit",
      keyId: "key_1",
      draft: draft(),
    });

    expect(result.ok).toBe(false);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses an edit without a key id", async () => {
    const result = await saveApiKeyAuthoringAction({ mode: "edit", draft: draft() });

    expect(result).toEqual({ ok: false, message: "DashboardCustody.apiKeyEditMissingId" });
    expect(client.fetch).not.toHaveBeenCalled();
  });
});
