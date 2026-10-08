import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_PROJECT } from "@/test/projects";
import { setPageRequest } from "@/test/request-project";

const mocks = vi.hoisted(() => ({
  createSdpApiClient: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "user_test", orgId: "org_test" })),
}));
vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));
vi.mock("next/headers", () => import("@/test/next-headers"));
vi.mock("@/i18n/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock("@/lib/sdp-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sdp-api")>()),
  createSdpApiClient: mocks.createSdpApiClient,
}));

import {
  createCustodySetupWalletAction,
  initializeCustodySetupAction,
  requestDevnetSolanaFaucetAction,
} from "./actions";

beforeEach(() => setPageRequest(`/dashboard/${PRODUCTION_PROJECT.id}/wallets/wallet_one`));

function walletForm(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }
  return formData;
}

function requestBody(client: { fetch: ReturnType<typeof vi.fn> }): Record<string, unknown> {
  return JSON.parse(String(client.fetch.mock.calls[0]?.[1]?.body));
}

describe("initializeCustodySetupAction", () => {
  const client = { fetch: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createSdpApiClient.mockResolvedValue(client);
  });

  it("reports an already set up provider and makes no other API call", async () => {
    client.fetch.mockRejectedValue(
      new Error('SDP API request failed (409): {"error":{"message":"Signing already initialized"}}')
    );

    const result = await initializeCustodySetupAction(
      walletForm({ provider: "privy", walletLabel: "Treasury" })
    );

    expect(result).toEqual({ status: "provider_already_set_up" });
    expect(client.fetch).toHaveBeenCalledExactlyOnceWith(
      "/v1/wallets/initialize",
      expect.anything()
    );
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("createCustodySetupWalletAction", () => {
  const client = { fetch: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    client.fetch.mockResolvedValue({});
    mocks.createSdpApiClient.mockResolvedValue(client);
  });

  it("creates the wallet in the chosen connection", async () => {
    const result = await createCustodySetupWalletAction(
      walletForm({ provider: "privy", label: "Treasury", connectionId: "conn_eu" })
    );

    expect(result).toEqual({ status: "success" });
    expect(client.fetch).toHaveBeenCalledWith("/v1/wallets", expect.anything());
    expect(requestBody(client)).toEqual({ connectionId: "conn_eu", label: "Treasury" });
  });

  // Sending both would leave the API to reconcile a connection against a
  // provider that may own several of them.
  it("drops the provider once a connection names the credential", async () => {
    await createCustodySetupWalletAction(
      walletForm({ provider: "privy", label: "Treasury", connectionId: "conn_eu" })
    );

    expect(requestBody(client)).not.toHaveProperty("provider");
  });

  it("names the provider's Managed config when no connection is chosen", async () => {
    await createCustodySetupWalletAction(walletForm({ provider: "privy", label: "Treasury" }));

    expect(requestBody(client)).toEqual({ provider: "privy", label: "Treasury" });
  });

  // An empty select submits "", which must not read as a connection.
  it("treats a blank connection as none", async () => {
    await createCustodySetupWalletAction(
      walletForm({ provider: "privy", label: "Treasury", connectionId: "  " })
    );

    expect(requestBody(client)).toEqual({ provider: "privy", label: "Treasury" });
  });

  it("refuses a wallet that names neither a provider nor a connection", async () => {
    const result = await createCustodySetupWalletAction(walletForm({ label: "Treasury" }));

    expect(result.status).toBe("error");
    expect(client.fetch).not.toHaveBeenCalled();
  });

  it("reports a failure instead of throwing", async () => {
    client.fetch.mockRejectedValue(new Error("SDP API request failed (409): {}"));

    const result = await createCustodySetupWalletAction(
      walletForm({ provider: "privy", label: "Treasury", connectionId: "conn_eu" })
    );

    expect(result.status).toBe("error");
  });
});

describe("requestDevnetSolanaFaucetAction", () => {
  const client = { fetch: vi.fn() };
  const WALLET_ADDRESS = "11111111111111111111111111111111";

  function relay(response: unknown) {
    return {
      provider: { id: "helius", endpoint: "https://rpc.example" },
      upstream: { ok: true, status: 200, statusText: "OK" },
      response,
    };
  }

  function statuses(confirmationStatus: string | null) {
    return relay({ result: { value: [confirmationStatus ? { confirmationStatus } : null] } });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    client.fetch.mockReset();
    vi.useFakeTimers();
    mocks.createSdpApiClient.mockResolvedValue(client);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the airdrop to confirm before revalidating the wallet pages", async () => {
    client.fetch
      .mockResolvedValueOnce(relay({ result: "sig_airdrop" }))
      .mockResolvedValueOnce(statuses("processed"))
      .mockResolvedValueOnce(statuses("confirmed"));

    const pending = requestDevnetSolanaFaucetAction("wallet_one", WALLET_ADDRESS);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(result).toMatchObject({ status: "success", signature: "sig_airdrop" });
    expect(client.fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(client.fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      method: "getSignatureStatuses",
      params: [["sig_airdrop"]],
    });
    expect(client.fetch.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    const lastStatusCheck = client.fetch.mock.invocationCallOrder[2] ?? 0;
    expect(mocks.revalidatePath.mock.calls).toEqual([
      [`/dashboard/${PRODUCTION_PROJECT.id}/custody`],
      [`/dashboard/${PRODUCTION_PROJECT.id}/wallets`],
      [`/dashboard/${PRODUCTION_PROJECT.id}/custody/wallet_one`],
      [`/dashboard/${PRODUCTION_PROJECT.id}/wallets/wallet_one`],
    ]);
    for (const order of mocks.revalidatePath.mock.invocationCallOrder) {
      expect(order).toBeGreaterThan(lastStatusCheck);
    }
  });

  it("reports an airdrop that failed on-chain instead of success", async () => {
    client.fetch
      .mockResolvedValueOnce(relay({ result: "sig_airdrop" }))
      .mockResolvedValueOnce(
        relay({ result: { value: [{ err: { InstructionError: [0, {}] } }] } })
      );

    const pending = requestDevnetSolanaFaucetAction("wallet_one", WALLET_ADDRESS);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(result).toEqual({
      status: "error",
      message: "DashboardCustody.devnetFaucetProviderGenericError",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("logs a failed status request and keeps waiting for confirmation", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    client.fetch
      .mockResolvedValueOnce(relay({ result: "sig_airdrop" }))
      .mockRejectedValueOnce(new Error("relay unavailable"))
      .mockResolvedValueOnce(statuses("confirmed"));

    const pending = requestDevnetSolanaFaucetAction("wallet_one", WALLET_ADDRESS);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result).toMatchObject({ status: "success", signature: "sig_airdrop" });
    expect(client.fetch).toHaveBeenCalledTimes(3);
    expect(mocks.revalidatePath).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("wallet_faucet_confirmation_check_failed")
    );
    warn.mockRestore();
  });

  it("does not log when the status request hits the confirmation deadline", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    client.fetch
      .mockResolvedValueOnce(relay({ result: "sig_airdrop" }))
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));

    const result = await requestDevnetSolanaFaucetAction("wallet_one", WALLET_ADDRESS);

    expect(result).toMatchObject({ status: "success", signature: "sig_airdrop" });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still succeeds and revalidates when confirmation does not arrive in time", async () => {
    client.fetch
      .mockResolvedValueOnce(relay({ result: "sig_airdrop" }))
      .mockResolvedValue(statuses(null));

    const pending = requestDevnetSolanaFaucetAction("wallet_one", WALLET_ADDRESS);
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;

    expect(result).toMatchObject({ status: "success", signature: "sig_airdrop" });
    expect(mocks.revalidatePath).toHaveBeenCalled();
  });
});
