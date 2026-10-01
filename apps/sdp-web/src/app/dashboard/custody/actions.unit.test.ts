import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));
vi.mock("@/i18n/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock("@/lib/sdp-api", () => ({
  createSdpApiClient: mocks.createSdpApiClient,
}));

import { createCustodySetupWalletAction, requestDevnetSolanaFaucetAction } from "./actions";

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

  it("falls back to the provider when no connection is chosen", async () => {
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
      provider: { id: "helius", selectionMode: "default", endpoint: "https://rpc.example" },
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

  // requestAirdrop returns once the transaction is submitted; revalidating then
  // re-renders the page with the pre-airdrop balance.
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
