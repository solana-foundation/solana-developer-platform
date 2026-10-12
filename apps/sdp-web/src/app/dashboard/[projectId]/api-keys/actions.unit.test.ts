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
  return { ...createApiKeyAuthoringDraft(), name: "Payouts worker", ...overrides };
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
  it("creates an unrestricted key without an allowedOperations field", async () => {
    const result = await saveApiKeyAuthoringAction({ mode: "create", draft: draft() });

    expect(result.ok).toBe(true);
    expect(client.fetch).toHaveBeenCalledTimes(1);
    expect(client.fetch.mock.calls[0]?.[0]).toBe("/v1/api-keys");
    expect(lastBody()).toEqual({
      name: "Payouts worker",
      role: "api_developer",
      walletScope: "all",
    });
  });

  it("sends the ticked operations, sorted, in the same call that creates the key", async () => {
    const result = await saveApiKeyAuthoringAction({
      mode: "create",
      draft: draft({
        operationsScope: "selected",
        selectedOperations: ["ramp", "payment", "issuance_mint_execute"],
      }),
    });

    expect(result.ok).toBe(true);
    expect(client.fetch).toHaveBeenCalledTimes(1);
    expect(lastBody()).toMatchObject({
      allowedOperations: ["issuance_mint_execute", "payment", "ramp"],
    });
  });

  it("refuses a limited key with nothing ticked before calling the API", async () => {
    const result = await saveApiKeyAuthoringAction({
      mode: "create",
      draft: draft({ operationsScope: "selected", selectedOperations: [] }),
    });

    expect(result).toEqual({ ok: false, message: "DashboardCustody.apiKeyOperationsRequired" });
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

  it("patches the key once, replacing its allowed operations", async () => {
    const result = await saveApiKeyAuthoringAction({
      mode: "edit",
      keyId: "key_1",
      draft: draft({ operationsScope: "selected", selectedOperations: ["payment"] }),
    });

    expect(result.ok).toBe(true);
    expect(client.fetch).toHaveBeenCalledTimes(1);
    expect(client.fetch.mock.calls[0]?.[0]).toBe("/v1/api-keys/key_1");
    expect(client.fetch.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(lastBody()).toMatchObject({ allowedOperations: ["payment"] });
  });

  it("clears the restriction with null when the key is back on All operations", async () => {
    await saveApiKeyAuthoringAction({ mode: "edit", keyId: "key_1", draft: draft() });

    expect(lastBody()).toMatchObject({ allowedOperations: null });
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
