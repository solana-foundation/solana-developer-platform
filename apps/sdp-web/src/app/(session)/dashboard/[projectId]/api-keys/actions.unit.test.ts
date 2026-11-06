import { beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "@/test/next-cache";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { requestCookies, resetRequestProject, setPageRequest } from "@/test/request-project";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
  session: { sessionId: "sess_test_1", userId: "user_test_1" },
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: async () => mocks.session }));
vi.mock("next/cache", () => import("@/test/next-cache"));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/sdp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sdp-api")>()),
  createSdpApiClient: mocks.createSdpApiClient,
}));

import {
  type CreateApiKeyInput,
  createApiKeyAction,
  revokeApiKeyAction,
  rotateApiKeyAction,
  updateApiKeyAction,
} from "./actions";
import { API_KEY_FLASH_COOKIE, API_KEY_FLASH_MAX_AGE_SECONDS } from "./api-key-flash";
import { unsealApiKeyFlash } from "./api-key-flash-seal";
import { API_KEY_ROTATION_GRACE_HOURS } from "./api-key-presentation";

const client = { fetch: vi.fn<(path: string, init: RequestInit) => Promise<unknown>>() };

const ISSUED = { apiKey: { id: "key_test_2", key: "sf_test_issued_secret" } };

function sentRequest() {
  expect(client.fetch).toHaveBeenCalledTimes(1);
  const [path, init] = client.fetch.mock.calls[0];
  return { path, method: init.method, body: JSON.parse(String(init.body)) };
}

async function flashedAt(now: number) {
  const cookie = requestCookies.get(API_KEY_FLASH_COOKIE);
  if (cookie === undefined) {
    throw new Error("No API key flash cookie was set");
  }
  return unsealApiKeyFlash(cookie.value, mocks.session, now);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CLERK_SECRET_KEY", "sk_clerk_unit_test_secret");
  resetRequestProject();
  setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/api-keys/new`);
  mocks.createSdpApiClient.mockResolvedValue(client);
  client.fetch.mockResolvedValue(ISSUED);
});

describe("createApiKeyAction", () => {
  const input: Omit<CreateApiKeyInput, "wallets"> = {
    name: "  Payouts worker  ",
    grants: ["transfers.execute"],
    expiresAt: "2027-02-04T12:00:00.000Z",
  };

  it("creates an all-wallets key and flashes its secret for its own page", async () => {
    const result = await createApiKeyAction({ ...input, wallets: { walletScope: "all" } });

    expect(result).toEqual({ ok: true, keyId: "key_test_2" });
    expect(sentRequest()).toEqual({
      path: "/v1/api-keys",
      method: "POST",
      body: {
        name: "Payouts worker",
        grants: ["transfers.execute"],
        walletScope: "all",
        expiresAt: "2027-02-04T12:00:00.000Z",
      },
    });
    expect(await flashedAt(Date.now())).toEqual({
      keyId: "key_test_2",
      key: "sf_test_issued_secret",
    });
    expect(await flashedAt(Date.now() + (API_KEY_FLASH_MAX_AGE_SECONDS + 1) * 1000)).toBeNull();
  });

  it("sends a selected key's wallet ids, and no expiry for a key that never expires", async () => {
    await createApiKeyAction({
      ...input,
      wallets: { walletScope: "selected", walletIds: ["cwlt_test_1", "cwlt_test_2"] },
      expiresAt: null,
    });

    expect(sentRequest().body).toEqual({
      name: "Payouts worker",
      grants: ["transfers.execute"],
      walletScope: "selected",
      walletIds: ["cwlt_test_1", "cwlt_test_2"],
    });
  });

  it("reports an API failure and flashes nothing", async () => {
    client.fetch.mockRejectedValue(new Error("SDP API request failed (400): boom"));

    const result = await createApiKeyAction({ ...input, wallets: { walletScope: "all" } });

    expect(result).toEqual({
      ok: false,
      message: "API key could not be saved: SDP API request failed (400): boom",
    });
    expect(requestCookies.get(API_KEY_FLASH_COOKIE)).toBeUndefined();
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("API key validation", () => {
  const valid: CreateApiKeyInput = {
    name: "Payouts worker",
    grants: ["transfers.read"],
    wallets: { walletScope: "all" },
    expiresAt: null,
  };

  it.each([
    [
      "create",
      "a blank name",
      () => createApiKeyAction({ ...valid, name: "  " }),
      "API key name is required.",
    ],
    [
      "create",
      "no grants",
      () => createApiKeyAction({ ...valid, grants: [] }),
      "Grant at least one permission.",
    ],
    [
      "create",
      "selected wallets with none picked",
      () => createApiKeyAction({ ...valid, wallets: { walletScope: "selected", walletIds: [] } }),
      "Select at least one wallet for a wallet-scoped API key.",
    ],
    [
      "create",
      "an unreadable expiry",
      () => createApiKeyAction({ ...valid, expiresAt: "soon" }),
      "Invalid expiration date.",
    ],
    [
      "update",
      "a blank name",
      () => updateApiKeyAction("key_test_1", { name: "  " }),
      "API key name is required.",
    ],
    [
      "update",
      "no grants",
      () => updateApiKeyAction("key_test_1", { grants: [] }),
      "Grant at least one permission.",
    ],
    [
      "update",
      "selected wallets with none picked",
      () =>
        updateApiKeyAction("key_test_1", { wallets: { walletScope: "selected", walletIds: [] } }),
      "Select at least one wallet for a wallet-scoped API key.",
    ],
    [
      "update",
      "an unreadable expiry",
      () => updateApiKeyAction("key_test_1", { expiresAt: "soon" }),
      "Invalid expiration date.",
    ],
  ])(
    "refuses to %s a key with %s before calling the API",
    async (_action, _case, call, message) => {
      expect(await call()).toEqual({ ok: false, message });
      expect(client.fetch).not.toHaveBeenCalled();
    }
  );
});

describe("updateApiKeyAction", () => {
  beforeEach(() => {
    setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/api-keys/key_test_1`);
    client.fetch.mockResolvedValue({ success: true });
  });

  it("patches only the details it is given, clearing the note and the expiry", async () => {
    const result = await updateApiKeyAction("key_test_1", {
      name: "  Payouts worker  ",
      description: null,
      expiresAt: null,
      allowedIps: ["203.0.113.10"],
    });

    expect(result).toEqual({ ok: true });
    expect(sentRequest()).toEqual({
      path: "/v1/api-keys/key_test_1",
      method: "PATCH",
      body: {
        name: "Payouts worker",
        description: null,
        expiresAt: null,
        allowedIps: ["203.0.113.10"],
      },
    });
    expect(revalidatePath.mock.calls).toEqual([
      [`/dashboard/${PRODUCTION_PROJECT.id}/api-keys`, "page"],
      [`/dashboard/${PRODUCTION_PROJECT.id}/api-keys/key_test_1`, "page"],
    ]);
  });

  it("resets a key to every wallet with the wallet scope alone", async () => {
    await updateApiKeyAction("key_test_1", { wallets: { walletScope: "all" } });

    expect(sentRequest().body).toEqual({ walletScope: "all" });
  });

  it("replaces the grants without touching anything else", async () => {
    await updateApiKeyAction("key_test_1", { grants: ["transfers.read", "wallets.read"] });

    expect(sentRequest().body).toEqual({ grants: ["transfers.read", "wallets.read"] });
  });
});

describe("rotateApiKeyAction", () => {
  it.each(API_KEY_ROTATION_GRACE_HOURS)(
    "rotates with %i hours of grace and flashes the replacement's secret",
    async (gracePeriodHours) => {
      const result = await rotateApiKeyAction("key_test_1", gracePeriodHours);

      expect(result).toEqual({ ok: true, keyId: "key_test_2" });
      expect(sentRequest()).toEqual({
        path: "/v1/api-keys/key_test_1/rotate",
        method: "POST",
        body: { gracePeriodHours },
      });
      expect(await flashedAt(Date.now())).toEqual({
        keyId: "key_test_2",
        key: "sf_test_issued_secret",
      });
    }
  );

  it("refuses a grace period the panel does not offer before calling the API", async () => {
    const result = await rotateApiKeyAction("key_test_1", 2);

    expect(result).toEqual({ ok: false, message: "Rotate failed: grace period" });
    expect(client.fetch).not.toHaveBeenCalled();
    expect(requestCookies.get(API_KEY_FLASH_COOKIE)).toBeUndefined();
  });
});

describe("revokeApiKeyAction", () => {
  const revoke = { keyId: "key_test_1", keyName: "Payouts worker" };

  it("revokes with the key's name as confirmation, leaving recurring payments alone", async () => {
    client.fetch.mockResolvedValue({ recurringPayments: null });

    const result = await revokeApiKeyAction({ ...revoke, cancelRecurringPayments: false });

    expect(sentRequest()).toEqual({
      path: "/v1/api-keys/key_test_1",
      method: "DELETE",
      body: { confirmation: "Payouts worker", cancelRecurringPayments: false },
    });
    expect(result).toEqual({ ok: true, message: 'API key "Payouts worker" revoked.' });
  });

  it("cancels the recurring payments the key started and reports both counts", async () => {
    client.fetch.mockResolvedValue({
      recurringPayments: { canceled: ["prp_test_1", "prp_test_2"], failed: ["prp_test_3"] },
    });

    const result = await revokeApiKeyAction({ ...revoke, cancelRecurringPayments: true });

    expect(sentRequest().body).toEqual({
      confirmation: "Payouts worker",
      cancelRecurringPayments: true,
    });
    expect(result).toEqual({
      ok: true,
      message: 'API key "Payouts worker" revoked. Recurring payments canceled: 2. Not canceled: 1.',
    });
  });
});
